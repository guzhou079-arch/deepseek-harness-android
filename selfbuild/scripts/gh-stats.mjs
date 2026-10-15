#!/usr/bin/env node
// Repository statistics live in source, not an ephemeral build work directory.
import fs from 'node:fs';
import path from 'node:path';
const clone = `${process.env.DSH_VERIFY_DIR || '/data/user/0/com.deepseek.harness/files/_verify'}/ws-GitHub`;
const repo = 'guzhou079-arch/deepseek-harness-android';
async function main() {
  const cfg = fs.readFileSync(path.join(clone, '.git/config'), 'utf8');
  const token = cfg.match(/https:\/\/[^:@\s]+:([^@\s]+)@github\.com\//)?.[1];
  async function api(suffix) {
    const r = await fetch(`https://api.github.com/repos/${repo}${suffix}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-stats', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('GitHub HTTP ' + r.status); return r.json();
  }
  const info = await api('');
  console.log(`${info.full_name}: stars=${info.stargazers_count}, forks=${info.forks_count}, watchers=${info.subscribers_count}, issues=${info.open_issues_count}`);
  const releases = await api('/releases?per_page=100'); let downloads = 0;
  for (const r of releases) for (const a of r.assets) { downloads += a.download_count; console.log(`${r.tag_name}: ${a.name} downloads=${a.download_count}`); }
  console.log('Asset downloads total=' + downloads);
  for (const kind of ['views', 'clones']) { try { const v = await api('/traffic/' + kind); console.log(`14d ${kind}: count=${v.count}, unique=${v.uniques}`); } catch (e) { console.log(kind + ': ' + e.message); } }
}
main().catch(e => { console.error('✗ ' + e.message); process.exitCode = 1; });
