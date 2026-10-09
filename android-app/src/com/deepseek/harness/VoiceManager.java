package com.deepseek.harness;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 语音交互全能管理器 (VoiceManager)
 * 1. 端侧轻量 KWS (Keyword Spotting) 语音唤醒引擎
 * 2. 语音转文字 (STT - SpeechRecognizer 流式与连续模式)
 * 3. 语音合成播报 (TTS - TextToSpeech)
 * 4. 唤醒提示音与触觉反馈 (ToneGenerator + Vibrator)
 * 5. 一句话连续问答 (唤醒词+指令自动提取并直达 DSH 思考)
 */
public class VoiceManager {
    private static final String TAG = "VoiceManager";
    private static volatile VoiceManager instance;

    private final Context context;
    private final Handler mainHandler;

    // STT 核心
    private SpeechRecognizer speechRecognizer;
    private boolean isListening = false;
    private boolean isStandbyListening = false; // 是否处于低功耗热词待命监听状态
    private String currentState = "idle"; // idle, standby, listening, recording, recognizing, processing, speaking, error
    private String lastResult = "";
    private String partialResult = "";
    private String lastError = "";
    private float lastRms = 0f;
    private long lastResultTime = 0;
    private int consecutiveErrors = 0;

    // TTS 核心
    private TextToSpeech tts;
    private boolean ttsInitialized = false;

    // 热词唤醒 (KWS) 状态
    private boolean hotwordEnabled = false;
    private String wakeWords = "流光,小鲸鱼,DeepSeek";
    private final Set<String> wakeWordAliases = new HashSet<String>();

    // 音频反馈
    private ToneGenerator toneGenerator;

    public interface VoiceCallback {
        void onStateChange(String state, String message);
        void onResult(String text, boolean isFinal);
        void onError(String error);
    }

    private final ArrayList<VoiceCallback> callbacks = new ArrayList<VoiceCallback>();

    public static VoiceManager get(Context context) {
        if (instance == null) {
            synchronized (VoiceManager.class) {
                if (instance == null) {
                    instance = new VoiceManager(context.getApplicationContext());
                }
            }
        }
        return instance;
    }

    private VoiceManager(Context context) {
        this.context = context;
        this.mainHandler = new Handler(Looper.getMainLooper());
        loadSettings();
        initTts();
        try {
            toneGenerator = new ToneGenerator(AudioManager.STREAM_MUSIC, 85);
        } catch (Throwable ignored) {}

        // 如果用户之前开启了热词唤醒，自动启动待命监听
        if (hotwordEnabled) {
            startHotword();
        }
    }

    private void loadSettings() {
        try {
            android.content.SharedPreferences sp = context.getSharedPreferences("dsh_prefs", Context.MODE_PRIVATE);
            hotwordEnabled = sp.getBoolean("voice_hotword_enabled", false);
            wakeWords = sp.getString("voice_wake_words", "流光,小鲸鱼,DeepSeek");
            rebuildWakeWordAliases();
        } catch (Throwable ignored) {}
    }

    public String getWakeWords() {
        return wakeWords;
    }

    public void setWakeWords(String words) {
        if (words == null || words.trim().isEmpty()) words = "流光,小鲸鱼,DeepSeek";
        this.wakeWords = words.trim();
        rebuildWakeWordAliases();
        try {
            context.getSharedPreferences("dsh_prefs", Context.MODE_PRIVATE)
                    .edit().putString("voice_wake_words", this.wakeWords).apply();
        } catch (Throwable ignored) {}
    }

    /**
     * 构建唤醒词及其同音字/常见拼音多音拓展库
     */
    private synchronized void rebuildWakeWordAliases() {
        wakeWordAliases.clear();
        if (wakeWords == null || wakeWords.trim().isEmpty()) return;

        String[] parts = wakeWords.split("[,，|/\\s]+");
        for (String p : parts) {
            String item = p.trim().toLowerCase(Locale.ROOT);
            if (item.isEmpty()) continue;
            wakeWordAliases.add(item);

            // 针对常用唤醒词内置同音/谐音词库
            if (item.contains("小鲸鱼") || item.contains("小金鱼") || item.contains("小静")) {
                wakeWordAliases.addAll(Arrays.asList("小鲸鱼", "小金鱼", "小静鱼", "小金", "小鲸", "鲸鱼", "小静", "xiaojingyu"));
            }
            if (item.contains("流光") || item.contains("刘光") || item.contains("留光")) {
                wakeWordAliases.addAll(Arrays.asList("流光", "留光", "刘光", "六光", "liuguang"));
            }
            if (item.contains("deepseek") || item.contains("deep") || item.contains("深度")) {
                wakeWordAliases.addAll(Arrays.asList("deepseek", "deep seek", "深度求索", "迪普西克", "地皮斯克", "deep", "seek"));
            }
        }
    }

