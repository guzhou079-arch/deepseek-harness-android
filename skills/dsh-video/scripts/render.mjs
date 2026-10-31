#!/usr/bin/env node
/**
 * dsh-video · 素材 → 成片 渲染器
 *
 *   node render.mjs <manifest.json>               渲染整片
 *   node render.mjs <manifest.json> --still 2.5   渲染后抽一帧 PNG（验画面用）
 *   node render.mjs <manifest.json> --dry-run     只打印 ffmpeg 命令
 *
 * 依赖：proot Alpine 里的 ffmpeg 6.1（libass / x264 / fontconfig 齐全）。
 * 通过 work/linux/run.sh 调用；宿主路径 /sdcard 与 App files 在 proot 内已 bind。
 *
 * 设计取舍：
 * - 每个场景先归一化成同尺寸/同帧率/同 pix_fmt 的中间片，再 xfade 串联：
 *   出错容易定位；改字幕/换 BGM 时中间片按参数 hash 复用。
 * - 字幕走 ASS + libass（不用 drawtext）：中文字体、换行、描边更稳。
 * - 音频统一 44.1k 立体声；有旁白时 BGM 走 sidechaincompress 自动避让。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RUN = process.env.DSH_LINUX_RUN
  || '/data/user/0/com.deepseek.harness/files/work/linux/run.sh';
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.avif']);

const OPT = { manifest: null, still: null, dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--still') OPT.still = Number(argv[++i]);
  else if (a === '--dry-run') OPT.dryRun = true;
  else if (a === '-h' || a === '--help') { console.log(usage()); process.exit(0); }
  else if (a.startsWith('-')) die(`未知参数 ${a}`);
  else if (OPT.manifest) die(`只能给一个 manifest（多余参数 ${a}）`);
  else OPT.manifest = a;
}

function usage() {
  return `用法: node render.mjs <manifest.json> [--still 秒] [--dry-run]

最小 manifest：
{
  "output": "/sdcard/DeepSeekHarness/videos/demo.mp4",
  "width": 720, "height": 1280, "fps": 30,
  "scenes": [
    { "src": "/sdcard/图片/a.jpg", "duration": 2.4, "motion": "in", "text": "第一句字幕" },
    { "src": "/sdcard/素材/b.mp4", "duration": 3, "trim": 1.2 },
    { "src": "/sdcard/图片/c.jpg", "duration": 2, "motion": "left", "text": "结束" }
  ],
  "transition": { "type": "fade", "duration": 0.5 },
  "audio": { "bgm": "/sdcard/音乐/bgm.mp3", "volume": 0.45, "duck": true },
  "style": { "fontSize": 46, "marginV": 96 }
}

motion: in | out | left | right | none（图片默认 in；视频默认 none）
transition.type: fade / wipeleft / slideup / dissolve / smoothleft / none（ffmpeg xfade 全部类型）
audio: bgm / voice / volume / voiceVolume / voiceDelay / duck
`;
}

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
const log = (s) => console.log(s);
const secs = (t0) => ((Date.now() - t0) / 1000).toFixed(1) + 's';

function ff(args, label) {
  const cmd = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  if (OPT.dryRun) { log(`[dry] ffmpeg ${cmd}`); return ''; }
  const r = spawnSync(RUN, ['ffmpeg', ...args], { cwd: '/sdcard', encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) die(`${label}: 启动 run.sh 失败：${r.error.message}`);
  if (r.status !== 0) {
    const tail = (r.stderr || '').trim().split('\n').slice(-14).join('\n');
    die(`${label}: ffmpeg 失败（退出码 ${r.status}）\n${tail}`);
  }
  return r.stdout || '';
}

function probe(file) {
  const r = spawnSync(RUN, ['ffprobe', '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file],
    { cwd: '/sdcard', encoding: 'utf8', maxBuffer: 8 << 20 });
  if (r.status !== 0) die(`ffprobe 失败：${file}\n${(r.stderr || '').trim()}`);
  let j;
  try { j = JSON.parse(r.stdout); } catch { die(`ffprobe 输出不是 JSON：${file}`); }
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  return {
    duration: Number(j.format?.duration || v?.duration || 0),
    width: v?.width, height: v?.height, hasVideo: !!v, hasAudio: !!a,
    videoCodec: v?.codec_name, audioCodec: a?.codec_name,
  };
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ---------------- ASS 字幕 ---------------- */

