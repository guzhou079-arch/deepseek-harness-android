---
name: dsh-voice
description: 控制 Android 手机端语音交互与全双工对讲：包含语音识别转文字 (STT)、语音状态监听 (android_voice)、以及系统级 TextToSpeech 语音播报 (android_tts)。在需要语音输入、播报回复或与用户语音交互时使用。
whenToUse: 当用户希望用语音提问、要求用语音念出回答、或者需要开启/控制手机端语音交互通道时。
---

# Android 语音交互与播报 (DSH 内嵌版)

## 一、语音识别 (STT) 与状态控制

调用工具 `android_voice`：
- `action="start"`：开启麦克风开始收音与语音识别；
- `action="stop"`：停止说话并完成文字转换（提取最新识别出的文字）；
- `action="cancel"`：取消当前收音；
- `action="status"`：查询当前麦克风状态、音量 RMS、识别中临时文本与最终文本。

底层对接 Android 原生 `SpeechRecognizer`，免流量、免额外 API 费用。

## 二、语音朗读 (TTS)

调用工具 `android_tts`：
- `action="speak", text="要念出的内容", queue=false`：立即语音播报文本；
- `action="stop"`：立即停止正在播报的语音；
- `action="status"`：查询当前是否正在朗读。

底层对接 Android 原生 `TextToSpeech` 引擎（支持中文与多语言自适应）。

## 三、典型对话联动配方

1. **收到长篇复杂回答或汇报**：AI 在输出 Markdown 文本的同时，可调用 `android_tts action=speak text="为您找到以下几点核心信息..."` 进行语音同步概括。
2. **语音交互轮询**：若用户开启语音对话模式，AI 可在播报结束后通过 `android_voice action=start` 自动转入下一轮收音，实现连续对讲。
