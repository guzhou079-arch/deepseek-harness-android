package com.deepseek.harness;

import android.content.Context;
import android.content.SharedPreferences;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.nfc.tech.NdefFormatable;
import android.util.Base64;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Arrays;

/**
 * NFC 读卡中转站（v1.16）。
 *
 * 为什么需要它：读 NFC 标签必须由**前台 Activity** 主动开 reader mode
 * （{@link NfcAdapter#enableReaderMode} 只接受 Activity），而 AI 的插件走的是
 * AccessibilityService 上的本地 HTTP 桥（127.0.0.1:3181）。两者同一个进程，
 * 于是用这个类做进程内中转：MainActivity 把读到的标签塞进来，桥把数据回给插件。
 *
 * 数据流：
 *   用户贴卡 → MainActivity.onTagDiscovered → {@link #recordTag} →
 *   （内存 + files/nfc/last.json + prefs） → 插件 GET /nfc-last 取走
 *
 * 安全设计（不给用户添乱）：
 *  - reader mode **默认关闭**，必须显式 arm（AI 调 android_nfc_arm，或用户自己要求）；
 *  - arm 有 10 分钟 TTL，超时自动失效，避免长期抢占 NFC
 *    （否则用户刷公交卡/门禁会被本 App 截胡）；
 *  - App 一退到后台就 disableReaderMode，只有 App 在前台时才可能读卡。
 *
 * 兼容性约定（与项目其它 Java 一致）：javac -bootclasspath android.jar，
 * 不用 lambda / 方法引用 / try-with-resources，全部显式匿名类 + finally close。
 */
public final class NfcStore {

    private static final String TAG = "dsh-nfc";
    private static final String PREFS = "dsh_prefs";
    private static final String KEY_ARMED_AT = "nfc_armed_at";
    private static final String KEY_LAST_JSON = "nfc_last_json";
    /** arm 有效期：10 分钟。到点自动失效（statusJson 会报 armed=false）。 */
    private static final long ARM_TTL_MS = 10L * 60L * 1000L;
    /** 历史里最多保留多少条（内存 + 落盘）。 */
    private static final int MAX_HISTORY = 20;
    /** 大 payload 的 base64 上限（字符数），超出截断并标记，避免把工具结果撑爆。 */
    private static final int MAX_PAYLOAD_B64 = 4096;

    /** arm 状态变化时回调（MainActivity 用它即时开/关 reader mode）。 */
    public interface ArmListener {
        void onArmChanged(boolean armed);
    }

    private static final Object LOCK = new Object();
    private static final ArrayList<String> HISTORY = new ArrayList<String>();

    private static volatile ArmListener listener = null;
    /** 0 = 未待命；否则是 arm 时刻的 System.currentTimeMillis()。 */
    private static volatile long armedAt = 0L;
    /** reader mode 是否真的开着（由 MainActivity 上报）。 */
    private static volatile boolean readerActive = false;
    /** 本进程读到的标签序号，每读到一个 +1。 */
    private static volatile long seq = 0L;
    /** 最近一次标签的完整 JSON（null = 还没读到过）。 */
    private static volatile String lastJson = null;
    private static volatile boolean initialized = false;

    private NfcStore() {}

    // ============================ arm / 状态 ============================

    /** 幂等初始化：从 prefs 恢复 armedAt / lastJson。MainActivity.onCreate 调一次即可。 */
    static void init(Context ctx) {
        if (initialized) return;
        synchronized (LOCK) {
            if (initialized) return;
            try {
                SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                armedAt = p.getLong(KEY_ARMED_AT, 0L);
                lastJson = p.getString(KEY_LAST_JSON, null);
                if (!isArmedLocked()) armedAt = 0L; // 上次退出时已过 TTL：直接清掉
            } catch (Throwable t) {
                Log.w(TAG, "init failed", t);
            }
            initialized = true;
        }
    }

    private static boolean isArmedLocked() {
        long at = armedAt;
        return at > 0L && (System.currentTimeMillis() - at) < ARM_TTL_MS;
    }

