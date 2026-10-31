---
name: dsh-video
description: 素材成片：照片/视频片段/音频 → 真正的 mp4（转场、Ken Burns 推拉、中文字幕烧录、BGM 与旁白混音自动避让、竖屏或横屏、封面帧与 SRT）。出的是能直接发平台的成片，不是脚本。
whenToUse: 用户说「把这些照片做成视频 / 剪个短片 / 素材做成竖屏视频 / 加字幕和配乐出片 / 帮我出个 mp4」时调用。
---

# 素材成片（dsh-video）

一句话：**给一个素材目录和一份 JSON，就能得到一条带转场、字幕、配乐的 mp4。** 渲染在本机 proot 里跑，不上传、不依赖云服务。

## 能做 / 不能做

能做：
- 图片序列 → 推拉（Ken Burns）或左右平移，交叉转场（xfade 全部类型），按场景配字幕。
- 视频片段 → 裁切（trim）、统一画幅/帧率、拼接、和图片混排。
- 音频 → BGM 循环补齐 + 淡入淡出；有旁白时 BGM 自动压下去（sidechain ducking）。
- 视频素材的原声会被丢弃；只混入 `audio` 中指定的文件。未指定音频时生成静音 AAC 音轨。
- 输出 9:16 / 16:9 / 1:1 任意偶数尺寸，H.264 + AAC、`+faststart`（手机相册直接能播）。
- 顺手给：封面 jpg、指定时刻静帧 png（验收用）、可选 SRT。

不能做（别答应）：
- 不生成画面（不做文生图/文生视频）；素材必须是现成的。
- 不做「自动挑片段/自动卡点」这类语义剪辑，时间轴由 manifest 决定。
- 当前工具只支持 TTS 外放，本技能不能直接导出配音文件；配音需先准备好音频。
- 不做去水印、不做超分修复。
- 不读 HEIC：`inventory.mjs` 直接跳过 `.heic`（本机 ffmpeg 6.1 对它的支持未验证）。遇到就先在相册里「另存为 JPG」。

## 依赖（都已就位，别再找）

- ffmpeg 6.1 **只在 proot Alpine 里**：`/data/user/0/com.deepseek.harness/files/work/linux/run.sh ffmpeg ...`
- libass + fontconfig + `Noto Sans CJK SC` 齐全（中文字幕靠它烧）。
- Node ≥ 20（本机 v26）。

## 三步流程

### 1. 盘点素材

```sh
SK=/data/user/0/com.deepseek.harness/files/payload/dshhome/skills/dsh-video
node "$SK/scripts/inventory.mjs" /sdcard/某目录 --width 720 --height 1280 --out /sdcard/某目录/draft.json
```

它按文件名自然排序、探测每个视频时长、给出草稿 manifest。**草稿只是起点**：填 `text`、调 `duration`、决定顺序。

### 2. 改 manifest（或直接手写）

```json
{
  "output": "/sdcard/DeepSeekHarness/videos/demo.mp4",
  "width": 720, "height": 1280, "fps": 30,
  "scenes": [
    { "src": "/sdcard/素材/01.jpg", "duration": 2.2, "motion": "in",    "text": "第一句" },
    { "src": "/sdcard/素材/02.mp4", "duration": 3.0, "trim": 1.5 },
    { "src": "/sdcard/素材/03.jpg", "duration": 2.0, "motion": "left",  "text": "第二句\n可以换行" }
  ],
  "transition": { "type": "fade", "duration": 0.5 },
  "audio": { "bgm": "/sdcard/素材/bgm.mp3", "volume": 0.4, "duck": true },
  "style": { "fontSize": 46, "marginV": 96 },
  "srt": true
}
```

| 字段 | 说明 |
|---|---|
| `output` | 成片绝对路径，**必须 .mp4** |
| `width/height/fps` | 宽高为正偶数，帧率为正数（可用 25/30）；竖屏 1080×1920，预览用 720×1280 |
| `scenes[].src` | **绝对路径**；图片按扩展名识别，也可 `"type":"image"` 强制 |
| `scenes[].duration` | 秒；图片缺省 2.5，视频缺省 min(4, 素材剩余) |
| `scenes[].motion` | `in`/`out`/`left`/`right`/`none`；图片默认 `in`，视频默认 `none` |
| `scenes[].zoom` | 推拉幅度，默认 0.08（8%） |
| `scenes[].trim` | 视频从第几秒开始截 |
| `scenes[].rotate` | 图片方向（0/90/180/270）。手机竖拍照片倒着时用它转正，不用改素材 |
| `scenes[].text` | 烧进画面的字幕，`\n` 换行；`textLead` 可调入场偏移 |
| `transition` | `{type,duration}` 或 `"none"`；type 取 ffmpeg xfade：`fade`/`wipeleft`/`slideup`/`dissolve`/`smoothleft`… |
| `audio.bgm` / `voice` | 音频绝对路径；`volume`（BGM 默认 0.45）、`voiceVolume`、`voiceDelay`、`duck` |
| `style` | `font`（默认 Noto Sans CJK SC）、`fontSize`、`marginV`、`color`、`outline`（描边粗细）、`outlineColor`（描边颜色）、`box`、`fadeIn/out` |
| `srt` | `true` 时额外导出同名 `.srt` |

