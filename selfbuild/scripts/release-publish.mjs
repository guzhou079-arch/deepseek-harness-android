#!/usr/bin/env node
// All read-only gates run before --go permits any GitHub mutation.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { project, sb, VERSION, CODE, insist, checkArtifact, checkBaseline, checkEvidence, writeJson } from './release-receipts.mjs';
import { checkSynced } from './release-sync.mjs';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const REPO = 'guzhou079-arch/deepseek-harness-android', API = `https://api.github.com/repos/${REPO}`;

export async function publishVerifiedRelease({ request, artifact, tag, commit, title, body, name }) {
  let release = await request(`${API}/releases/tags/${tag}`, {}, true);
  if (!release) {
    // GitHub's tag lookup does not return drafts. Find an existing draft through
    // the list endpoint instead of creating another same-tag draft on retry.
    const releases = await request(`${API}/releases?per_page=100`);
    const drafts = releases.filter(r => r.tag_name === tag && r.draft);
    insist(drafts.length <= 1, 'Multiple draft releases exist for this tag; clean up duplicates explicitly');
    release = drafts[0] || null;
  }
  insist(!release || typeof release.draft === 'boolean', 'Release draft state unavailable');
  const existingAsset = (release?.assets || []).find(a => a.name === name);
  if (release && !release.draft) {
    insist(existingAsset && existingAsset.size === artifact.apkSize && existingAsset.digest === 'sha256:' + artifact.apkSha256,
      'Published release is incomplete; refusing to mutate it without a separate recovery decision');
  }
  const data = JSON.stringify({ tag_name: tag, target_commitish: commit, name: title, body, draft: release ? release.draft : true, prerelease: false });
  release = await request(release ? `${API}/releases/${release.id}` : `${API}/releases`, { method: release ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: data });
  let asset = (release.assets || []).find(a => a.name === name);
  if (asset) insist(asset.size === artifact.apkSize && asset.digest === 'sha256:' + artifact.apkSha256, 'Existing asset differs; replacement needs a separate explicit decision');
  else asset = await request(`https://uploads.github.com/repos/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Length': String(artifact.apkSize) }, body: fs.createReadStream(artifact.apk), duplex: 'half' });
  const fresh = await request(release.draft ? `${API}/releases/${release.id}` : `${API}/releases/tags/${tag}`), uploaded = fresh.assets.find(a => a.id === asset.id);
  insist(uploaded && uploaded.state === 'uploaded' && uploaded.size === artifact.apkSize && uploaded.digest === 'sha256:' + artifact.apkSha256, 'Uploaded asset SHA-256 verification failed');
  if (release.draft) {
    release = await request(`${API}/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false }) });
    insist(release.draft === false, 'Release did not leave draft state');
  }
  const finalRef = await request(`${API}/git/ref/tags/${tag}`); let finalObject = finalRef.object;
  if (finalObject.type === 'tag') finalObject = (await request(`${API}/git/tags/${finalObject.sha}`)).object;
  insist(finalObject.type === 'commit' && finalObject.sha === commit, 'Published tag does not match pushed source');
  writeJson(artifact.apk + '.published.json', { schema: 1, kind: 'published', ok: true, repo: REPO, tag, sourceCommit: commit, apkSha256: artifact.apkSha256, assetId: uploaded.id, verifiedAt: new Date().toISOString() });
  return uploaded;
}

