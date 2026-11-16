package com.deepseek.harness;

import android.content.Context;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 长按说话：录 PCM 成 WAV，再交给官方 ASR 换成文字。
 *
 * 为什么不用 SpeechRecognizer：这台机器的 ROM 没有可用的系统语音识别服务，
 * isRecognitionAvailable() 还会给假阳性，真调起来必然空转。既然录音权限和
 * AudioRecord 都验过能用，就把这一段自己接管，识别交给云端。
 */
public class VoiceCapture {

    public interface Callback {
        /** 麦克风已经开着，可以提示用户说话了。 */
        void onReady();

        /** 识别出的文字；空串表示录到了但没听出内容。 */
        void onText(String text);

        void onError(String message);
    }

    private static final String TAG = "DSH-VoiceCapture";
    private static final int RATE = 16000;
    private static final int MAX_SECONDS = 60;
    private static final String ASR_URL = "https://api.deepseek.com/v1/tools/asr";
    /** 短于这个长度基本是误触，直接当没听到。 */
    private static final int MIN_PCM_BYTES = 3200;

    private final Context context;
    private final Callback callback;

    private AudioRecord recorder;
    private Thread worker;
    private volatile boolean running = false;
    private File outputFile;

    public VoiceCapture(Context context, Callback callback) {
        this.context = context.getApplicationContext();
        this.callback = callback;
    }

    public boolean isRunning() {
        return running;
    }

    /** 开录；重复调用会被忽略，避免两次长按叠出两条线程。 */
    public void start() {
        if (running) return;
        try {
            int minBuf = AudioRecord.getMinBufferSize(
                    RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minBuf <= 0) {
                callback.onError("麦克风不支持 16kHz 单声道录音");
                return;
            }
            int bufBytes = Math.max(minBuf * 4, 8192);
            recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes);
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                releaseRecorder();
                callback.onError("麦克风初始化失败");
                return;
            }

            File dir = new File(context.getCacheDir(), "voice");
            if (!dir.exists() && !dir.mkdirs()) {
                releaseRecorder();
                callback.onError("无法创建录音目录");
                return;
            }
            outputFile = new File(dir, "rec-" + System.currentTimeMillis() + ".wav");

