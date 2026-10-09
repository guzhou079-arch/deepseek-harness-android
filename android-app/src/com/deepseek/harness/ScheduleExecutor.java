package com.deepseek.harness;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 定时任务后台执行器（⑥ 全自动）：
 * 闹钟到点后由 AlarmReceiver 调用，**不依赖 Activity** ——
 * 直接定位引擎文件、启动 node、等 HTTP 就绪、调 DSH API 让 AI 自动执行任务。
 * 引擎已在运行时（3080 有响应）直接复用，不重复启动。
 */
public final class ScheduleExecutor {
    private static final String TAG = "ScheduleExecutor";
    private static final String REL_BINJS = "lib/node_modules/@deepseek-ai/dsh/lib/bin.js";

    private ScheduleExecutor() {}

    /** 引擎端口：按包名派生（v1.13）。旧实现三套都硬编码 3080 —— Lite/兼容版的定时任务
     *  会探测并连接到**正式版**的引擎上（跨版本串台，与 v1.11 修过的插件端口串台同源）。 */
    private static int enginePort(Context ctx) {
        try {
            String p = ctx.getPackageName();
            if (p != null) {
                if (p.endsWith(".beta")) return 3082;
                if (p.endsWith(".compat")) return 3084;
            }
        } catch (Throwable ignored) {}
        return 3080;
    }

    /** Shizuku 是否可用：判据与 MainActivity.shizukuAvailable() 保持一致（binder 活 + 已授权）。
     *  v1.14.3 之前这里被硬编码成 "0"，导致**定时任务拉起的引擎永远没有特权工具**。 */
    private static boolean shizukuAvailable() {
        try {
            if (!rikka.shizuku.Shizuku.pingBinder()) return false;
            return rikka.shizuku.Shizuku.checkSelfPermission()
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /** root(su) 是否可用：`su -c id` 输出含 uid=0。与 MainActivity.probeRoot() 同判据。 */
    private static boolean rootAvailable() {
        Process p = null;
        try {
            p = Runtime.getRuntime().exec(new String[]{"su", "-c", "id"});
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String line = r.readLine();
            try {
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroy();
                } else {
                    p.waitFor();
                }
            } catch (Throwable ignored) {}
            return line != null && line.contains("uid=0");
        } catch (Throwable t) {
            return false;
        } finally {
            try { if (p != null) p.destroy(); } catch (Throwable ignored) {}
        }
    }

    /** 本地特权路由 /shell 的鉴权令牌。
     *  与 MainActivity.localToken() **共用同一个 prefs key**：谁先跑谁生成，另一边随后读到的就是同一个值，
     *  因此定时任务拉起的引擎也能走 App 内嵌桥（而不是那条会被 ColorOS 查杀打断的 rish 兜底路）。 */
    private static String localToken(Context ctx) {
        try {
            android.content.SharedPreferences sp = ctx.getSharedPreferences("dsh_prefs", Context.MODE_PRIVATE);
            String t = sp.getString("local_token", "");
            if (t == null || t.length() < 16) {
                byte[] b = new byte[16];
                new java.security.SecureRandom().nextBytes(b);
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < b.length; i++) sb.append(String.format("%02x", b[i]));
                t = sb.toString();
                sp.edit().putString("local_token", t).apply();
            }
            return t;
        } catch (Throwable t) {
            return "";
        }
    }

    /** 执行一条定时任务（后台线程，调用方勿阻塞主线程）。 */
    public static void execute(Context ctx, String task) {
        if (task == null || task.isEmpty()) return;
        log(ctx, "开始执行任务: " + task);
        try {
            if (!engineReady(ctx)) {
                log(ctx, "引擎未运行，尝试启动…");
                if (!startEngine(ctx)) {
                    log(ctx, "引擎启动失败，无法自动执行任务");
                    return;
                }
            }
            // 等引擎完全就绪
            for (int i = 0; i < 30; i++) {
                if (engineReady(ctx)) break;
                Thread.sleep(1000);
            }
            if (!engineReady(ctx)) {
                log(ctx, "引擎 30 秒未就绪，放弃");
                return;
            }
            String sessionId = createSession(ctx);
            if (sessionId == null) {
                log(ctx, "创建会话失败（可能未配置 API Key）");
                return;
            }
            org.json.JSONObject promptResp = EngineRpc.call(new File(ctx.getFilesDir(), "dsh-web.log"),
                    enginePort(ctx), "session/prompt", EngineRpc.prompt(sessionId, task));
            boolean ok = promptResp.optBoolean("accepted", false);
            String summary = ok ? "任务已提交给 AI，执行结果请查看会话: " + task : "任务未被接收: " + task;
            log(ctx, summary);
            notifyResult(ctx, ok, summary);
        } catch (Throwable t) {
            String msg = "执行异常: " + t.getMessage();
            log(ctx, msg);
            notifyResult(ctx, false, msg);
        }
    }