    static boolean isArmed() {
        synchronized (LOCK) {
            return isArmedLocked();
        }
    }

    /** 剩余待命秒数（未待命返回 0）。 */
    static long armedLeftSec() {
        synchronized (LOCK) {
            if (!isArmedLocked()) return 0L;
            long left = ARM_TTL_MS - (System.currentTimeMillis() - armedAt);
            return left > 0L ? left / 1000L : 0L;
        }
    }

    static void setArmListener(ArmListener l) {
        listener = l;
    }

    static void setReaderActive(boolean v) {
        readerActive = v;
    }

    static boolean isReaderActive() {
        return readerActive;
    }

    static long currentSeq() {
        return seq;
    }

    /**
     * 开/关待命。返回最新状态 JSON。
     * 会落 prefs（进程被杀后重启仍待命）+ 通知 listener（让前台 Activity 立刻开关 reader mode）。
     */
    static JSONObject arm(Context ctx, boolean on) throws Exception {
        init(ctx);
        synchronized (LOCK) {
            armedAt = on ? System.currentTimeMillis() : 0L;
            try {
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putLong(KEY_ARMED_AT, armedAt).apply();
            } catch (Throwable t) {
                Log.w(TAG, "persist armedAt failed", t);
            }
        }
        ArmListener l = listener;
        if (l != null) {
            try {
                l.onArmChanged(on);
            } catch (Throwable t) {
                Log.w(TAG, "arm listener failed", t);
            }
        }
        return statusJson(ctx);
    }

    // ============================ 读卡 ============================

    /**
     * 解析一张标签并记录。由 MainActivity 的 ReaderCallback 在**后台线程**调用
     * （connect/NDEF 读取是阻塞 IO，绝不能放主线程）。
     */
    static void recordTag(Context ctx, Tag tag) {
        if (tag == null) return;
        init(ctx);
        try {
            JSONObject o = tagToJson(tag);
            synchronized (LOCK) {
                seq++;
                o.put("seq", seq);
                lastJson = o.toString();
                HISTORY.add(0, lastJson);
                while (HISTORY.size() > MAX_HISTORY) HISTORY.remove(HISTORY.size() - 1);
            }
            persist(ctx);
            Log.i(TAG, "tag recorded: " + o.optString("idHex", "?"));
        } catch (Throwable t) {
            Log.w(TAG, "recordTag failed", t);
            try {
                JSONObject e = new JSONObject();
                synchronized (LOCK) {
                    seq++;
                    e.put("seq", seq);
                }
                e.put("at", System.currentTimeMillis());
                e.put("parseError", String.valueOf(t.getMessage()));
                synchronized (LOCK) {
                    lastJson = e.toString();
                    HISTORY.add(0, lastJson);
                    while (HISTORY.size() > MAX_HISTORY) HISTORY.remove(HISTORY.size() - 1);
                }
                persist(ctx);
            } catch (Throwable ignored) {
            }
        }
    }