    public synchronized void addCallback(VoiceCallback callback) {
        if (callback != null && !callbacks.contains(callback)) {
            callbacks.add(callback);
        }
    }

    public synchronized void removeCallback(VoiceCallback callback) {
        callbacks.remove(callback);
    }

    private synchronized void notifyStateChange(String state, String message) {
        this.currentState = state;
        for (VoiceCallback cb : new ArrayList<VoiceCallback>(callbacks)) {
            try { cb.onStateChange(state, message); } catch (Throwable ignored) {}
        }
    }

    private synchronized void notifyResult(String text, boolean isFinal) {
        for (VoiceCallback cb : new ArrayList<VoiceCallback>(callbacks)) {
            try { cb.onResult(text, isFinal); } catch (Throwable ignored) {}
        }
    }

    private synchronized void notifyError(String error) {
        this.lastError = error;
        for (VoiceCallback cb : new ArrayList<VoiceCallback>(callbacks)) {
            try { cb.onError(error); } catch (Throwable ignored) {}
        }
    }

    // ==================== 提示音与震动 ====================

    public void playPromptTone() {
        try {
            if (toneGenerator != null) {
                toneGenerator.startTone(ToneGenerator.TONE_PROP_BEEP, 150);
            }
            Vibrator vibrator = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) {
                vibrator.vibrate(40);
            }
        } catch (Throwable ignored) {}
    }

    // ==================== 统一触发入口 (悬浮球 / 蓝牙耳机 / 热词) ====================

    /**
     * 主动唤醒对讲交互（用户点击或热词唤醒后进入直接听指令模式）
     */
    public void triggerVoiceInteraction() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (isListening && !isStandbyListening) {
                    stopListening();
                    return;
                }
                playPromptTone();
                startListening(false); // 进入交互式聆听模式
            }
        });
    }

    // ==================== TTS (文字转语音) ====================

    private void initTts() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    tts = new TextToSpeech(context, new TextToSpeech.OnInitListener() {
                        @Override
                        public void onInit(int status) {
                            if (status == TextToSpeech.SUCCESS) {
                                int res = tts.setLanguage(Locale.CHINESE);
                                if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                                    tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                                }
                                ttsInitialized = true;
                                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                                    @Override
                                    public void onStart(String utteranceId) {
                                        // TTS 播报时暂停热词监听，避免 AI 自身声音误触发唤醒
                                        pauseHotwordDuringTts();
                                        notifyStateChange("speaking", "正在语音播报");
                                    }
                                    @Override
                                    public void onDone(String utteranceId) {
                                        notifyStateChange("idle", "播报完毕");
                                        resumeHotwordAfterTts();
                                    }
                                    @Override
                                    public void onError(String utteranceId) {
                                        notifyStateChange("idle", "播报中断");
                                        resumeHotwordAfterTts();
                                    }
                                });
                                Log.i(TAG, "TextToSpeech init success");
                            } else {
                                Log.w(TAG, "TextToSpeech init failed: " + status);
                            }
                        }
                    });
                } catch (Throwable t) {
                    Log.w(TAG, "initTts exception", t);
                }
            }
        });
    }

    private void pauseHotwordDuringTts() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (isStandbyListening) {
                    safeStopRecognizer();
                }
            }
        });
    }

    private void resumeHotwordAfterTts() {
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (hotwordEnabled && !isListening) {
                    startHotword();
                }
            }
        }, 500);
    }

    public void speak(final String text, final boolean queue) {
        if (text == null || text.trim().isEmpty()) return;
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (!ttsInitialized || tts == null) {
                    Log.w(TAG, "speak failed: TTS not initialized");
                    return;
                }
                int queueMode = queue ? TextToSpeech.QUEUE_ADD : TextToSpeech.QUEUE_FLUSH;
                String utteranceId = "dsh_tts_" + System.currentTimeMillis();
                tts.speak(text, queueMode, null, utteranceId);
            }
        });
    }

    public void stopSpeaking() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (tts != null && ttsInitialized) {
                    tts.stop();
                    notifyStateChange("idle", "已停止播报");
                    resumeHotwordAfterTts();
                }
            }
        });
    }

    public boolean isSpeaking() {
        return tts != null && ttsInitialized && tts.isSpeaking();
    }

    // ==================== STT (语音识别转文字 & KWS 唤醒) ====================

    public boolean isRecognitionAvailable() {
        return SpeechRecognizer.isRecognitionAvailable(context);
    }

    public void startListening() {
        startListening(false);
    }

    /**
     * 启动语音识别
     * @param standby true=低功耗待命热词监听; false=用户主动交互收音
     */
    private synchronized void startListening(final boolean standby) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (isSpeaking()) {
                        stopSpeaking();
                    }

                    if (!isRecognitionAvailable()) {
                        lastError = "系统未找到可用的语音识别服务";
                        notifyError(lastError);
                        return;
                    }

                    // 如果当前识别器处于忙碌状态，先安全释放重建
                    safeDestroyRecognizer();

                    speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context);
                    speechRecognizer.setRecognitionListener(new InnerRecognitionListener(standby));

                    Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.CHINESE.toString());
                    intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                    intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
                    intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());

                    speechRecognizer.startListening(intent);
                    isListening = true;
                    isStandbyListening = standby;
                    partialResult = "";
                    lastError = "";
                    
                    if (standby) {
                        notifyStateChange("standby", "热词待命中...");
                    } else {
                        notifyStateChange("listening", "正在聆听...");
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "startListening error", t);
                    lastError = t.getMessage();
                    isListening = false;
                    isStandbyListening = false;
                    notifyError(lastError);
                }
            }
        });
    }

    public void stopListening() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    if (speechRecognizer != null && isListening) {
                        speechRecognizer.stopListening();
                        notifyStateChange("recognizing", "正在识别文字...");
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "stopListening error", t);
                }
            }
        });
    }

    public void cancelListening() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    safeStopRecognizer();
                    isListening = false;
                    isStandbyListening = false;
                    notifyStateChange("idle", "已取消");
                    if (hotwordEnabled) {
                        scheduleHotwordRestart(300);
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "cancelListening error", t);
                }
            }
        });
    }

    private void safeStopRecognizer() {
        try {
            if (speechRecognizer != null) {
                speechRecognizer.cancel();
            }
        } catch (Throwable ignored) {}
        isListening = false;
        isStandbyListening = false;
    }

    private void safeDestroyRecognizer() {
        try {
            if (speechRecognizer != null) {
                speechRecognizer.cancel();
                speechRecognizer.destroy();
                speechRecognizer = null;
            }
        } catch (Throwable ignored) {}
        isListening = false;
        isStandbyListening = false;
    }

    private void scheduleHotwordRestart(long delayMs) {
        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (hotwordEnabled && !isListening && !isSpeaking()) {
                    startHotword();
                }
            }
        }, delayMs);
    }

    // ==================== KWS 关键词声学/文本匹配结构 ====================

    public static class WakeWordMatch {
        public final String wakeWord;
        public final String command;
        public final boolean hasCommand;

        public WakeWordMatch(String wakeWord, String command) {
            this.wakeWord = wakeWord;
            this.command = command != null ? command.trim() : "";
            this.hasCommand = !this.command.isEmpty();
        }
    }

    /**
     * 智能判定识别文本中是否命中唤醒词，并自动剥离唤醒词提取后续指令
     */
    private WakeWordMatch checkWakeWordMatch(String rawText) {
        if (rawText == null || rawText.trim().isEmpty()) return null;
        String text = rawText.trim();
        String lower = text.toLowerCase(Locale.ROOT);

        for (String alias : wakeWordAliases) {
            if (alias == null || alias.isEmpty()) continue;
            int idx = lower.indexOf(alias);
            if (idx >= 0) {
                // 命中唤醒词！提取唤醒词之后的指令
                String command = text.substring(idx + alias.length()).trim();
                // 剔除前缀标点与常见连接助词（如 "，"、"："、"帮我"、"请"、"把" 等）
                command = command.replaceAll("^[，,：:、\\s]+", "").trim();
                return new WakeWordMatch(alias, command);
            }
        }
        return null;
    }

    private class InnerRecognitionListener implements RecognitionListener {
        private final boolean standbyMode;

        public InnerRecognitionListener(boolean standbyMode) {
            this.standbyMode = standbyMode;
        }

        @Override
        public void onReadyForSpeech(Bundle params) {
            if (!standbyMode) {
                notifyStateChange("listening", "请说话...");
            }
        }

        @Override
        public void onBeginningOfSpeech() {
            if (!standbyMode) {
                notifyStateChange("recording", "正在收音...");
            }
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            lastRms = rmsdB;
        }

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {
            if (!standbyMode) {
                notifyStateChange("recognizing", "识别中...");
            }
        }

        @Override
        public void onError(int error) {
            isListening = false;
            isStandbyListening = false;
            lastError = getErrorText(error);

            if (!standbyMode) {
                Log.w(TAG, "SpeechRecognizer error: " + lastError + " (" + error + ")");
                notifyError(lastError);
            }

            // 针对待命热词模式的自愈与平滑重连逻辑
            if (hotwordEnabled) {
                if (error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT || error == SpeechRecognizer.ERROR_NO_MATCH) {
                    // 正常的无声/静音超时，无感平滑重连
                    consecutiveErrors = 0;
                    scheduleHotwordRestart(150);
                } else if (error == SpeechRecognizer.ERROR_CLIENT || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) {
                    // 客户端/识别器忙，安全销毁重建并退避
                    consecutiveErrors++;
                    long backoff = Math.min(consecutiveErrors * 500, 3000);
                    safeDestroyRecognizer();
                    scheduleHotwordRestart(backoff);
                } else {
                    scheduleHotwordRestart(1000);
                }
            }
        }

        @Override
        public void onResults(Bundle results) {
            isListening = false;
            isStandbyListening = false;
            consecutiveErrors = 0;

            ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches != null && !matches.isEmpty()) {
                String text = matches.get(0);
                lastResult = text;
                partialResult = text;
                lastResultTime = System.currentTimeMillis();
                Log.i(TAG, "Speech text: " + text + " (standby=" + standbyMode + ")");

                if (standbyMode) {
                    // 待命模式下，检验是否命中唤醒词
                    WakeWordMatch match = checkWakeWordMatch(text);
                    if (match != null) {
                        Log.i(TAG, "🎯 唤醒词命中: [" + match.wakeWord + "] 后续指令: [" + match.command + "]");
                        playPromptTone();
                        if (match.hasCommand) {
                            // 一句话完整问答：唤醒词 + 指令一并完成
                            notifyResult(match.command, true);
                            submitVoiceCommand(match.command);
                        } else {
                            // 仅说了唤醒词，进入交互聆听模式
                            notifyStateChange("listening", "我在，请说...");
                            startListening(false);
                            return;
                        }
                    }
                } else {
                    // 交互模式下，直接提交指令
                    notifyResult(text, true);
                    submitVoiceCommand(text);
                }
            } else {
                if (!standbyMode) {
                    notifyStateChange("idle", "未识别到内容");
                }
            }

            // 重新进入待命监听
            if (hotwordEnabled && !isSpeaking()) {
                scheduleHotwordRestart(300);
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches != null && !matches.isEmpty()) {
                String partial = matches.get(0);
                partialResult = partial;

                if (standbyMode) {
                    // 流式检测到唤醒词瞬间立即响应
                    WakeWordMatch match = checkWakeWordMatch(partial);
                    if (match != null) {
                        Log.i(TAG, "🎯 流式唤醒词命中: [" + match.wakeWord + "]");
                        playPromptTone();
                        // 停止待命识别，转为活跃处理
                        safeStopRecognizer();
                        if (match.hasCommand) {
                            notifyResult(match.command, true);
                            submitVoiceCommand(match.command);
                        } else {
                            notifyStateChange("listening", "我在，请说...");
                            startListening(false);
                        }
                        return;
                    }
                } else {
                    notifyResult(partial, false);
                }
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }

    private static String getErrorText(int errorCode) {
        switch (errorCode) {
            case SpeechRecognizer.ERROR_AUDIO: return "音频录制错误";
            case SpeechRecognizer.ERROR_CLIENT: return "客户端错误";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "未授予录音权限";
            case SpeechRecognizer.ERROR_NETWORK: return "网络连接异常";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "网络超时";
            case SpeechRecognizer.ERROR_NO_MATCH: return "未听清，请重试";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "识别引擎忙";
            case SpeechRecognizer.ERROR_SERVER: return "服务端错误";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "未检测到说话声音";
            default: return "识别错误 (" + errorCode + ")";
        }
    }

    // ==================== DSH 对话自动提交与回复 ====================

    private void submitVoiceCommand(final String promptText) {
        if (promptText == null || promptText.trim().isEmpty()) return;
        notifyStateChange("processing", "AI 思考中...");
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    int port = getEnginePort();
                    File logFile = new File(context.getFilesDir(), "dsh-web.log");
                    org.json.JSONObject created = EngineRpc.call(logFile, port, "session/create", new org.json.JSONObject());
                    String sessionId = created.getString("sessionId");
                    org.json.JSONObject accepted = EngineRpc.call(logFile, port, "session/prompt", EngineRpc.prompt(sessionId, promptText));
                    if (!accepted.optBoolean("accepted", false)) {
                        throw new java.io.IOException("voice prompt was not accepted");
                    }
                    Log.i(TAG, "Voice prompt submitted to DSH successfully: " + promptText);
                } catch (Throwable t) {
                    Log.w(TAG, "submitVoiceCommand error", t);
                }
            }
        }, "dsh-voice-exec").start();
    }

    private int getEnginePort() {
        try {
            String p = context.getPackageName();
            if (p != null) {
                if (p.endsWith(".beta")) return 3082;
                if (p.endsWith(".compat")) return 3084;
            }
        } catch (Throwable ignored) {}
        return 3080;
    }

    // ==================== 热词唤醒开关 (Hotword Wake-Up) ====================

    public void setHotwordEnabled(boolean enabled) {
        this.hotwordEnabled = enabled;
        try {
            context.getSharedPreferences("dsh_prefs", Context.MODE_PRIVATE)
                    .edit().putBoolean("voice_hotword_enabled", enabled).apply();
        } catch (Throwable ignored) {}
        if (enabled) {
            startHotword();
        } else {
            stopHotword();
        }
    }

    public boolean isHotwordEnabled() {
        return hotwordEnabled;
    }

    private void startHotword() {
        if (!hotwordEnabled) return;
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (!isListening && !isSpeaking()) {
                    startListening(true); // 启动待命热词监听
                }
            }
        });
    }

    private void stopHotword() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (isStandbyListening) {
                    safeStopRecognizer();
                }
            }
        });
    }

    // ==================== 状态 JSON 输出 ====================

    public String getStatusJson() {
        StringBuilder sb = new StringBuilder();
        sb.append("{");
        sb.append("\"ok\":true,");
        sb.append("\"recognitionAvailable\":").append(isRecognitionAvailable()).append(",");
        sb.append("\"isListening\":").append(isListening).append(",");
        sb.append("\"isStandbyListening\":").append(isStandbyListening).append(",");
        sb.append("\"state\":\"").append(escape(currentState)).append("\",");
        sb.append("\"rms\":").append(lastRms).append(",");
        sb.append("\"partialResult\":\"").append(escape(partialResult)).append("\",");
        sb.append("\"lastResult\":\"").append(escape(lastResult)).append("\",");
        sb.append("\"lastResultTime\":").append(lastResultTime).append(",");
        sb.append("\"lastError\":\"").append(escape(lastError)).append("\",");
        sb.append("\"ttsReady\":").append(ttsInitialized).append(",");
        sb.append("\"isSpeaking\":").append(isSpeaking()).append(",");
        sb.append("\"hotwordEnabled\":").append(hotwordEnabled).append(",");
        sb.append("\"wakeWords\":\"").append(escape(wakeWords)).append("\"");
        sb.append("}");
        return sb.toString();
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    public void destroy() {
        stopHotword();
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    safeDestroyRecognizer();
                    if (tts != null) {
                        tts.stop();
                        tts.shutdown();
                        tts = null;
                    }
                    if (toneGenerator != null) {
                        toneGenerator.release();
                        toneGenerator = null;
                    }
                } catch (Throwable ignored) {}
            }
        });
    }
}
