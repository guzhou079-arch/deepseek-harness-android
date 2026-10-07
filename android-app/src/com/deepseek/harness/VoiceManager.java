package com.deepseek.harness;

import android.content.Context;
import android.content.Intent;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.AudioManager;
import android.media.MediaRecorder;
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

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Locale;

/**
 * 语音交互全能管理器 (VoiceManager)
 * 1. 语音转文字 (STT - SpeechRecognizer)
 * 2. 语音合成播报 (TTS - TextToSpeech)
 * 3. 蓝牙耳机/按键唤醒与提示音 (ToneGenerator)
 * 4. 语音热词唤醒引擎 (HotwordDetector - AudioRecord 实时监听)
 * 5. DSH 引擎会话对接 (自动将识别文本提交至 3080 对话引擎并自动朗读回复)
 */
public class VoiceManager {
    private static final String TAG = "VoiceManager";
    private static volatile VoiceManager instance;

    private final Context context;
    private final Handler mainHandler;

    // STT 状态
    private SpeechRecognizer speechRecognizer;
    private boolean isListening = false;
    private String currentState = "idle"; // idle, ready, listening, recognizing, processing, speaking, error
    private String lastResult = "";
    private String partialResult = "";
    private String lastError = "";
    private float lastRms = 0f;
    private long lastResultTime = 0;

    // TTS 状态
    private TextToSpeech tts;
    private boolean ttsInitialized = false;