### 3. 渲染 + 验收

```sh
node "$SK/scripts/render.mjs" /sdcard/某目录/manifest.json --still 2.5
```

- `--still 秒`：出片后抽一张静帧 PNG —— **画面必须看一眼**。
- `--dry-run`：检查素材并打印渲染计划；视频输入会调用 ffprobe，但不会运行 ffmpeg、创建目录或写入文件。
- 改字幕/换 BGM 会复用场景中间片；缓存位于 `<输出目录>/.<片名>.work/`，检查渲染命令以及源文件大小、修改时间。旋转等画面参数改变会重渲对应场景。需要强制重渲时可另选 `workDir` 绝对路径。

验收四件套：

```sh
RUN=/data/user/0/com.deepseek.harness/files/work/linux/run.sh
$RUN ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 out.mp4
$RUN ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4
$RUN ffmpeg -hide_banner -i out.mp4 -af volumedetect -f null - 2>&1 | grep mean_volume   # 不是 -inf 才真有声音
```

再配合 `--still` 用 `read_image` 看一眼：字幕烧上了、没黑帧、主体没被裁掉。

## 坑（都踩过）

1. **ffmpeg 不在宿主 PATH**。一律经 `work/linux/run.sh` 调；脚本里默认就写死了这个入口，可用 `DSH_LINUX_RUN` 覆盖。
2. **filtergraph 的 label 只能被消费一次**。旁白要同时喂 sidechain 和 amix 时必须 `asplit=2`，否则报 `Stream specifier 'vo' ... matches no streams`。
3. **图片加缩放用单帧 + `zoompan d=N`**，别再叠 `-loop`（会变成 N×N 帧）。平移/静止才用 `-loop 1 -t`。
4. **xfade 要求两端同尺寸、同帧率、同 pix_fmt**。脚本先归一化中间片并 `settb=AVTB`，你换素材不用管；但别手改中间片。
5. **manifest 的 src 要绝对路径**。`inventory.mjs` 已输出绝对路径；手写时别用相对路径（ffmpeg 的 cwd 是 `/sdcard`，会找不到）。
6. **视频素材短于 duration 会被自动截短**（终端有 `!` 提示）。慢动作须先用 `setpts` 预处理素材；仅改变输出 fps 不会改变播放速度。
7. **片长 = Σ duration − 转场时长 ×（场景数−1）**。加场景后时长对不上先算这个。
8. **省流量的顺序**：先 720×1280 / `preset=ultrafast` / `crf=26` 出预览，定稿再 1080p / crf 21。本机实测 720p 约 2 倍实时（5.2s 片 ≈ 10s 渲染），1080p 更长。
9. **一次只跑一个渲染**。遵守手机一次只做一件重活的限制；长片先出短预览，确认后再渲染全片。
10. **输出后缀必须 `.mp4`**。`/sdcard` 上的 `.ts` 会被相册当成视频（历史事故：992 条零秒视频）。
11. **相册里没立刻看到**：媒体库有延迟，重新打开相册或等一会；文件本身已写好。
12. **照片方向**：个别手机照片带 EXIF 方向、ffmpeg 没吃到，画面会倒。用 `"rotate":90`（或 180/270）转正；`rotate` 只对图片生效（视频由 ffmpeg 自动旋转，别再手动转）。

## 和 dsh-storyboard 的分工

`dsh-storyboard` 负责「讲什么、怎么讲」（VOX 风分镜、旁白文案、视觉节奏）；`dsh-video` 负责「真的出片」。标准串法：storyboard 出分镜 → 按分镜准备素材 → 用本技能出片。

## 自测

```sh
bash "$SK/scripts/selftest.sh"    # 造素材→渲染→ffprobe 校验分辨率/编码/时长→PASS
```

自测会在 `/sdcard/DeepSeekHarness/tmp/dsh-video-selftest/run-XXXXXX/` 创建独立目录，保留此前的测试素材和成片。

## 安装位置与恢复

- 生效位置：`$DSH_HOME/skills/dsh-video/`（本机即 `.../payload/dshhome/skills/dsh-video`）。
- 源码副本：`/sdcard/DeepSeekHarness/skills-src/dsh-video/`（重装 App 不丢）。
- App 重装 / 内核重解压会清 payload → 技能消失时用源码副本恢复：

```sh
cp -r /sdcard/DeepSeekHarness/skills-src/dsh-video \
      /data/user/0/com.deepseek.harness/files/payload/dshhome/skills/
```

改完源码副本后同样执行上面这条覆盖回去。