    /** 定时任务结果通知（Kun 式回报：执行成功/失败都通知用户，点开进 App）。 */
    private static void notifyResult(Context ctx, boolean ok, String summary) {
        try {
            android.app.NotificationManager nm = (android.app.NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                android.app.NotificationChannel ch = new android.app.NotificationChannel("dsh_schedule", "定时任务",
                        android.app.NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("AI 设置的定时提醒与任务结果");
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(ctx, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
            android.app.PendingIntent pi = android.app.PendingIntent.getActivity(ctx, 0, open,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
            android.app.Notification.Builder b;
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                b = new android.app.Notification.Builder(ctx, "dsh_schedule");
            } else {
                b = new android.app.Notification.Builder(ctx);
            }
            String title = ok ? "定时任务已提交" : "定时任务提交失败";
            String text = summary != null && summary.length() > 200 ? summary.substring(0, 200) : summary;
            android.app.Notification n = b.setContentTitle(title)
                    .setContentText(text)
                    .setSmallIcon(R.drawable.ic_launcher)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            nm.notify(ok ? 9003 : 9004, n);
        } catch (Throwable ignored) {}
    }

    /** 引擎是否已在目标端口响应，且确认是 DSH 引擎。
     *  修复 v1.5.1：原来任意 HTTP 200-499 都算就绪，占位服务会被误判为"引擎就绪"。
     *  v1.13：0.1.5 起首页需要一次性 token —— 不带 token 返回 401 + 纯文本
     *  “dsh web authentication required…”，带有效 token 返回 303。两种都算“引擎在跑”。
     *  旧实现只认首页 HTML 的 <title>DeepSeek Harness</title> → 引擎在跑也判“未就绪”，
     *  定时任务于是又去拉起一个引擎（EADDRINUSE）。 */
    private static boolean engineReady(Context ctx) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://127.0.0.1:" + enginePort(ctx) + "/").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            c.setInstanceFollowRedirects(false);   // 303 即“token 有效”；跟随反而浪费 token
            int code = c.getResponseCode();
            if (code == 303 || code == 302) return true;
            if (code == 401) {
                InputStream e = null;
                try { e = c.getInputStream(); } catch (Throwable t) { e = c.getErrorStream(); }
                if (e == null) return false;
                ByteArrayOutputStream eb = new ByteArrayOutputStream();
                byte[] ebuf = new byte[2048];
                int er;
                while ((er = e.read(ebuf)) > 0 && eb.size() < 8192) eb.write(ebuf, 0, er);
                try { e.close(); } catch (Throwable ignored) {}
                return eb.toString("UTF-8").contains("dsh web authentication required");
            }
            if (code < 200 || code >= 500) return false;
            InputStream in = c.getInputStream();
            // v1.5.5 修复：首页约 14KB，<title> 在页面末尾（旧实现只读 4096 字节永远匹配不到）。
            // 读完整页（上限 256KB），与 MainActivity.isDshEngine 保持一致。
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int total = 0;
            int r;
            while ((r = in.read(chunk)) > 0 && total < 262144) {
                body.write(chunk, 0, r);
                total += r;
            }
            try { in.close(); } catch (Throwable ignored) {}
            return body.toString("UTF-8").contains("<title>DeepSeek Harness</title>");
        } catch (Throwable t) {
            return false;
        } finally {
            try { if (c != null) c.disconnect(); } catch (Throwable ignored) {}
        }
    }

    /** 启动 node 引擎（同 MainActivity.spawnNode 的环境变量；payload 必须已解压）。
     *  端口 = enginePort(ctx)，与主引擎换端口后保持一致。 */
    private static boolean startEngine(Context ctx) {
        try {
            File payload = new File(ctx.getFilesDir(), "payload");
            File node = new File(payload, "runtime/bin/node");
            // dshroot：v1.5.3 起【内部优先】（主引擎同款——内部存储读内核快，避免真机外部 FUSE
            // 2 万+ 文件 stat 风暴造成 50-60s 慢启动）；内部缺失时回退本包外部目录
            //（正式版 DeepSeekHarness / Lite DeepSeekHarnessLite），再回退另一版本目录。
            File dshroot = null;
            File internal = new File(payload, "dshroot");
            if (new File(internal, REL_BINJS).exists()) {
                dshroot = internal;
            } else {
                String selfRoot = ctx.getPackageName().contains(".beta")
                        ? "DeepSeekHarnessLite" : "DeepSeekHarness";
                String otherRoot = selfRoot.equals("DeepSeekHarnessLite") ? "DeepSeekHarness" : "DeepSeekHarnessLite";
                for (String root : new String[]{selfRoot, otherRoot}) {
                    File ext = new File(android.os.Environment.getExternalStorageDirectory(), root + "/dshroot");
                    if (new File(ext, REL_BINJS).exists()) { dshroot = ext; break; }
                }
            }
            if (dshroot == null) { log(ctx, "dshroot 未找到"); return false; }
            File binjs = new File(dshroot, REL_BINJS);
            File lib = new File(payload, "runtime/lib");
            File home = new File(payload, "dshhome");
            File bin = new File(payload, "bin");
            File tmp = new File(ctx.getCacheDir(), "tmp");
            if (!tmp.exists()) tmp.mkdirs();
            if (!node.exists()) { log(ctx, "node 缺失"); return false; }
            if (!node.canExecute()) node.setExecutable(true, false);

            ProcessBuilder pb = new ProcessBuilder(
                    node.getAbsolutePath(), "--expose-internals", binjs.getAbsolutePath(),
                    "web", "--host", "127.0.0.1", "--port", String.valueOf(enginePort(ctx)));
            java.util.Map<String, String> env = pb.environment();
            env.put("LD_LIBRARY_PATH", lib.getAbsolutePath());
            // Termux 共存修复（v1.7.4）：同 MainActivity.spawnNode——内置 node 的 OPENSSLDIR
            // 编译死为 /data/data/com.termux/files/usr，装了 Termux 时读其 openssl.cnf EACCES
            // 启动即崩。注入 OPENSSL_CONF 指向 payload 自带的可读配置；存在才注入，避免升级
            // 中途文件缺失时显式指向不存在的路径反而比原来的 ENOENT 静默更糟。
            File osslConf = new File(payload, "runtime/etc/openssl.cnf");
            if (osslConf.exists()) env.put("OPENSSL_CONF", osslConf.getAbsolutePath());
            env.put("PATH", bin.getAbsolutePath() + ":" +
                    new File(payload, "runtime/bin").getAbsolutePath() + ":/system/bin:/system/xbin");
            env.put("HOME", ctx.getFilesDir().getAbsolutePath());
            env.put("DSH_HOME", home.getAbsolutePath());
            env.put("TMPDIR", tmp.getAbsolutePath());
            env.put("TERM", "xterm");
            env.put("SHIZUKU_APP_ID", ctx.getPackageName());
            // v1.14.3：原来是死写 "0" —— 定时任务会话里 shizuku_shell / android_* / 虚拟屏**全部缺席**。
            // 改为真探测（判据同 MainActivity），并把相关环境补齐：
            //   APP_LOCAL_TOKEN → 默认首选通道就是 App 内嵌桥 /shell，没有它插件会退回抖动的 rish；
            //   APP_A11Y_PORT   → dsh-tool-accessibility 靠它读屏/点击，缺了「屏幕助手」类工具全不可用。
            env.put("SHIZUKU_AVAILABLE", shizukuAvailable() ? "1" : "0");
            env.put("ROOT_AVAILABLE", rootAvailable() ? "1" : "0");
            env.put("APP_LOCAL_TOKEN", localToken(ctx));
            env.put("APP_NOTIFY_PORT", String.valueOf(enginePort(ctx) + 1));
            env.put("APP_A11Y_PORT", String.valueOf(enginePort(ctx) + 101));
            pb.redirectErrorStream(true);
            Process proc = pb.start();
            // 日志写入 dsh-web.log
            final File logFile = new File(ctx.getFilesDir(), "dsh-web.log");
            final InputStream is = proc.getInputStream();
            new Thread(new Runnable() {
                @Override public void run() {
                    try {
                        FileOutputStream fos = new FileOutputStream(logFile, true);
                        byte[] b = new byte[4096];
                        int n;
                        while ((n = is.read(b)) > 0) { fos.write(b, 0, n); fos.flush(); }
                        fos.close();
                    } catch (Throwable ignored) {}
                }
            }, "sched-node-log").start();
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "startEngine error", t);
            return false;
        }
    }

    /** Create through the authenticated engine RPC wire. */
    private static String createSession(Context ctx) {
        try {
            return EngineRpc.call(new File(ctx.getFilesDir(), "dsh-web.log"), enginePort(ctx),
                    "session/create", new org.json.JSONObject()).getString("sessionId");
        } catch (Exception e) {
            Log.w(TAG, "scheduled session creation failed", e);
            return null;
        }
    }

    /** 追加执行记录到外部目录（Lite 版用 DeepSeekHarnessLite，正式版用 DeepSeekHarness，便于排查）。 */
    static void log(Context ctx, String msg) {
        try {
            String rootName = ctx.getPackageName().contains(".beta")
                    ? "DeepSeekHarnessLite" : "DeepSeekHarness";
            File root = new File(android.os.Environment.getExternalStorageDirectory(), rootName);
            if (!root.exists()) root.mkdirs();
            File f = new File(root, "scheduled-log.txt");
            FileOutputStream fos = new FileOutputStream(f, true);
            String line = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()) + " " + msg + "\n";
            fos.write(line.getBytes("UTF-8"));
            fos.close();
        } catch (Throwable ignored) {}
    }
}