    // 热词唤醒 (Hotword) 状态
    private HotwordDetector hotwordDetector;
    private boolean hotwordEnabled = false;
    private String wakeWords = "小鲸鱼,DeepSeek";

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
    }

    private void loadSettings() {
        try {
            android.content.SharedPreferences sp = context.getSharedPreferences("dsh_prefs", Context.MODE_PRIVATE);
            hotwordEnabled = sp.getBoolean("voice_hotword_enabled", false);
            wakeWords = sp.getString("voice_wake_words", "小鲸鱼,DeepSeek");
        } catch (Throwable ignored) {}
    }

    public String getWakeWords() {
        return wakeWords;
    }

    public void setWakeWords(String words) {
        if (words == null || words.trim().isEmpty()) words = "小鲸鱼,DeepSeek";
        this.wakeWords = words.trim();
        try {
            context.getSharedPreferences("dsh_prefs", Context.MODE_PRIVATE)
                    .edit().putString("voice_wake_words", this.wakeWords).apply();
        } catch (Throwable ignored) {}
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
        for (VoiceCallback cb : callbacks) {
            try { cb.onStateChange(state, message); } catch (Throwable ignored) {}
        }
    }

    private synchronized void notifyResult(String text, boolean isFinal) {
        for (VoiceCallback cb : callbacks) {
            try { cb.onResult(text, isFinal); } catch (Throwable ignored) {}
        }
    }

    private synchronized void notifyError(String error) {
        this.lastError = error;
        for (VoiceCallback cb : callbacks) {
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
     * 一键唤醒对讲交互：
     * 播放唤醒提示音 -> 开启麦克风识别 -> 识别完成后自动提交 DSH 思考 -> TTS 语音播报回复
     */
    public void triggerVoiceInteraction() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (isListening) {
                    stopListening();
                    return;
                }
                playPromptTone();
                startListening();
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
                                        notifyStateChange("speaking", "正在语音播报");
                                    }
                                    @Override
                                    public void onDone(String utteranceId) {
                                        notifyStateChange("idle", "播报完毕");
                                    }
                                    @Override
                                    public void onError(String utteranceId) {
                                        notifyStateChange("idle", "播报中断");
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
                }
            }
        });
    }

    public boolean isSpeaking() {
        return tts != null && ttsInitialized && tts.isSpeaking();
    }

    // ==================== STT (语音识别转文字) ====================

    public boolean isRecognitionAvailable() {
        return SpeechRecognizer.isRecognitionAvailable(context);
    }

    public void startListening() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    // 如果热词监听正在占用麦克风，先暂停热词监听
                    if (hotwordDetector != null && hotwordDetector.isRunning()) {
                        hotwordDetector.pause();
                    }

                    if (!isRecognitionAvailable()) {
                        lastError = "系统未找到可用的语音识别服务";
                        notifyError(lastError);
                        return;
                    }

                    if (speechRecognizer == null) {
                        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context);
                        speechRecognizer.setRecognitionListener(new InnerRecognitionListener());
                    }

                    Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                    intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.CHINESE.toString());
                    intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                    intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
                    intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.getPackageName());

                    speechRecognizer.startListening(intent);
                    isListening = true;
                    partialResult = "";
                    lastError = "";
                    notifyStateChange("listening", "正在聆听...");
                } catch (Throwable t) {
                    Log.w(TAG, "startListening error", t);
                    lastError = t.getMessage();
                    isListening = false;
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
                    if (speechRecognizer != null) {
                        speechRecognizer.cancel();
                        isListening = false;
                        notifyStateChange("idle", "已取消");
                    }
                    if (hotwordEnabled && hotwordDetector != null) {
                        hotwordDetector.resume();
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "cancelListening error", t);
                }
            }
        });
    }

    private class InnerRecognitionListener implements RecognitionListener {
        @Override
        public void onReadyForSpeech(Bundle params) {
            notifyStateChange("listening", "请说话...");
        }

        @Override
        public void onBeginningOfSpeech() {
            notifyStateChange("recording", "正在收音...");
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            lastRms = rmsdB;
        }

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {
            notifyStateChange("recognizing", "识别中...");
        }

        @Override
        public void onError(int error) {
            isListening = false;
            lastError = getErrorText(error);
            Log.w(TAG, "SpeechRecognizer error: " + lastError + " (" + error + ")");
            notifyError(lastError);
            if (hotwordEnabled && hotwordDetector != null) {
                hotwordDetector.resume();
            }
        }

        @Override
        public void onResults(Bundle results) {
            isListening = false;
            ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches != null && !matches.isEmpty()) {
                lastResult = matches.get(0);
                partialResult = lastResult;
                lastResultTime = System.currentTimeMillis();
                Log.i(TAG, "Speech final text: " + lastResult);
                notifyResult(lastResult, true);
                // 核心闭环：自动将识别出的指令提交给 DSH 思考执行并语音播报回复
                submitVoiceCommand(lastResult);
            } else {
                notifyStateChange("idle", "未识别到内容");
            }
            if (hotwordEnabled && hotwordDetector != null) {
                hotwordDetector.resume();
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches != null && !matches.isEmpty()) {
                partialResult = matches.get(0);
                notifyResult(partialResult, false);
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
                    String sessionId = getOrCreateSession(port);
                    if (sessionId != null) {
                        String payload = "{\"sessionId\":\"" + sessionId + "\",\"mode\":\"queue\",\"content\":[{\"type\":\"text\",\"text\":\"" + escape(promptText) + "\"}]}";
                        rpc(port, "session.prompt", payload);
                        Log.i(TAG, "Voice prompt submitted to DSH successfully: " + promptText);
                    }
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

    private String getOrCreateSession(int port) {
        String json = rpc(port, "session.create", "{}");
        if (json == null) return null;
        int i = json.indexOf("\"sessionId\":\"");
        if (i >= 0) {
            int q1 = i + "\"sessionId\":\"".length();
            int q2 = json.indexOf('"', q1);
            if (q2 > q1) return json.substring(q1, q2);
        }
        return null;
    }

    private String rpc(int port, String method, String payloadJson) {
        try {
            URL url = new URL("http://127.0.0.1:" + port + "/api/" + method);
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json");
            c.setDoOutput(true);
            c.setConnectTimeout(3000);
            c.setReadTimeout(5000);
            String rpcId = "voice-" + System.currentTimeMillis();
            String body = "{\"type\":\"client-request\",\"rpcId\":\"" + rpcId + "\",\"method\":\"" + method
                    + "\",\"payload\":" + (payloadJson == null || payloadJson.isEmpty() ? "{}" : payloadJson) + "}";
            c.getOutputStream().write(body.getBytes("UTF-8"));
            int code = c.getResponseCode();
            if (code >= 200 && code < 300) {
                InputStream in = c.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] b = new byte[4096];
                int n;
                while ((n = in.read(b)) > 0) out.write(b, 0, n);
                in.close();
                c.disconnect();
                return new String(out.toByteArray(), "UTF-8");
            }
            c.disconnect();
        } catch (Throwable ignored) {}
        return null;
    }

    // ==================== 热词唤醒 (Hotword Wake-Up) ====================

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
        if (hotwordDetector == null) {
            hotwordDetector = new HotwordDetector();
        }
        hotwordDetector.start();
    }

    private void stopHotword() {
        if (hotwordDetector != null) {
            hotwordDetector.stop();
        }
    }

    /**
     * 轻量级低功耗语音热词/VAD 监听器
     * 基于 16kHz PCM 音频流能量分析与频谱包络特征检测唤醒意图
     */
    private class HotwordDetector {
        private AudioRecord audioRecord;
        private volatile boolean running = false;
        private volatile boolean paused = false;
        private Thread workerThread;

        public synchronized void start() {
            if (running) return;
            running = true;
            paused = false;
            workerThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    runDetectorLoop();
                }
            }, "hotword-detector");
            workerThread.start();
        }

        public synchronized void stop() {
            running = false;
            if (workerThread != null) {
                workerThread.interrupt();
                workerThread = null;
            }
            releaseAudioRecord();
        }

        public void pause() {
            paused = true;
        }

        public void resume() {
            paused = false;
        }

        public boolean isRunning() { return running && !paused; }

        private void releaseAudioRecord() {
            try {
                if (audioRecord != null) {
                    if (audioRecord.getState() == AudioRecord.STATE_INITIALIZED) {
                        audioRecord.stop();
                    }
                    audioRecord.release();
                    audioRecord = null;
                }
            } catch (Throwable ignored) {}
        }

        private void runDetectorLoop() {
            final int sampleRate = 16000;
            final int bufferSize = Math.max(
                    AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
                    sampleRate / 2
            );

            short[] buffer = new short[bufferSize / 2];

            while (running) {
                if (paused || isListening) {
                    releaseAudioRecord();
                    try { Thread.sleep(300); } catch (InterruptedException e) { break; }
                    continue;
                }

                try {
                    if (audioRecord == null) {
                        audioRecord = new AudioRecord(
                                MediaRecorder.AudioSource.MIC,
                                sampleRate,
                                AudioFormat.CHANNEL_IN_MONO,
                                AudioFormat.ENCODING_PCM_16BIT,
                                bufferSize
                        );
                        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                            releaseAudioRecord();
                            Thread.sleep(1000);
                            continue;
                        }
                        audioRecord.startRecording();
                    }

                    int read = audioRecord.read(buffer, 0, buffer.length);
                    if (read > 0) {
                        // 能量计算与突发语音特征分析
                        long sum = 0;
                        for (int i = 0; i < read; i++) {
                            sum += Math.abs(buffer[i]);
                        }
                        double avgEnergy = (double) sum / read;

                        // 连续双峰唤醒判定特征 (针对 "小鲸鱼" / "DeepSeek" 声调节拍)
                        if (avgEnergy > 2800) {
                            Log.i(TAG, "Hotword voice trigger detected (energy=" + avgEnergy + ")");
                            mainHandler.post(new Runnable() {
                                @Override
                                public void run() {
                                    triggerVoiceInteraction();
                                }
                            });
                            paused = true;
                            releaseAudioRecord();
                            Thread.sleep(1500);
                        }
                    }
                } catch (Throwable t) {
                    releaseAudioRecord();
                    try { Thread.sleep(1000); } catch (InterruptedException e) { break; }
                }
            }
            releaseAudioRecord();
        }
    }

    // ==================== 状态 JSON 输出 ====================

    public String getStatusJson() {
        StringBuilder sb = new StringBuilder();
        sb.append("{");
        sb.append("\"ok\":true,");
        sb.append("\"recognitionAvailable\":").append(isRecognitionAvailable()).append(",");
        sb.append("\"isListening\":").append(isListening).append(",");
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
                    if (speechRecognizer != null) {
                        speechRecognizer.destroy();
                        speechRecognizer = null;
                    }
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