function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function assColor(hex, alpha = '00') {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#ffffff'));
  if (!m) return '&H00FFFFFF';
  const n = m[1];
  return `&H${alpha}${n.slice(4, 6)}${n.slice(2, 4)}${n.slice(0, 2)}`.toUpperCase();
}

function escAss(s) {
  return String(s)
    .replace(/\\/g, '＼')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\r?\n/g, '\\N');
}

function writeAss(W, H, style, cues, file) {
  const font = style.font || 'Noto Sans CJK SC';
  const size = Math.round(num(style.fontSize, Math.max(28, Math.round(H * 0.040))));
  const marginV = Math.round(num(style.marginV, Math.round(H * 0.075)));
  const marginH = Math.round(num(style.marginH, Math.round(W * 0.07)));
  const outline = num(style.outline, Math.max(2, Math.round(size * 0.07)));
  const shadow = num(style.shadow, Math.max(1, Math.round(size * 0.04)));
  const borderStyle = style.box ? 3 : 1;
  const back = assColor(style.boxColor || '#000000', 'A0');
  const bold = style.bold ? 1 : 0;
  const fad = Math.round(num(style.textFadeMs, 180));
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${font},${size},${assColor(style.color || '#ffffff')},${assColor(style.color || '#ffffff')},${assColor(style.outlineColor || '#000000')},${back},${bold},0,0,0,100,100,0,0,${borderStyle},${outline},${shadow},2,${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of cues) {
    if (!(c.end > c.start)) continue;
    lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,{\\fad(${fad},${fad})}${escAss(c.text)}`);
  }
  if (OPT.dryRun) log(`[dry] 字幕计划 ${file}`);
  else fs.writeFileSync(file, lines.join('\n') + '\n');
}

/* ---------------- 场景归一化 ---------------- */

function planScene(scene, i, ctx) {
  const { W, H, fps } = ctx;
  const src = scene.src;
  const ext = path.extname(src).toLowerCase();
  const isImg = scene.type ? scene.type === 'image' : IMG_EXT.has(ext);
  const sourceDur = isImg ? 0 : (ctx.sourceDur(src) || 0);
  const trim = Math.max(0, num(scene.trim, 0));

  let D = num(scene.duration, 0);
  if (!(D > 0)) D = isImg ? 2.5 : Math.min(4, Math.max(1, (sourceDur || 4) - trim));
  if (!isImg && sourceDur > 0) {
    const remain = Math.max(0.2, sourceDur - trim);
    if (D > remain) {
      log(`  ! 场景 ${i + 1} 请求 ${D.toFixed(2)}s，素材只剩 ${remain.toFixed(2)}s，已截短`);
      D = remain;
    }
  }
  const N = Math.max(2, Math.round(D * fps));
  D = N / fps;                                  // 整帧对齐，音画时间轴才稳

  const out = path.join(ctx.workDir, `s${String(i).padStart(2, '0')}.mp4`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const motion = scene.motion || (isImg ? 'in' : 'none');
  const ratio = Math.min(1.5, Math.max(0.01, num(scene.zoom, 0.08)));
  const W2 = W * 2, H2 = H * 2;

  if (isImg) {
    // 手机照片可能带 EXIF 方向，ffmpeg 不一定吃到 → 给个确定的 rotate 逃生口
    const rot = ((Math.round(num(scene.rotate, 0)) % 360) + 360) % 360;
    const pre = rot === 90 ? 'transpose=1,' : rot === 180 ? 'hflip,vflip,' : rot === 270 ? 'transpose=2,' : '';
    const base = `${pre}scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},setsar=1`;
    if (motion === 'in' || motion === 'out') {
      // 单帧静图 + zoompan：d=N 一次展开成 N 帧，on 做线性推进（-loop 会变成 N 份 N 帧）
      const zMax = (1 + ratio).toFixed(4);
      const zExpr = motion === 'in'
        ? `min(1+${ratio}*on/${N - 1},${zMax})`
        : `max(${zMax}-${ratio}*on/${N - 1},1)`;
      const vf = `${base},zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${N}:s=${W}x${H}:fps=${fps},format=yuv420p`;
      args.push('-framerate', String(fps), '-i', src, '-vf', vf,
        '-frames:v', String(N), '-r', String(fps), '-t', D.toFixed(3));
    } else {
      let vf;
      if (motion === 'left' || motion === 'right') {
        const xExpr = motion === 'left'
          ? `(iw-${W})*t/${D.toFixed(3)}`
          : `(iw-${W})*(1-t/${D.toFixed(3)})`;
        vf = `${base},crop=${W}:${H}:x='${xExpr}':y=0,format=yuv420p`;
      } else {
        vf = `${base},scale=${W}:${H},format=yuv420p`;
      }
      args.push('-loop', '1', '-framerate', String(fps), '-t', D.toFixed(3), '-i', src,
        '-vf', vf, '-frames:v', String(N), '-r', String(fps), '-t', D.toFixed(3));
    }
  } else {
    const vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},format=yuv420p`;
    args.push('-ss', trim.toFixed(3), '-t', D.toFixed(3), '-i', src,
      '-vf', vf, '-an', '-frames:v', String(N), '-r', String(fps), '-t', D.toFixed(3));
  }

  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000', out);
  return { out, args, duration: D, frames: N, isImg };
}

