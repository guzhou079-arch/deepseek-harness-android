package com.deepseek.harness.vscreen;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URLDecoder;

/**
 * 本地环回桥（3081 / 3181 / 8999）的共享鉴权闸门。
 *
 * 为什么需要它：三个桥都只绑 127.0.0.1，但 loopback 对**同机任意进程**可见 ——
 * 任何 App 都能 curl 127.0.0.1:3181/notifications 把最近 50 条通知读走，
 * 或打 3081/clipboard 读写剪贴板、3081/shell 以 shell 身份执行命令。
 * 浏览器跨站那一路由 LocalHttpFence 挡住（Host/Origin/Referer/Sec-Fetch），
 * 但同机原生 App 不带这些头，fence 按"原生调用"放行 —— 只能靠共享密钥。
 *
 * 密钥 = dsh_prefs 里的 local_token：App 首次启动用 SecureRandom 生成 16 字节，
 * 并随引擎 env（APP_LOCAL_TOKEN）交给 node 侧。只有本应用进程树和 root shell 拿得到；
 * 普通第三方 App 读不到 App 私有目录，也拿不到这个 env。
 *
 * 对外契约（任一命中即可）：
 *   1) 请求头 X-DSH-Token: <token>
 *   2) 请求行 query 里的 token=<token>
 *   3) JSON body 里的 {"token":"<token>"}（/shell 与 /lan 的旧写法，保持兼容）
 */
public final class LocalBridgeAuth {
    public static final String PREFS = "dsh_prefs";
    public static final String KEY = "local_token";
    public static final String HEADER = "x-dsh-token";

    private LocalBridgeAuth() {}

    /** 读（必要时生成）共享密钥。与 MainActivity/ScheduleExecutor 历史上各自的 localToken() 等价。 */
    public static String token(Context ctx) {
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String t = sp.getString(KEY, "");
            if (t == null || t.length() < 16) {
                byte[] b = new byte[16];
                new java.security.SecureRandom().nextBytes(b);
                StringBuilder sb = new StringBuilder(32);
                for (int i = 0; i < b.length; i++) sb.append(String.format("%02x", b[i]));
                t = sb.toString();
                sp.edit().putString(KEY, t).apply();
            }
            return t;
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 从「已读好的原始请求头」里取 token：优先 X-DSH-Token，其次请求行 query 的 token=。
     * 不消费输入流 —— 调用方仍按原样读 body。
     */
    public static String fromHeader(String rawHead) {
        if (rawHead == null) return "";
        String[] lines = rawHead.split("\r\n");
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0 && HEADER.equalsIgnoreCase(lines[i].substring(0, colon).trim())) {
                String v = lines[i].substring(colon + 1).trim();
                if (v.length() > 0) return v;
            }
        }
        if (lines.length > 0) {
            String requestLine = lines[0];
            int sp1 = requestLine.indexOf(' ');
            int sp2 = sp1 > 0 ? requestLine.indexOf(' ', sp1 + 1) : -1;
            if (sp2 > sp1) {
                String target = requestLine.substring(sp1 + 1, sp2);
                int q = target.indexOf('?');
                if (q >= 0) {
                    String query = target.substring(q + 1);
                    for (String pair : query.split("&")) {
                        int eq = pair.indexOf('=');
                        if (eq > 0 && "token".equals(pair.substring(0, eq))) {
                            try {
                                return URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                            } catch (Exception ignored) {
                                return pair.substring(eq + 1);
                            }
                        }
                    }
                }
            }
        }
        return "";
    }

    /** body 里的 "token":"…"（兼容 /shell 与 /lan 的旧写法）。 */
    public static String fromBody(String body) {
        if (body == null || body.length() == 0) return "";
        String key = "\"token\"";
        int at = body.indexOf(key);
        if (at < 0) return "";
        int colon = body.indexOf(':', at + key.length());
        if (colon < 0) return "";
        int i = colon + 1;
        while (i < body.length() && Character.isWhitespace(body.charAt(i))) i++;
        if (i >= body.length() || body.charAt(i) != '"') return "";
        StringBuilder sb = new StringBuilder();
        for (int j = i + 1; j < body.length(); j++) {
            char c = body.charAt(j);
            if (c == '\\' && j + 1 < body.length()) {
                sb.append(body.charAt(++j));
                continue;
            }
            if (c == '"') break;
            sb.append(c);
        }
        return sb.toString();
    }

    /** 纯字符串判据（不依赖 Context）：供 app_process 起的虚拟屏 core 用，它拿不到 SharedPreferences。 */
    public static boolean matches(String expected, String rawHead, String body) {
        if (expected == null || expected.length() < 16) return false;
        if (expected.equals(fromHeader(rawHead))) return true;
        return expected.equals(fromBody(body));
    }

    /** 全桥统一判据：密钥非空且命中任一位置。 */
    public static boolean authorized(String rawHead, String body, Context ctx) {
        return matches(token(ctx), rawHead, body);
    }

    /** 统一的 401 响应（JSON，便于调用方看日志定位）。 */
    public static void reject(OutputStream output) throws IOException {
        byte[] body = ("{\"ok\":false,\"error\":\"unauthorized: 本地桥需要 X-DSH-Token（本应用引擎与插件由 App 自动携带）；"
                + "同机其他应用无权访问\"}").getBytes("UTF-8");
        output.write(("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: "
                + body.length + "\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
        output.write(body);
        output.flush();
    }
}