            running = true;
            worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    recordLoop();
                }
            }, "dsh-voice-capture");
            worker.start();
        } catch (Throwable t) {
            running = false;
            releaseRecorder();
            callback.onError("无法开始录音：" + t.getMessage());
        }
    }

    /** 松手：停录，剩下的收尾与转写交给录音线程自己走完。 */
    public void stop() {
        running = false;
    }

    private void recordLoop() {
        ByteArrayOutputStream pcm = new ByteArrayOutputStream(RATE * 2 * 8);
        byte[] buf = new byte[3200];
        boolean started = false;
        try {
            recorder.startRecording();
            started = true;
            callback.onReady();
            int limit = RATE * 2 * MAX_SECONDS;
            while (running) {
                int n = recorder.read(buf, 0, buf.length);
                if (n > 0) {
                    pcm.write(buf, 0, n);
                    if (pcm.size() >= limit) break;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "record loop failed: " + t);
        } finally {
            if (started) {
                try { recorder.stop(); } catch (Throwable ignored) {}
            }
            releaseRecorder();
        }

        byte[] data = pcm.toByteArray();
        if (data.length < MIN_PCM_BYTES) {
            callback.onText("");
            return;
        }
        try {
            writeWav(outputFile, data);
        } catch (Throwable t) {
            callback.onError("保存录音失败：" + t.getMessage());
            return;
        }
        transcribe(outputFile);
    }

    private void releaseRecorder() {
        try {
            if (recorder != null) recorder.release();
        } catch (Throwable ignored) {
        } finally {
            recorder = null;
        }
    }

    /** 把 WAV 发给官方 ASR；失败要把话说清楚，别让用户以为是自己没说话。 */
    private void transcribe(File wav) {
        String key = readApiKey();
        if (key.isEmpty()) {
            callback.onError("未配置 API Key，无法转文字");
            return;
        }
        String boundary = "----dshvoice" + System.currentTimeMillis();
        HttpURLConnection conn = null;
        try {
            URL url = new URL(ASR_URL);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(90000);
            conn.setRequestProperty("Authorization", "Bearer " + key);
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);

            OutputStream out = conn.getOutputStream();
            try {
                writeAscii(out, "--" + boundary + "\r\n");
                writeAscii(out, "Content-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\n");
                writeAscii(out, "Content-Type: audio/wav\r\n\r\n");
                FileInputStream in = new FileInputStream(wav);
                try {
                    byte[] chunk = new byte[8192];
                    int n;
                    while ((n = in.read(chunk)) > 0) out.write(chunk, 0, n);
                } finally {
                    in.close();
                }
                writeAscii(out, "\r\n--" + boundary + "--\r\n");
                out.flush();
            } finally {
                out.close();
            }

            int code = conn.getResponseCode();
            String body = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());
            if (code != 200) {
                callback.onError("识别失败 HTTP " + code + "：" + shorten(body));
                return;
            }
            String text = extractJsonString(body, "text");
            callback.onText(text == null ? "" : text.trim());
        } catch (Throwable t) {
            callback.onError("识别请求出错：" + t.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 官方 key 在凭证文件里是明文；环境变量优先，方便临时换。 */
    private String readApiKey() {
        String env = System.getenv("DEEPSEEK_API_KEY");
        if (env != null && !env.trim().isEmpty()) return env.trim();
        String[] candidates = {
                "/data/user/0/com.deepseek.harness/files/payload/dshhome/.credentials.yaml",
                "/data/data/com.deepseek.harness/files/payload/dshhome/.credentials.yaml",
        };
        for (String path : candidates) {
            try {
                File f = new File(path);
                if (!f.isFile()) continue;
                String all = readAll(new FileInputStream(f));
                int at = all.indexOf("DEEPSEEK_API_KEY:");
                if (at < 0) continue;
                String rest = all.substring(at + "DEEPSEEK_API_KEY:".length());
                int end = rest.indexOf('\n');
                if (end >= 0) rest = rest.substring(0, end);
                rest = rest.trim().replace("\"", "").replace("'", "");
                if (!rest.isEmpty()) return rest;
            } catch (Throwable ignored) {
            }
        }
        return "";
    }

    // ==================== 小工具 ====================

    private static void writeAscii(OutputStream out, String s) throws Exception {
        out.write(s.getBytes("UTF-8"));
    }

    private static String readAll(java.io.InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try {
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        } finally {
            in.close();
        }
        return new String(buf.toByteArray(), "UTF-8");
    }

    /** 只取顶层 text 字段，够用且不必引入 JSON 库。 */
    private static String extractJsonString(String json, String field) {
        if (json == null) return null;
        String needle = "\"" + field + "\"";
        int at = json.indexOf(needle);
        if (at < 0) return null;
        int colon = json.indexOf(':', at + needle.length());
        if (colon < 0) return null;
        int q1 = json.indexOf('"', colon + 1);
        if (q1 < 0) return null;
        StringBuilder sb = new StringBuilder();
        for (int i = q1 + 1; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == '\\' && i + 1 < json.length()) {
                char nx = json.charAt(++i);
                switch (nx) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case '"': sb.append('"'); break;
                    case '\\': sb.append('\\'); break;
                    case 'u':
                        if (i + 4 < json.length()) {
                            try {
                                sb.append((char) Integer.parseInt(json.substring(i + 1, i + 5), 16));
                                i += 4;
                            } catch (Throwable ignored) {
                            }
                        }
                        break;
                    default: sb.append(nx);
                }
            } else if (c == '"') {
                return sb.toString();
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    private static String shorten(String s) {
        if (s == null) return "";
        return s.length() > 160 ? s.substring(0, 160) : s;
    }

    private static void writeWav(File f, byte[] pcm) throws Exception {
        File parent = f.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();
        int dataLen = pcm.length;
        ByteArrayOutputStream h = new ByteArrayOutputStream(44);
        h.write("RIFF".getBytes("US-ASCII"));
        h.write(le32(36 + dataLen));
        h.write("WAVE".getBytes("US-ASCII"));
        h.write("fmt ".getBytes("US-ASCII"));
        h.write(le32(16));
        h.write(le16(1));
        h.write(le16(1));
        h.write(le32(RATE));
        h.write(le32(RATE * 2));
        h.write(le16(2));
        h.write(le16(16));
        h.write("data".getBytes("US-ASCII"));
        h.write(le32(dataLen));

        FileOutputStream fos = new FileOutputStream(f);
        try {
            fos.write(h.toByteArray());
            fos.write(pcm);
            fos.flush();
        } finally {
            fos.close();
        }
    }

    private static byte[] le32(int v) {
        return new byte[]{(byte) v, (byte) (v >> 8), (byte) (v >> 16), (byte) (v >> 24)};
    }

    private static byte[] le16(int v) {
        return new byte[]{(byte) v, (byte) (v >> 8)};
    }
}