/* ---------------- 合成 ---------------- */

function buildCues(scenes, durations, transition, total) {
  const T = transition.type === 'none' ? 0 : transition.duration;
  const starts = [0];
  for (let i = 1; i < durations.length; i++) starts.push(starts[i - 1] + durations[i - 1] - T);
  const cues = [];
  for (let i = 0; i < scenes.length; i++) {
    const txt = scenes[i].text;
    if (!txt) continue;
    const lead = num(scenes[i].textLead, 0.3);
    const nextStart = starts[i + 1] !== undefined ? starts[i + 1] + T * 0.5 : Infinity;
    const end = Math.min(starts[i] + durations[i] - 0.25, nextStart);
    cues.push({ start: starts[i] + lead, end, text: txt });
  }
  return cues;
}

function compose(files, durations, ctx, cues, audio, total) {
  const { W, H, fps, transition, out } = ctx;
  const n = files.length;
  const T = transition.type === 'none' ? 0 : transition.duration;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const f of files) args.push('-i', f);

  let cursor = n;
  for (const a of audio) {
    a.index = cursor++;
    args.push(...a.input);
  }

  const parts = [];
  for (let i = 0; i < n; i++) parts.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps}[v${i}]`);

  let vlabel;
  if (n === 1) {
    vlabel = '[v0]';
  } else if (T <= 0) {
    parts.push(`${files.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[vc]`);
    vlabel = '[vc]';
  } else {
    let prev = '[v0]';
    let acc = durations[0];
    for (let i = 1; i < n; i++) {
      const label = i === n - 1 ? '[vc]' : `[x${i}]`;
      parts.push(`${prev}[v${i}]xfade=transition=${transition.type}:duration=${T.toFixed(3)}:offset=${(acc - T).toFixed(3)}${label}`);
      prev = label;
      acc = acc + durations[i] - T;
    }
    vlabel = '[vc]';
  }

  if (cues.length) {
    const assPath = path.join(ctx.workDir, 'subs.ass');
    writeAss(W, H, ctx.style, cues, assPath);
    parts.push(`${vlabel}ass=filename=${assPath}[vt]`);
    vlabel = '[vt]';
  }

  const fadeIn = num(ctx.style.fadeIn, 0.3);
  const fadeOut = num(ctx.style.fadeOut, 0.5);
  if (fadeIn > 0 || fadeOut > 0) {
    const f = [];
    if (fadeIn > 0) f.push(`fade=t=in:st=0:d=${fadeIn.toFixed(2)}`);
    if (fadeOut > 0) f.push(`fade=t=out:st=${Math.max(0, total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(2)}`);
    parts.push(`${vlabel}${f.join(',')}[vf]`);
    vlabel = '[vf]';
  }

  let alabel = '[aout]';
  if (audio.length) {
    const bg = audio.find((a) => a.kind === 'bgm');
    const vo = audio.find((a) => a.kind === 'voice');
    if (bg) {
      const fo = Math.max(0.3, Math.min(1.2, total * 0.1));
      parts.push(`[${bg.index}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${bg.volume},` +
        `afade=t=in:st=0:d=0.4,afade=t=out:st=${Math.max(0, total - fo).toFixed(3)}:d=${fo.toFixed(2)}[bg]`);
    }
    if (vo) {
      const delay = Math.max(0, num(vo.delay, 0));
      // 旁白要同时喂 sidechain 和 amix，输出 pad 不能复用 → asplit 两路
      const split = bg && vo.duck !== false ? 'asplit=2[vo][voSide]' : 'anull[vo]';
      parts.push(`[${vo.index}:a]asetpts=PTS-STARTPTS,aresample=44100,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${vo.volume},` +
        (delay > 0 ? `adelay=${Math.round(delay * 1000)}|${Math.round(delay * 1000)},` : '') +
        `apad,atrim=0:${total.toFixed(3)},${split}`);
    }
    if (bg && vo) {
      if (vo.duck !== false) {
        parts.push('[bg][voSide]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[bgd]');
        parts.push('[bgd][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]');
      } else {
        parts.push('[bg][vo]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]');
      }
    } else {
      parts.push(`[${bg ? 'bg' : 'vo'}]anull[aout]`);
    }
  } else {
    args.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
    parts.push(`[${cursor}:a]atrim=0:${total.toFixed(3)}[aout]`);
  }

  if (OPT.dryRun) {
    args.push('-filter_complex', parts.join(';'));
  } else {
    const filterFile = path.join(ctx.workDir, 'graph.txt');
    fs.writeFileSync(filterFile, parts.join(';\n') + '\n');
    args.push('-filter_complex_script', filterFile);
  }
  args.push('-map', vlabel, '-map', alabel);
  args.push('-c:v', 'libx264', '-preset', ctx.preset, '-crf', String(ctx.crf),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart', '-t', total.toFixed(3), out);
  return ff(args, '合成');
}

/* ---------------- 主流程 ---------------- */

if (!OPT.manifest) { console.log(usage()); process.exit(1); }
if (!fs.existsSync(OPT.manifest)) die(`找不到 manifest：${OPT.manifest}`);

let m;
try { m = JSON.parse(fs.readFileSync(OPT.manifest, 'utf8')); }
catch (e) { die(`manifest 不是合法 JSON：${e.message}`); }

if (typeof m.output !== 'string' || !path.isAbsolute(m.output)) die('output 必须是成片绝对路径');
if (path.extname(m.output).toLowerCase() !== '.mp4') die('output 后缀必须是 .mp4');
const W = num(m.width, 1080);
const H = num(m.height, 1920);
const fps = num(m.fps, 30);
if (!(W > 0 && H > 0 && Number.isInteger(W) && Number.isInteger(H)) || W % 2 || H % 2) {
  die(`宽高必须是正偶数（x264 要求），现在是 ${W}×${H}`);
}
if (!(fps > 0)) die('fps 必须大于 0');
if (m.workDir !== undefined && (typeof m.workDir !== 'string' || !path.isAbsolute(m.workDir))) die('workDir 必须是绝对路径');
if (!Array.isArray(m.scenes) || !m.scenes.length) die('manifest 的 scenes 是空的');
for (const [i, s] of m.scenes.entries()) {
  if (!s || typeof s.src !== 'string' || !path.isAbsolute(s.src)) die(`scenes[${i}].src 必须是绝对路径`);
  if (!fs.existsSync(s.src) || !fs.statSync(s.src).isFile()) die(`scenes[${i}] 文件不存在或不是普通文件：${s.src}`);
  if (path.resolve(s.src) === path.resolve(m.output)) die(`output 不能覆盖 scenes[${i}] 的源素材`);
}
for (const kind of ['bgm', 'voice']) {
  const src = m.audio?.[kind];
  if (src === undefined) continue;
  if (typeof src !== 'string' || !path.isAbsolute(src)) die(`audio.${kind} 必须是绝对路径`);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) die(`audio.${kind} 文件不存在：${src}`);
  if (path.resolve(src) === path.resolve(m.output)) die(`output 不能覆盖 audio.${kind} 的源素材`);
}

const transition = typeof m.transition === 'string'
  ? { type: m.transition, duration: 0 }
  : { type: m.transition?.type || 'fade', duration: num(m.transition?.duration, 0.5) };

const style = {
  font: 'Noto Sans CJK SC',
  color: '#ffffff',
  outlineColor: '#000000',
  fadeIn: 0.3,
  fadeOut: 0.5,
  ...(m.style || {}),
};

const out = m.output;
const outDir = path.dirname(out);
const base = path.basename(out, path.extname(out));
if (!OPT.dryRun && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const workDir = m.workDir || path.join(outDir, `.${base}.work`);
if (!OPT.dryRun && !fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

const t0 = Date.now();
const durCache = new Map();
const ctx = {
  W, H, fps, workDir, out, transition, style,
  preset: m.preset || 'veryfast',
  crf: num(m.crf, 21),
  sourceDur: (src) => {
    if (!durCache.has(src)) {
      try { durCache.set(src, probe(src).duration); } catch { durCache.set(src, 0); }
    }
    return durCache.get(src);
  },
};

log(`▶ ${W}×${H} @${fps}fps · ${m.scenes.length} 场景 · ${transition.type}${transition.duration ? ' ' + transition.duration + 's' : ''}`);

const plans = m.scenes.map((s, i) => planScene(s, i, ctx));
const durations = plans.map((p) => p.duration);
const total = durations.reduce((a, b) => a + b, 0)
  - (transition.type === 'none' ? 0 : transition.duration * (plans.length - 1));
if (!(total > 0)) die('总时长算出来是 0，检查 duration / transition');

// 场景渲染（参数不变就复用中间片）
const cacheFile = path.join(workDir, 'cache.json');
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cache = {}; }
const seen = new Set();
for (let i = 0; i < plans.length; i++) {
  const p = plans[i];
  const scene = m.scenes[i];
  const sourceStat = fs.statSync(scene.src);
  const key = crypto.createHash('sha1')
    .update(JSON.stringify({
      args: p.args,
      source: { size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, ctimeMs: sourceStat.ctimeMs },
    }))
    .digest('hex').slice(0, 16);
  const name = path.basename(p.out);
  seen.add(name);
  if (!OPT.dryRun && cache[name] === key && fs.existsSync(p.out)) {
    log(`  · 场景 ${i + 1}/${plans.length} 复用中间片（${p.duration.toFixed(2)}s）`);
    continue;
  }
  log(`  · 场景 ${i + 1}/${plans.length} ${p.isImg ? '图片' : '视频'} ${p.duration.toFixed(2)}s${scene.motion ? ' · ' + scene.motion : ''}`);
  ff(p.args, `场景 ${i + 1}`);
  if (!OPT.dryRun) cache[name] = key;
}
if (!OPT.dryRun) {
  for (const k of Object.keys(cache)) if (!seen.has(k)) delete cache[k];
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}

// 字幕
const cues = buildCues(m.scenes, durations, transition, total);

// 音频
const audioCfg = m.audio || {};
const audio = [];
if (audioCfg.bgm) {
  if (!fs.existsSync(audioCfg.bgm)) die(`BGM 不存在：${audioCfg.bgm}`);
  audio.push({
    kind: 'bgm', path: audioCfg.bgm, index: -1,
    input: ['-stream_loop', '-1', '-i', audioCfg.bgm],
    volume: num(audioCfg.volume, 0.45),
  });
}
if (audioCfg.voice) {
  if (!fs.existsSync(audioCfg.voice)) die(`旁白不存在：${audioCfg.voice}`);
  audio.push({
    kind: 'voice', path: audioCfg.voice, index: -1,
    input: ['-i', audioCfg.voice],
    volume: num(audioCfg.voiceVolume, 1.0),
    delay: num(audioCfg.voiceDelay, 0),
    duck: audioCfg.duck,
  });
}

compose(plans.map((p) => p.out), durations, ctx, cues, audio, total);

// 验收：探测 + 封面 + 静帧 + SRT
if (!OPT.dryRun) {
  const info = probe(out);
  const size = (fs.statSync(out).size / 1048576).toFixed(2);
  log(`✓ 成片 ${out}`);
  log(`  ${info.width}×${info.height} · ${info.duration.toFixed(2)}s · ${size}MB · ${info.videoCodec}/${info.audioCodec}`);

  const coverAt = Math.min(Math.max(0.2, total * 0.25), Math.max(0.2, total - 0.1));
  const cover = path.join(outDir, `${base}.cover.jpg`);
  ff(['-hide_banner', '-loglevel', 'error', '-y', '-ss', coverAt.toFixed(2), '-i', out,
    '-frames:v', '1', '-q:v', '2', cover], '封面');
  log(`  封面 ${cover}`);

  if (OPT.still !== null && Number.isFinite(OPT.still)) {
    const t = Math.min(Math.max(0, OPT.still), Math.max(0, total - 0.05));
    const png = path.join(outDir, `${base}.still-${t.toFixed(1)}.png`);
    ff(['-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(3), '-i', out,
      '-frames:v', '1', png], '静帧');
    log(`  静帧 t=${t.toFixed(2)}s → ${png}`);
  }

  if (m.srt === true && cues.length) {
    const srt = path.join(outDir, `${base}.srt`);
    const st = (t) => {
      const h = Math.floor(t / 3600), mi = Math.floor((t % 3600) / 60), s = t % 60;
      return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0').replace('.', ',')}`;
    };
    fs.writeFileSync(srt, cues.map((c, i) => `${i + 1}\n${st(c.start)} --> ${st(c.end)}\n${c.text}\n`).join('\n'));
    log(`  SRT ${srt}`);
  }
  log(`⏱ 用时 ${secs(t0)}`);
}
