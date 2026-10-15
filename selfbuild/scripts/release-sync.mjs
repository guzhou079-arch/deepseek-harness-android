#!/usr/bin/env node
// Selective synchronization. Existing tracked files plus an explicit new-file
// manifest; no directory copying, staging, commits or pushes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { project, sb, shaFile, readJson, insist } from './release-receipts.mjs';
export function localFor(repo) {
  if (repo.startsWith('android-app/')) return 'v118/' + repo;
  if (repo.startsWith('plugins/whale-shota/')) return 'whale-shota/' + repo.slice('plugins/whale-shota/'.length);
  if (repo.startsWith('patches/bg-patch/')) return 'bg-patch/' + repo.slice(17);
  if (repo.startsWith('skills/')) return 'selfbuild/build-overlay/dshhome/' + repo;
  if (repo.startsWith('docs/') && !fs.existsSync(path.join(project, repo))) return repo.slice(5);
  return repo;
}
// 仓库独有文件（只存在于公开仓库、本地源码树里没有）不参与映射，否则同步会报 Missing mapped source。
const preserved = repo => /^(README(?:\.en)?\.md|licenses\/|docs\/assets\/|plugins\/whale-shota\/)/.test(repo) || repo.endsWith('check-repo-hygiene.sh') || repo === '.repo-hygiene-allow';
function safeRelative(p) { insist(typeof p === 'string' && p && !p.startsWith('/') && !p.split('/').some(s => !s || s === '..' || s === '.'), 'Invalid release-file path'); return p; }
function hygieneName(p) { insist(!/(^|\/)(work|out|build-overlay|memory|\.git)(\/|$)|\.(apk|keystore|p12|bak|pem|key)$|\.bak-|PATCH-NOTES/.test(p), 'Non-public release-file path: ' + p); }
export function syncPlan(clone) {
  const tracked = execFileSync('git', ['-C', clone, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const extra = readJson(path.join(sb, 'scripts/release-files.json'));
  insist(Array.isArray(extra) && extra.length > 0, 'Missing new-file manifest');
  const mappings = new Map(tracked.filter(p => !preserved(p)).map(repo => [safeRelative(repo), { repo, local: localFor(repo), tracked: true }]));
  for (const row of extra) { const repo = safeRelative(row.repo), local = safeRelative(row.local); hygieneName(repo); mappings.set(repo, { repo, local, tracked: tracked.includes(repo), explicit: true }); }
  const rows = [];
  for (const row of [...mappings.values()].sort((a, b) => a.repo.localeCompare(b.repo))) {
    if (/^docs\/(PATCH-NOTES-|BUILD-NOTES-|FIX-NOTES-|BUG-|RESULTS-|DSH-|提案-|构建环境重建-|装机后核对清单|CHANGELOG)|scripts\/memory\.js$|^源码与安全导览\.md$/.test(row.repo)) continue;
    const source = path.join(project, safeRelative(row.local)), dest = path.join(path.resolve(clone), row.repo);
    insist(fs.existsSync(source) && fs.statSync(source).isFile(), 'Missing mapped source: ' + row.local);
    let parent = path.dirname(dest); while (!fs.existsSync(parent)) parent = path.dirname(parent);
    insist(fs.realpathSync(parent).startsWith(fs.realpathSync(clone) + path.sep) || fs.realpathSync(parent) === fs.realpathSync(clone), 'Destination escapes clone');
    insist(!fs.existsSync(dest) || fs.lstatSync(dest).isFile(), 'Destination is not a regular file: ' + row.repo);
    rows.push({ ...row, source, dest, sha256: shaFile(source), equal: fs.existsSync(dest) && shaFile(source) === shaFile(dest) });
  }
  return rows;
}
export function checkSynced(clone) {
  const rows = syncPlan(clone); insist(rows.every(r => r.equal && (!r.explicit || r.tracked)), 'Source not committed in publishing clone (check sync and new-file manifest)'); return rows;
}
function main(argv) {
  const i = argv.indexOf('--clone'), clone = i >= 0 ? argv[i + 1] : `${process.env.DSH_VERIFY_DIR || '/data/user/0/com.deepseek.harness/files/_verify'}/ws-GitHub`;
  const rows = syncPlan(clone), changed = rows.filter(r => !r.equal), untracked = rows.filter(r => r.explicit && !r.tracked);
  for (const row of changed) {
    console.log(`${fs.existsSync(row.dest) ? '~' : '+'} ${row.repo} ← ${row.local}`);
    if (argv.includes('--diff') && fs.existsSync(row.dest)) { try { execFileSync('diff', ['-u', row.dest, row.source], { encoding: 'utf8', maxBuffer: 4 << 20 }); } catch (e) { if (e.status !== 1) throw new Error('diff failed'); console.log(String(e.stdout).split('\n').slice(0, 12).join('\n')); } }
  }
  if (argv.includes('--write')) {
    for (const row of changed) { fs.mkdirSync(path.dirname(row.dest), { recursive: true }); fs.copyFileSync(row.source, row.dest); insist(shaFile(row.dest) === row.sha256, 'Sync readback failed: ' + row.repo); }
    console.log(`Copied ${changed.length} selected files; nothing staged or pushed.`);
  } else console.log(`Selected ${rows.length}; different ${changed.length}; explicit files not tracked ${untracked.length}.`);
  if (untracked.length) console.log('Stage explicitly selected files and run hygiene --staged before committing.');
  if (!argv.includes('--write') && (changed.length || argv.includes('--require-tracked') && untracked.length)) process.exitCode = 1;
}
// 同 release-receipts.mjs：/sdcard 是软链接，path.resolve 比较会恒假 → 脚本静默不跑。
const isMain = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) { try { main(process.argv.slice(2)); } catch (e) { console.error('✗ ' + e.message); process.exitCode = 2; } }
