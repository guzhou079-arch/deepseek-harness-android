package com.deepseek.harness;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.widget.Toast;
import org.json.JSONObject;

/** Trusted chat-only bridge. Shares and speech become drafts; neither path sends a message. */
final class DraftInputBridge {
    static final int REQ_MIC = 202;
    interface Guard { boolean allowed(); }
    private final Activity activity;
    private final Guard guard;
    private volatile String token = java.util.UUID.randomUUID().toString() + java.util.UUID.randomUUID().toString();
    private boolean admitted(String credential) { return guard.allowed() && token.equals(credential); }
    String bootstrap() { return "window.__DSH_INPUT_TOKEN=" + JSONObject.quote(token) + ";"; }
    void navigation() { synchronized (lock) { token = java.util.UUID.randomUUID().toString() + java.util.UUID.randomUUID().toString(); cancel(); } }
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Object lock = new Object();
    private String voiceId = "", state = "idle", text = "", error = "";
    private VoiceManager.VoiceCallback owner;
    private boolean foreground = true, grantedPending = false;

    DraftInputBridge(Activity activity, Guard guard) { this.activity = activity; this.guard = guard; }
    private String failure(String message) {
        try { return new JSONObject().put("ok", false).put("error", message == null ? "操作失败" : message).toString(); }
        catch (Exception ignored) { return "{\"ok\":false}"; }
    }
    @JavascriptInterface public String shareState(String credential) {
        if (!admitted(credential)) return failure("untrusted document");
        try { return new ShareInbox(activity).snapshot().toString(); } catch (Exception e) { return failure(e.getMessage()); }
    }
    @JavascriptInterface public String shareChunk(String credential, String id, int index, long offset) {
        if (!admitted(credential)) return failure("untrusted document");
        try { return new ShareInbox(activity).chunk(id, index, offset).toString(); } catch (Exception e) { return failure(e.getMessage()); }
    }
    @JavascriptInterface public String shareAck(String credential, String id) {
        if (!admitted(credential)) return failure("untrusted document");
        try { new ShareInbox(activity).acknowledge(id); return "{\"ok\":true}"; } catch (Exception e) { return failure(e.getMessage()); }
    }
    @JavascriptInterface public String voiceState(String credential) {
        if (!admitted(credential)) return failure("untrusted document");
        synchronized (lock) { try {
            return new JSONObject().put("ok", true).put("id", voiceId).put("state", state)
                    .put("text", text).put("error", error).toString();
        } catch (Exception e) { return failure(e.getMessage()); } }
    }
    @JavascriptInterface public String voiceAct(final String credential, final String action, final String id) {
        if (!admitted(credential)) return failure("untrusted document");
        if (id == null || !id.matches("[A-Za-z0-9_-]{1,120}") ||
                !("start".equals(action) || "stop".equals(action) || "cancel".equals(action))) return failure("无效听写操作");
        synchronized (lock) {
            if ("start".equals(action)) {
                if (owner != null || java.util.Arrays.asList("permission", "starting", "listening", "recording", "recognizing").contains(state)) return failure("已有听写正在进行");
                voiceId = id; state = "starting"; text = ""; error = "";
            }
        }
        ui.post(new Runnable() { public void run() {
            if (!admitted(credential)) return;
            synchronized (lock) {
                if ("start".equals(action)) {
                    if (!id.equals(voiceId) || !"starting".equals(state)) return;
                    if (!foreground) { voiceId = id; state = "error"; error = "请在应用前台开始听写"; return; }
                    if (owner != null || "permission".equals(state)) return;
                    voiceId = id; state = "starting"; text = ""; error = ""; grantedPending = false;
                    if (Build.VERSION.SDK_INT >= 23 && activity.checkSelfPermission("android.permission.RECORD_AUDIO") != PackageManager.PERMISSION_GRANTED) {
                        state = "permission";
                        activity.requestPermissions(new String[]{"android.permission.RECORD_AUDIO"}, REQ_MIC);
                    } else begin(id);
                } else if (id.equals(voiceId)) {
                    if ("cancel".equals(action)) cancel();
                    else if (owner != null) {
                        state = "recognizing"; VoiceManager.get(activity).stopDictation(owner);
                    }
                }
            }
        }});
        return "{\"ok\":true}";
    }
    private void begin(final String id) {
        if (!foreground || !guard.allowed() || !id.equals(voiceId)) { cancel(); return; }
        state = "starting";
        final VoiceManager.VoiceCallback callback = new VoiceManager.VoiceCallback() {
            private boolean current() { return id.equals(voiceId) && owner == this; }
            public void onStateChange(String next, String message) {
                synchronized (lock) { if (current()) { state = next; if ("cancelled".equals(next)) owner = null; } }
            }
            public void onResult(String value, boolean isFinal) {
                synchronized (lock) {
                    if (!current()) return;
                    text = value == null ? "" : value;
                    if (isFinal) { state = text.isEmpty() ? "empty" : "final"; owner = null; }
                }
            }
            public void onError(String message) {
                synchronized (lock) { if (current()) { error = message == null ? "无法启动听写" : message; state = "error"; owner = null; } }
            }
        };
        owner = callback; VoiceManager.get(activity).startDictation(callback);
    }
    void permissionResult(int[] results) {
        synchronized (lock) {
            if (!"permission".equals(state)) return;
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                if (foreground) begin(voiceId); else grantedPending = true;
            } else { state = "error"; error = "麦克风权限未授予"; }
        }
    }
    private void cancel() {
        VoiceManager.VoiceCallback callback = owner; owner = null; grantedPending = false; state = "cancelled";
        if (callback != null) VoiceManager.get(activity).cancelDictation(callback);
    }
    void resume() {
        synchronized (lock) { foreground = true; if (grantedPending) { grantedPending = false; begin(voiceId); } }
    }
    void pause() {
        synchronized (lock) { foreground = false; if (owner != null || "starting".equals(state)) cancel(); }
    }
    void destroy() { synchronized (lock) { foreground = false; cancel(); } }
    void accept(Intent incoming) {
        if (incoming == null || incoming.getBooleanExtra("dsh.shareHandled", false)) return;
        String action = incoming.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        final Intent copy = new Intent(incoming); incoming.putExtra("dsh.shareHandled", true);
        new Thread(new Runnable() { public void run() {
            try {
                final JSONObject item = new ShareInbox(activity).enqueue(copy);
                final String archive = item == null ? "" : item.optString("archive", "");
                ui.post(new Runnable() { public void run() {
                    // 说清去哪儿找：分享卡片只在聊天框里，若他停在控制台/设置页，只有这条 toast 告诉他东西在哪。
                    Toast.makeText(activity, archive.isEmpty()
                            ? "分享已接收，在聊天框选择加入草稿"
                            : "分享已接收，副本存到 " + archive + "；聊天框里可加入草稿",
                            Toast.LENGTH_LONG).show();
                }});
            } catch (final Exception e) {
                ui.post(new Runnable() { public void run() { Toast.makeText(activity, "分享接收失败: " + e.getMessage(), Toast.LENGTH_LONG).show(); }});
            }
        }}, "share-inbox").start();
    }
}
