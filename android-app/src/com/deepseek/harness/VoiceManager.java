package com.deepseek.harness;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

import java.util.ArrayList;
import java.util.Locale;

/**
 * 语音交互管理器 (VoiceManager)
 * 封装 Android 原生 SpeechRecognizer 语音识别 (STT) 与 TextToSpeech (TTS) 语音播报。
 * 遵循主线程调度机制，保证高版本 Android (11-16) 上的稳定性与生命周期安全。
 */
public class VoiceManager {
    private static final String TAG = "VoiceManager";
    private static volatile VoiceManager instance;

    private final Context context;
    private final Handler mainHandler;

    // STT 状态
    private SpeechRecognizer speechRecognizer;
    private boolean isListening = false;
    private String currentState = "idle"; // idle, ready, listening, recognizing, error
    private String lastResult = "";
    private String partialResult = "";
    private String lastError = "";
    private float lastRms = 0f;
    private long lastResultTime = 0;

    // TTS 状态
    private TextToSpeech tts;
    private boolean ttsInitialized = false;

    public interface VoiceCallback {
        void onStateChange(String state);
        void onResult(String text, boolean isFinal);
        void onError(String error);
    }

    private VoiceCallback voiceCallback;

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
        initTts();
    }

    public void setCallback(VoiceCallback callback) {
        this.voiceCallback = callback;
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
                                    tts.setLanguage(Locale.getDefault());
                                }
                                ttsInitialized = true;
                                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                                    @Override
                                    public void onStart(String utteranceId) {}
                                    @Override
                                    public void onDone(String utteranceId) {}
                                    @Override
                                    public void onError(String utteranceId) {}
                                });
                                Log.i(TAG, "TextToSpeech init success");
                            } else {
                                Log.w(TAG, "TextToSpeech init failed with status: " + status);
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
                    Log.w(TAG, "speak failed: TTS not initialized yet");
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
                    if (!isRecognitionAvailable()) {
                        currentState = "error";
                        lastError = "SpeechRecognizer not available on this device";
                        if (voiceCallback != null) voiceCallback.onError(lastError);
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
                    currentState = "ready";
                    partialResult = "";
                    lastError = "";
                    if (voiceCallback != null) voiceCallback.onStateChange(currentState);
                } catch (Throwable t) {
                    Log.w(TAG, "startListening error", t);
                    currentState = "error";
                    lastError = t.getMessage();
                    isListening = false;
                    if (voiceCallback != null) voiceCallback.onError(lastError);
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
                        currentState = "recognizing";
                        if (voiceCallback != null) voiceCallback.onStateChange(currentState);
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
                        currentState = "idle";
                        if (voiceCallback != null) voiceCallback.onStateChange(currentState);
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
            currentState = "listening";
            if (voiceCallback != null) voiceCallback.onStateChange(currentState);
        }

        @Override
        public void onBeginningOfSpeech() {
            currentState = "recording";
            if (voiceCallback != null) voiceCallback.onStateChange(currentState);
        }

        @Override
        public void onRmsChanged(float rmsdB) {
            lastRms = rmsdB;
        }

        @Override
        public void onBufferReceived(byte[] buffer) {}

        @Override
        public void onEndOfSpeech() {
            currentState = "recognizing";
            if (voiceCallback != null) voiceCallback.onStateChange(currentState);
        }

        @Override
        public void onError(int error) {
            isListening = false;
            currentState = "error";
            lastError = getErrorText(error);
            Log.w(TAG, "SpeechRecognizer error: " + lastError + " (" + error + ")");
            if (voiceCallback != null) voiceCallback.onError(lastError);
        }

        @Override
        public void onResults(Bundle results) {
            isListening = false;
            currentState = "idle";
            ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches != null && !matches.isEmpty()) {
                lastResult = matches.get(0);
                partialResult = lastResult;
                lastResultTime = System.currentTimeMillis();
                Log.i(TAG, "SpeechRecognizer final result: " + lastResult);
                if (voiceCallback != null) voiceCallback.onResult(lastResult, true);
            }
            if (voiceCallback != null) voiceCallback.onStateChange(currentState);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (matches != null && !matches.isEmpty()) {
                partialResult = matches.get(0);
                if (voiceCallback != null) voiceCallback.onResult(partialResult, false);
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {}
    }

    private static String getErrorText(int errorCode) {
        switch (errorCode) {
            case SpeechRecognizer.ERROR_AUDIO: return "音频录制错误 (ERROR_AUDIO)";
            case SpeechRecognizer.ERROR_CLIENT: return "客户端错误 (ERROR_CLIENT)";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "未授予录音权限 (ERROR_INSUFFICIENT_PERMISSIONS)";
            case SpeechRecognizer.ERROR_NETWORK: return "网络错误 (ERROR_NETWORK)";
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "网络超时 (ERROR_NETWORK_TIMEOUT)";
            case SpeechRecognizer.ERROR_NO_MATCH: return "未匹配到语音 (ERROR_NO_MATCH)";
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: return "识别引擎忙 (ERROR_RECOGNIZER_BUSY)";
            case SpeechRecognizer.ERROR_SERVER: return "服务端错误 (ERROR_SERVER)";
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: return "未检测到说话 (ERROR_SPEECH_TIMEOUT)";
            default: return "未知错误 (" + errorCode + ")";
        }
    }

    // ==================== 状态查询 JSON ====================

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
        sb.append("\"isSpeaking\":").append(isSpeaking());
        sb.append("}");
        return sb.toString();
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    public void destroy() {
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
                } catch (Throwable ignored) {}
            }
        });
    }
}