    /** 一张标签 → JSON（UID / 技术列表 / NDEF 记录全文）。 */
    private static JSONObject tagToJson(Tag tag) throws Exception {
        JSONObject o = new JSONObject();
        o.put("at", System.currentTimeMillis());

        byte[] id = tag.getId();
        o.put("idHex", hex(id));
        o.put("idReversedHex", reverseHex(id));

        String[] tech = tag.getTechList();
        JSONArray ta = new JSONArray();
        if (tech != null) {
            for (int i = 0; i < tech.length; i++) {
                String t = tech[i];
                if (t == null) continue;
                int dot = t.lastIndexOf('.');
                ta.put(dot >= 0 ? t.substring(dot + 1) : t);
            }
        }
        o.put("tech", ta);

        // NDEF：唯一能"读出内容"的路子（URI/文本/vCard 等都在这里）。
        Ndef ndef = null;
        try {
            ndef = Ndef.get(tag);
        } catch (Throwable t) {
            o.put("ndefError", "get(Ndef) failed: " + t.getMessage());
        }
        if (ndef != null) {
            try {
                ndef.connect();
                o.put("ndefWritable", ndef.isWritable());
                o.put("ndefMaxSize", ndef.getMaxSize());
                NdefMessage msg = ndef.getNdefMessage();
                if (msg == null) {
                    o.put("ndefError", "标签已格式化但没有 NDEF 消息");
                } else {
                    JSONObject nm = parseNdef(msg);
                    o.put("ndef", nm);
                    String text = firstOf(nm, "text");
                    String uri = firstOf(nm, "uri");
                    if (text != null) o.put("text", text);
                    if (uri != null) o.put("uri", uri);
                }
            } catch (Throwable t) {
                o.put("ndefError", String.valueOf(t.getMessage()));
            } finally {
                try { ndef.close(); } catch (Throwable ignored) {}
            }
        } else {
            try {
                if (NdefFormatable.get(tag) != null) o.put("ndefFormatable", true);
            } catch (Throwable ignored) {}
            if (!o.has("ndefError")) o.put("ndefError", "标签不是 NDEF 格式（只有 UID/技术列表可用）");
        }
        return o;
    }