async function main() {
  const artifactFile = arg('artifact', path.join(sb, 'out/release-v1.38-code70.json')), artifact = checkArtifact(artifactFile);
  const baseline = checkBaseline(arg('baseline', path.join(sb, 'out/baseline-v1.37.json')));
  checkEvidence(arg('privacy', artifact.apk + '.privacy.json'), 'privacy', artifact.apkSha256);
  checkEvidence(arg('isolated', artifact.apk + '.isolated.json'), 'isolated', artifact.apkSha256);
  const clone = arg('clone', `${process.env.DSH_VERIFY_DIR || '/data/user/0/com.deepseek.harness/files/_verify'}/ws-GitHub`);
  checkSynced(clone);
  const git = (...a) => { try { return execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { throw new Error('Source Git check failed'); } };
  insist(git('status', '--porcelain').length === 0, 'Publishing clone has uncommitted/untracked files');
  insist(git('branch', '--show-current') === 'main', 'Publishing clone must be on main');
  const commit = git('rev-parse', 'HEAD'); insist(/^[a-f0-9]{40}$/.test(commit), 'Invalid source commit');
  const cfg = fs.readFileSync(path.join(clone, '.git/config'), 'utf8');
  const token = cfg.match(/https:\/\/[^:@\s]+:([^@\s]+)@github\.com\/guzhou079-arch\/deepseek-harness-android(?:\.git)?/)?.[1];
  insist(token, 'GitHub credential unavailable in publishing clone');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-release' };
  async function request(url, init = {}, allow404 = false) {
    const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(init.method === 'POST' && url.includes('uploads.github.com') ? 600000 : 15000) });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      // 带上远端原文：光看状态码猜不出 400 是"哪里不合规矩"
      let detail = ''; try { detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300); } catch { /* 读不到就算了 */ }
      insist(false, `GitHub ${init.method || 'GET'} ${url.split('?')[0]} → HTTP ${response.status}${detail ? ' · ' + detail : ''}`);
    }
    return response.json();
  }
  const remote = await request(`${API}/git/ref/heads/main`); insist(remote.object?.sha === commit, 'Source HEAD has not reached remote main; push source before tag');
  const currentBaseline = await request(`${API}/releases/tags/v1.37`);
  insist(currentBaseline.id === baseline.releaseId && currentBaseline.published_at && !currentBaseline.draft, 'Published v1.37 baseline changed');
  for (const a of baseline.assets) insist(currentBaseline.assets.some(x => x.id === a.id && x.digest === 'sha256:' + a.sha256), 'Published baseline asset changed');
  const tag = 'v' + VERSION;
  const tagRef = await request(`${API}/git/ref/tags/${tag}`, {}, true);
  let tagged = tagRef?.object;
  for (let i = 0; tagged?.type === 'tag' && i < 5; i++) tagged = (await request(`${API}/git/tags/${tagged.sha}`)).object;
  insist(!tagRef || tagged?.type === 'commit' && tagged.sha === commit, 'Existing release tag points to another commit');
  const hygiene = path.join(clone, 'selfbuild/scripts/check-repo-hygiene.sh');
  insist(fs.existsSync(hygiene), 'Repository hygiene checker missing');
  try { execFileSync('/system/bin/sh', [hygiene], { cwd: clone, stdio: 'inherit' }); } catch { throw new Error('Repository hygiene failed'); }
  const bodyFile = arg('body-file', path.join(sb, `notes/release-body-v${VERSION}.md`));
  let body = fs.readFileSync(bodyFile, 'utf8').trim(); insist(body.length > 0, 'Empty release body');
  body = body.replace(/\n?---\n> 安装包 SHA-256：[^\n]*\n?$/u, '').trim() + `\n\n---\n> 安装包 SHA-256：\`${artifact.apkSha256}\`\n`;
  const name = `DeepSeekHarness-v${VERSION}-dist.apk`, title = arg('title', tag);
  console.log(`All gates passed: ${tag}/code${CODE}, source=${commit}, apk=${artifact.apkSha256}, asset=${name}`);
  if (!argv.includes('--go')) { console.log('Review complete; publishing requires explicit --go.'); process.exitCode = 1; return; }
  // Re-read immutable artifacts immediately before the first remote write.
  checkArtifact(artifactFile);
  const uploaded = await publishVerifiedRelease({ request, artifact, tag, commit, title, body, name });
  console.log('Published and verified:', uploaded.browser_download_url);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error('✗ ' + e.message); process.exitCode = 1; });
}
