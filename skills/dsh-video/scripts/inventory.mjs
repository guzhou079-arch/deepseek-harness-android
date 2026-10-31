#!/usr/bin/env node
/**
 * dsh-video · 素材盘点：扫一个目录，探测图片/视频/音频，输出可改的 manifest 草稿。
 *
 *   node inventory.mjs <目录> [--out draft.json] [--width 1080] [--height 1920] [--fps 30]
 *                      [--per 2.5] [--no-audio]
 *
 * 只读操作；不渲染、不改素材。草稿里每个场景都带 duration，可按需改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const RUN = process.env.DSH_LINUX_RUN
  || '/data/user/0/com.deepseek.harness/files/work/linux/run.sh';
const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.avif']);
const VID = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.3gp', '.avi']);
const AUD = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);

const args = process.argv.slice(2);
const o = { dir: null, out: null, width: 1080, height: 1920, fps: 30, per: 2.5, audio: true };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') o.out = args[++i];
  else if (a === '--width') o.width = Number(args[++i]);
  else if (a === '--height') o.height = Number(args[++i]);
  else if (a === '--fps') o.fps = Number(args[++i]);
  else if (a === '--per') o.per = Number(args[++i]);
  else if (a === '--no-audio') o.audio = false;
  else if (a === '-h' || a === '--help') { console.log('用法: node inventory.mjs <目录> [--out draft.json]'); process.exit(0); }
  else o.dir = a;
}
if (!o.dir) { console.error('缺少目录参数'); process.exit(1); }
if (!fs.existsSync(o.dir)) { console.error('目录不存在：' + o.dir); process.exit(1); }
o.dir = path.resolve(o.dir);   // 绝对路径：manifest 里的 src 不能依赖 cwd

function probe(file) {
  const r = spawnSync(RUN, ['ffprobe', '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file],
    { cwd: '/sdcard', encoding: 'utf8', maxBuffer: 8 << 20 });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    const a = (j.streams || []).find((s) => s.codec_type === 'audio');
    return { duration: Number(j.format?.duration || 0), width: v?.width, height: v?.height, hasAudio: !!a };
  } catch { return null; }
}

const files = [];
(function walk(d, depth) {
  if (depth > 3) return;
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  ents.sort((x, y) => x.name.localeCompare(y.name, 'zh-Hans-CN', { numeric: true }));
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p, depth + 1); }
    else if (!e.name.startsWith('.')) files.push(p);
  }
})(o.dir, 0);

const images = [], videos = [], audios = [];
for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (IMG.has(ext)) images.push(f);
  else if (VID.has(ext)) videos.push(f);
  else if (AUD.has(ext)) audios.push(f);
}

const scenes = [];
let skipped = 0;
for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (IMG.has(ext)) {
    scenes.push({ src: f, type: 'image', duration: o.per, motion: 'in', text: '' });
  } else if (VID.has(ext)) {
    const info = probe(f);
    if (!info || !info.duration) { skipped++; continue; }
    scenes.push({
      src: f, type: 'video',
      duration: Math.min(4, Math.max(1, Math.round(info.duration * 10) / 10)),
      trim: 0, text: '',
    });
  }
}

const draft = {
  output: '/sdcard/DeepSeekHarness/videos/' + path.basename(path.resolve(o.dir)) + '.mp4',
  width: o.width,
  height: o.height,
  fps: o.fps,
  transition: { type: 'fade', duration: 0.5 },
  scenes,
};
if (o.audio) {
  const bgm = audios[0];
  draft.audio = bgm
    ? { bgm, volume: 0.4, duck: true }
    : { volume: 0.4 };
  if (!bgm) delete draft.audio;
}
draft.style = { fontSize: Math.round(o.height * 0.038), marginV: Math.round(o.height * 0.075) };
draft.srt = true;

const json = JSON.stringify(draft, null, 2);
if (o.out) { fs.writeFileSync(o.out, json + '\n'); }
else console.log(json);

console.error(`# ${images.length} 图片 / ${videos.length} 视频 / ${audios.length} 音频` +
  (skipped ? ` / ${skipped} 个视频探测失败已跳过` : '') +
  (o.out ? `\n# 草稿已写入 ${o.out}` : ''));