    private static String firstOf(JSONObject ndef, String key) {
        try {
            JSONArray recs = ndef.optJSONArray("records");
            if (recs == null) return null;
            for (int i = 0; i < recs.length(); i++) {
                JSONObject r = recs.optJSONObject(i);
                if (r == null) continue;
                String v = r.optString(key, "");
                if (v.length() > 0) return v;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    private static JSONObject parseNdef(NdefMessage msg) throws Exception {
        JSONObject o = new JSONObject();
        NdefRecord[] recs = msg.getRecords();
        o.put("recordCount", recs == null ? 0 : recs.length);
        byte[] raw = msg.toByteArray();
        o.put("size", raw == null ? 0 : raw.length);
        JSONArray arr = new JSONArray();
        if (recs != null) {
            for (int i = 0; i < recs.length; i++) arr.put(parseRecord(recs[i]));
        }
        o.put("records", arr);
        return o;
    }

    /** URI 前缀缩写表（NFC Forum RTD-URI 规范）。 */
    private static final String[] URI_PREFIXES = {
        "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
        "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://",
        "nfs://", "ftp://", "dav://", "news:", "telnet://", "imap:", "rtsp://",
        "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://",
        "btgoep://", "tcpobex://", "irdaobex://", "file://", "urn:epc:id:",
        "urn:epc:tag:", "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:"
    };

    private static JSONObject parseRecord(NdefRecord r) throws Exception {
        JSONObject o = new JSONObject();
        short tnf = r.getTnf();
        o.put("tnf", (int) tnf);
        o.put("tnfName", tnfName(tnf));

        byte[] type = r.getType();
        byte[] payload = r.getPayload();
        if (type == null) type = new byte[0];
        if (payload == null) payload = new byte[0];
        String typeStr = new String(type, Charset.forName("US-ASCII"));
        o.put("type", typeStr);
        o.put("typeHex", hex(type));
        byte[] rid = r.getId();
        if (rid != null && rid.length > 0) o.put("idHex", hex(rid));

        String text = null;
        String uri = null;
        String mime = null;
        String lang = null;

        if (tnf == NdefRecord.TNF_WELL_KNOWN && Arrays.equals(type, NdefRecord.RTD_TEXT)) {
            if (payload.length >= 1) {
                int status = payload[0] & 0xFF;
                int langLen = status & 0x3F;
                boolean utf16 = (status & 0x80) != 0;
                if (langLen + 1 <= payload.length) {
                    lang = new String(payload, 1, langLen, Charset.forName("US-ASCII"));
                    int off = 1 + langLen;
                    int len = payload.length - off;
                    text = new String(payload, off, len,
                            Charset.forName(utf16 ? "UTF-16" : "UTF-8"));
                }
            }
        } else if (tnf == NdefRecord.TNF_WELL_KNOWN && Arrays.equals(type, NdefRecord.RTD_URI)) {
            if (payload.length >= 1) {
                int p = payload[0] & 0xFF;
                String prefix = p < URI_PREFIXES.length ? URI_PREFIXES[p] : "";
                uri = prefix + new String(payload, 1, payload.length - 1, Charset.forName("UTF-8"));
            }
        } else if (tnf == NdefRecord.TNF_ABSOLUTE_URI) {
            uri = new String(type, Charset.forName("UTF-8"));
        } else if (tnf == NdefRecord.TNF_MIME_MEDIA) {
            mime = typeStr;
            if (typeStr.startsWith("text/") || typeStr.indexOf("json") >= 0
                    || typeStr.indexOf("xml") >= 0) {
                text = new String(payload, Charset.forName("UTF-8"));
            }
        } else if (tnf == NdefRecord.TNF_EXTERNAL_TYPE) {
            // 外部类型（如 android.com:pkg）：payload 约定是 UTF-8
            text = new String(payload, Charset.forName("UTF-8"));
        }
        if (lang != null) o.put("lang", lang);
        if (text != null) o.put("text", text);
        if (uri != null) o.put("uri", uri);
        if (mime != null) o.put("mime", mime);

        o.put("payloadBytes", payload.length);
        if (payload.length > 0) {
            String b64 = Base64.encodeToString(payload, Base64.NO_WRAP);
            if (b64.length() > MAX_PAYLOAD_B64) {
                b64 = b64.substring(0, MAX_PAYLOAD_B64);
                o.put("payloadTruncated", true);
            }
            o.put("payloadBase64", b64);
        }
        return o;
    }

    private static String tnfName(short tnf) {
        switch (tnf) {
            case NdefRecord.TNF_EMPTY: return "EMPTY";
            case NdefRecord.TNF_WELL_KNOWN: return "WELL_KNOWN";
            case NdefRecord.TNF_MIME_MEDIA: return "MIME";
            case NdefRecord.TNF_ABSOLUTE_URI: return "ABSOLUTE_URI";
            case NdefRecord.TNF_EXTERNAL_TYPE: return "EXTERNAL";
            case NdefRecord.TNF_UNKNOWN: return "UNKNOWN";
            case NdefRecord.TNF_UNCHANGED: return "UNCHANGED";
            default: return "TNF_" + tnf;
        }
    }

    private static String hex(byte[] b) {
        if (b == null) return "";
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (int i = 0; i < b.length; i++) {
            int v = b[i] & 0xFF;
            if (v < 16) sb.append('0');
            sb.append(Integer.toHexString(v));
        }
        return sb.toString();
    }

    /** 反序 UID：部分门禁/读卡器展示的就是反序值，顺手给出来省得用户换算。 */
    private static String reverseHex(byte[] b) {
        if (b == null || b.length == 0) return "";
        byte[] r = new byte[b.length];
        for (int i = 0; i < b.length; i++) r[i] = b[b.length - 1 - i];
        return hex(r);
    }

    // ============================ 对外 JSON ============================

    /** 桥 /nfc-status 用。 */
    static JSONObject statusJson(Context ctx) throws Exception {
        init(ctx);
        JSONObject o = new JSONObject();
        o.put("ok", true);
        boolean hw = false;
        boolean enabled = false;
        try {
            NfcAdapter a = NfcAdapter.getDefaultAdapter(ctx);
            hw = a != null;
            enabled = a != null && a.isEnabled();
        } catch (Throwable t) {
            Log.w(TAG, "adapter query failed", t);
        }
        boolean armed = isArmed();
        o.put("hardware", hw);
        o.put("enabled", enabled);
        o.put("armed", armed);
        o.put("armedLeftSec", armedLeftSec());
        o.put("readerActive", readerActive);
        o.put("appForeground", MainActivity.appForeground);
        o.put("count", seq);
        String last = lastJson;
        if (last != null) {
            try {
                JSONObject l = new JSONObject(last);
                o.put("lastIdHex", l.optString("idHex", ""));
                o.put("lastAt", l.optLong("at", 0L));
            } catch (Throwable ignored) {}
        }
        o.put("hint", hintFor(hw, enabled, armed, readerActive));
        return o;
    }

    private static String hintFor(boolean hw, boolean enabled, boolean armed, boolean active) {
        if (!hw) return "本机没有 NFC 硬件，读不了标签。";
        if (!enabled) return "系统 NFC 开关是关的：请用户下拉通知栏打开 NFC。";
        if (!armed) return "未待命：先调 android_nfc_arm 开启待命（10 分钟内有效），再让用户贴卡。";
        if (!MainActivity.appForeground) {
            return "已待命，但 App 不在前台，reader mode 未激活：请用户切回 DeepSeek Harness 界面后再贴卡。";
        }
        if (!active) return "已待命但 reader mode 尚未生效：让用户切走再切回 App（触发 onResume）后重试。";
        return "reader mode 已激活，请用户把标签贴到手机背面（NFC 天线一般在机身上部），保持 1~2 秒。";
    }

    /** 桥 /nfc-last 用：sinceSeq < 0 表示"最近一次不管新旧"，否则只认 seq 更大的。 */
    static JSONObject lastJsonObj(long sinceSeq) throws Exception {
        JSONObject o = new JSONObject();
        o.put("ok", true);
        String last = lastJson;
        if (last == null) {
            o.put("has", false);
            o.put("count", seq);
            return o;
        }
        JSONObject t = new JSONObject(last);
        long s = t.optLong("seq", 0L);
        if (sinceSeq >= 0 && s <= sinceSeq) {
            o.put("has", false);
            o.put("count", seq);
            return o;
        }
        o.put("has", true);
        o.put("count", seq);
        o.put("tag", t);
        return o;
    }

    /** 桥 /nfc-history 用。 */
    static JSONArray historyJson() throws Exception {
        JSONArray arr = new JSONArray();
        synchronized (LOCK) {
            for (int i = 0; i < HISTORY.size(); i++) {
                try {
                    arr.put(new JSONObject(HISTORY.get(i)));
                } catch (Throwable ignored) {}
            }
        }
        return arr;
    }

    /** 桥 /nfc-clear 用：清空最近一次 + 历史（不动 arm 状态）。 */
    static JSONObject clearJson() throws Exception {
        synchronized (LOCK) {
            lastJson = null;
            HISTORY.clear();
        }
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("count", seq);
        return o;
    }

    // ============================ 落盘（排障用） ============================

    /**
     * 把最近一次标签 + 历史写到 files/nfc/ 下。
     * 桥是主通道，这里只是"桥没起来时还能捞数据"的兜底，也方便事后排障。
     */
    private static void persist(Context ctx) {
        try {
            File dir = new File(ctx.getFilesDir(), "nfc");
            if (!dir.exists() && !dir.mkdirs()) return;
            writeFile(new File(dir, "last.json"), lastJson == null ? "{}" : lastJson);
            writeFile(new File(dir, "history.json"), historyJson().toString(2));
            try {
                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putString(KEY_LAST_JSON, lastJson).apply();
            } catch (Throwable ignored) {}
        } catch (Throwable t) {
            Log.w(TAG, "persist failed", t);
        }
    }

    private static void writeFile(File f, String content) {
        FileOutputStream fos = null;
        OutputStreamWriter w = null;
        try {
            fos = new FileOutputStream(f);
            w = new OutputStreamWriter(fos, "UTF-8");
            w.write(content);
            w.flush();
        } catch (Throwable t) {
            Log.w(TAG, "write " + f.getName() + " failed", t);
        } finally {
            try { if (w != null) w.close(); } catch (Throwable ignored) {}
            try { if (fos != null) fos.close(); } catch (Throwable ignored) {}
        }
    }
}
