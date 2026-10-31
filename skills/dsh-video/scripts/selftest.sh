#!/bin/sh
# dsh-video 自测：造素材 → 出片 → 用 ffprobe 验收参数。
# 跑法： bash selftest.sh
# 约 30~60 秒（proot 启动 + 5 秒 720×1280 编码）。
set -eu

TEST_ROOT=/sdcard/DeepSeekHarness/tmp/dsh-video-selftest
RUN=${DSH_LINUX_RUN:-/data/user/0/com.deepseek.harness/files/work/linux/run.sh}
SKILL=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "✗ $*" >&2; exit 1; }

mkdir -p "$TEST_ROOT"
DIR=$(mktemp -d "$TEST_ROOT/run-XXXXXX")

echo "· 造素材"
"$RUN" ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=1600x2000:d=1" -frames:v 1 "$DIR/a.jpg"
"$RUN" ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "smptebars=s=1600x2000:d=1" -frames:v 1 "$DIR/b.jpg"
"$RUN" ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=s=1280x720:r=30:d=4" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$DIR/c.mp4"
"$RUN" ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=220:sample_rate=44100:duration=3" -c:a pcm_s16le "$DIR/bgm.wav"
"$RUN" ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=frequency=660:sample_rate=44100:duration=4" -c:a pcm_s16le "$DIR/voice.wav"

cat > "$DIR/manifest.json" <<JSON
{
  "output": "$DIR/out.mp4",
  "width": 720,
  "height": 1280,
  "fps": 30,
  "scenes": [
    { "src": "$DIR/a.jpg", "duration": 2, "motion": "in", "text": "第一帧：中文竖屏字幕" },
    { "src": "$DIR/c.mp4", "duration": 2.2, "trim": 0.5, "text": "视频素材裁切" },
    { "src": "$DIR/b.jpg", "duration": 2, "motion": "left", "text": "结尾\n两行也能排" }
  ],
  "transition": { "type": "fade", "duration": 0.5 },
  "audio": { "bgm": "$DIR/bgm.wav", "voice": "$DIR/voice.wav", "volume": 0.35, "duck": true },
  "style": { "fontSize": 46, "marginV": 96 },
  "srt": true
}
JSON

echo "· 渲染"
node "$SKILL/scripts/render.mjs" "$DIR/manifest.json" --still 2.5 || fail "渲染失败"
[ -s "$DIR/out.mp4" ] || fail "成片不存在"

echo "· 验收"
WH=$("$RUN" ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$DIR/out.mp4")
DUR=$("$RUN" ffprobe -v error -show_entries format=duration -of csv=p=0 "$DIR/out.mp4")
AC=$("$RUN" ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$DIR/out.mp4")
VC=$("$RUN" ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$DIR/out.mp4")

[ "$WH" = "720x1280" ] || fail "分辨率不对：$WH（期望 720x1280）"
[ "$VC" = "h264" ] || fail "视频编码不对：$VC"
[ "$AC" = "aac" ] || fail "音频编码不对：$AC"
awk -v d="$DUR" 'BEGIN{ if (d < 5.0 || d > 5.4) { printf "✗ 时长 %.2f 不在 5.0~5.4\n", d; exit 1 } }' || exit 1
[ -s "$DIR/out.cover.jpg" ] || fail "封面没生成"
[ -s "$DIR/out.srt" ] || fail "SRT 没生成"
[ -s "$DIR/out.still-2.5.png" ] || fail "静帧没生成"

# 肉眼验收：抽一帧看字幕有没有烧上去（人工/视觉模型看这张）
echo "  静帧： $DIR/out.still-2.5.png"
echo "  成片： $DIR/out.mp4  (${DUR}s)"
echo "PASS"
