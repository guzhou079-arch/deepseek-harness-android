#!/usr/bin/env node
// Baseline is the published v1.37 asset identity, never the v1.38 candidate.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { project, sb, shaFile, writeJson, insist } from './release-receipts.mjs';
const REPO = 'guzhou079-arch/deepseek-harness-android';
const argv = process.argv.slice(2);
const arg = (key, fallback) => { const i = argv.indexOf('--' + key); return i < 0 ? fallback : argv[i + 1]; };
function credential() {
  try { const clone = arg('clone', `${process.env.DSH_VERIFY_DIR || '/data/user/0/com.deepseek.harness/files/_verify'}/ws-GitHub`); const cfg = fs.readFileSync(path.join(clone, '.git/config'), 'utf8'); return cfg.match(/https:\/\/[^:@\s]+:([^@\s]+)@github\.com\//)?.[1]; } catch { return null; }
}
async function baseline() {
  const tag = arg('tag', 'v1.37'); insist(tag === 'v1.37', 'This release requires published v1.37 baseline');
  const dir = path.resolve(arg('dir', path.join(sb, 'out'))), explicit = arg('apk');
  const token = credential();
  let release;
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-release-check', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(12000) });
    insist(response.ok, 'GitHub baseline API HTTP ' + response.status); release = await response.json();
  } catch (e) { console.error('Baseline unverifiable: fresh GitHub API required (' + e.message + '); cached metadata cannot pass.'); return 2; }
  insist(release.tag_name === tag && !release.draft && release.published_at, 'v1.37 is not a published release');
  const assets = (release.assets || []).filter(a => /\.apk$/i.test(a.name)); insist(assets.length > 0, 'Published release has no APK assets');
  const locals = explicit ? [path.resolve(explicit)] : fs.readdirSync(dir).filter(f => f.endsWith('.apk')).map(f => path.join(dir, f));
  const matched = [];
  for (const a of assets) {
    const sha256 = (a.digest || '').replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(sha256)) { console.error('Baseline digest unavailable: ' + a.name); return 2; }
    const candidates = locals.filter(f => fs.existsSync(f) && fs.statSync(f).size === a.size);
    const local = candidates.find(f => shaFile(f) === sha256);
    if (!local) { console.error('Baseline hash mismatch: ' + a.name); return 1; }
    matched.push({ name: a.name, id: a.id, size: a.size, sha256, local });
    console.log('✓ Published ' + tag + ' asset matched: ' + path.basename(local) + ' sha256=' + sha256);
  }
  const receipt = { schema: 1, kind: 'baseline', ok: true, tag, repo: REPO, source: 'github-api', checkedAt: new Date().toISOString(), releaseId: release.id, publishedAt: release.published_at, assets: matched };
  writeJson(arg('receipt', path.join(sb, 'out/baseline-v1.37.json')), receipt);
  return 0;
}
try {
  if (argv[0] === 'baseline') process.exitCode = await baseline();
  else if (argv[0] === 'sync-directions') {
    try { execFileSync(process.execPath, [path.join(sb, 'scripts/release-sync.mjs'), '--clone', arg('clone', `${process.env.DSH_VERIFY_DIR || '/data/user/0/com.deepseek.harness/files/_verify'}/ws-GitHub`), '--diff'], { stdio: 'inherit', env: { ...process.env, DSH_PROJECT: project } }); }
    catch (e) { process.exitCode = e.status || 2; }
  } else { console.error('Usage: release-checks.mjs baseline --tag v1.37 [--apk previous.apk] [--receipt receipt.json] | sync-directions --clone directory'); process.exitCode = 64; }
} catch (e) { console.error('✗ ' + e.message); process.exitCode = 2; }
