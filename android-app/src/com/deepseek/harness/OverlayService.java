package com.deepseek.harness;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.OvershootInterpolator;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

import java.util.HashSet;

import org.json.JSONObject;

/**
 * 小鲸鱼悬浮窗服务：
 *  - 常驻悬浮小鲸鱼图标（可拖动；松手自动贴边，静置时半藏在屏幕边缘）
 *  - 点击展开紧凑状态面板：引擎状态 / AI 会话状态 / 打开应用 / 虚拟屏 / 销毁屏 / 收起
 *  - 拖到屏幕底部区域松手 = 隐藏小鲸鱼（通知栏「显示小鲸鱼」可恢复）
 *  - 每 2 秒探测引擎端口；每 6 秒扫一次 /proc 统计"正在写入的会话"刷新 AI 状态
 *  - 需要 SYSTEM_ALERT_WINDOW（悬浮窗）权限；前台服务保活
 *
 * v1.13.12 大改（用户 15 条反馈里的悬浮窗部分）：
 *  ① 前台隐藏优先级最高 —— 之前虚拟屏预览「收起到小鲸鱼」的钉住状态会盖过前台隐藏，
 *     导致 App 里偶尔冒出小鲸鱼；现在 App 前台一律隐藏（预览仍由钉住状态保持拉帧）。
 *  ② 静置半藏：面板收起时小鲸鱼滑到屏幕边缘、只露一半（FLAG_LAYOUT_NO_LIMITS 允许越界）；
 *     点开面板/拖动时完整露出。收起与唤出都带旋转抖动动画。
 *  ③ 拖到底部隐藏：悬浮窗没有系统级的"拖底消失"（那是通知气泡的特权），
 *     这里自实现同款手势 + 通知栏恢复入口。
 *  ④ AI 状态不再走 HTTP：0.1.5 起接口要认证 cookie，悬浮窗拿不到（401 → 永远"空闲"）。
 *     改为扫 /proc/<同uid进程>/fd 里持着 dshhome/sessions/**​/session.lock 的文件描述符 ——
 *     内核的会话写入器持锁多久，fd 就开多久（dsh-session-persistence-jsonl 的 SessionWriteLease），
 *     这是"会话正在工作"的一手证据，无需任何认证。
 */
public class OverlayService extends Service {
    /**
     * 三版本共存的默认引擎端口，按包名区分（与 AccessibilityService 的口径一致）：
     * 正式版 3080 / Lite 3082 / 兼容版 3084。通知端口 = 引擎端口 + 1，无障碍端口 = +101。
     * 否则三套 App 同时安装会抢同一个 3080（表现为 EADDRINUSE、工具连到别的版本的服务）。
     */
    private static int defaultEnginePort(Context ctx) {
        String p = ctx != null ? ctx.getPackageName() : "";
        if (p.contains("beta")) return 3082;
        if (p.contains("compat")) return 3084;
        return 3080;
    }

    private static final String PREFS = "dsh_prefs";
    private static final String KEY_PORT = "engine_port";
    private static final String CHANNEL_ID = "dsh_overlay";
    private static final int NOTIF_ID = 9002;
    private static final long PROBE_MS = 2000L;
    /** 贴边时离屏幕边缘留多少 dp（v1.38：不再半藏，留出余量躲开系统边缘手势热区）。 */
    private static final int EDGE_GAP_DP = 6;
    /**
     * 静置半藏时露在外面的比例（v1.61 起左/右/上适用）。
     * v1.65：0.45 → 0.68。露得太少手指不好抓（用户实测反馈"点不着"），
     * 露大半既不明显碍事、又能一眼看见、随手可点。
     */
    private static final float TUCK_VISIBLE_FRACTION = 0.68f;
    /** v1.64：上边半藏时向下露出的量（dp）。窗口 y 相对状态栏下沿，收太多会钻进状态栏。 */
    private static final int TUCK_TOP_DP = 34;
    /** v1.62：拖到屏幕最底这一条内松手 = 隐藏（原来 84dp 全算隐藏，和底边半藏打架）。 */
    private static final int DISMISS_ZONE_EDGE_DP = 22;
    /** AI "已完成"提示在状态切换后保留的时长（毫秒）。 */
    private static final long FINISHED_TTL_MS = 60000L;

    /** 当前运行的 OverlayService 实例（供 MainActivity 前后台联动控制视图可见性）。 */
    private static OverlayService instance = null;

    /** 是否正在运行（供 MainActivity / HTTP 端点查询） */
    public static volatile boolean isRunning = false;
    /** 最近一次引擎探测结果 */
    public static volatile boolean engineUp = false;
    public static volatile long lastProbeAt = 0L;

    private WindowManager wm;
    private WindowManager.LayoutParams lp;
    private LinearLayout rootView;
    private ImageView iconView;
    private LinearLayout panelView;
    private TextView statusText;
    private TextView aiText;
    private Button destroyBtn;
    // v1.9 虚拟屏预览：悬浮窗实时显示虚拟屏画面（用户可看 AI 操作）
    private ImageView vscreenImageView = null;
    // v1.25 读回复：面板里可滚动的回复区 + 等待/刷新状态
    private android.widget.ScrollView replyScroll = null;
    private TextView replyText = null;
    private TextView replyHint = null;
    /** 最近一次已显示的助手回复（用于判断"有没有新回复"，避免无意义重绘）。 */
    private volatile String lastReplyShown = null;
    /** 刷新代数：每次发送 / 手动刷新 +1；后台结果回来时代数不一致就丢弃（防止旧结果覆盖新状态）。 */
    private volatile int replyGen = 0;
    /** 是否正在等回复（决定了要不要继续轮询）。 */
    private volatile boolean replyWaiting = false;
    /**
     * v1.38：回复区**只在真有消息要显示时**才出现。
     * 用户要求「没发消息时不要出现，发了消息才出现」—— 所以打开面板不再自动加载历史回复，
     * 只有「发送」「读取到真回复」「长按头像」这三种情况才会把这块区域显示出来。
     * 注意它和 replyText 非空不是一回事：等待回复时 replyText 是占位文案，不算有内容。
     */
    private volatile boolean replyHasContent = false;
    private volatile boolean vscreenPreviewRunning = false;
    private final Handler vscreenHandler = new Handler(Looper.getMainLooper());
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int enginePort = 3080;

    private float touchX, touchY, startX, startY;
    private boolean dragging = false;
    private boolean panelVisible = false;
    /** 拖动中进入"拖底删除"暗示区（图标缩小变淡提示松手即隐藏）。 */
    private boolean dismissHint = false;
    /** 用户拖底主动隐藏后为 true；从通知栏「显示小鲸鱼」恢复。 */
    private volatile boolean userHidden = false;
    /**
     * v1.61：吸附在哪条边（0=左 1=右 2=上 3=下）。
     * 用户要求「左右能半隐藏外，上下也可以」—— 横屏打游戏时左右贴边会让画面很别扭，
     * 上下半藏更自然（游戏多是横屏，上/下边缘的可用空间更值钱）。
     * 由拖动松手时的 snapToEdge() 决定。
     */
    private int dockSide = 0;
    private static final int DOCK_LEFT = 0, DOCK_RIGHT = 1, DOCK_TOP = 2, DOCK_BOTTOM = 3;
    /** v1.13.11：App 在前台 → 悬浮窗应隐藏（由 MainActivity.onStart/onStop 维护）。 */
    private volatile boolean foregroundWantsHidden = true;
    /**
     * v1.38：悬浮窗当前到底露没露（供 /overlay?action=status 自述）。
     * 以前这个状态只能靠 dumpsys 猜，"重装后小鲸鱼不见了"根本没法一眼定位 —— 现在能查。
     */
    public static volatile boolean visible = false;
    /** v1.13.11：被虚拟屏预览「收起到小鲸鱼」钉住 —— 只负责持续拉预览帧，不再影响可见性。 */
    private volatile boolean vscreenPinned = false;
    /** 探测计数：每 PROBE_MS 探测一次引擎；每 3 次（约 6 秒）顺带扫一次会话写入器 */
    private int probeCount = 0;
    /** 最近一次扫到的"持锁会话"目录集合；null 表示还扫过。 */
    private volatile HashSet<String> activeSessions = new HashSet<String>();
    private volatile long finishedAt = 0L;

    public static int enginePort(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        return sp.getInt(KEY_PORT, defaultEnginePort(ctx));
    }

    private final Runnable probeRunnable = new Runnable() {
        @Override public void run() {
            if (!isRunning) return;
            probeCount++;
            final boolean scanSessions = probeCount % 3 == 0;
            // 探测放后台线程：HttpURLConnection / /proc 扫描在主线程会卡界面
            new Thread(new Runnable() {
                @Override public void run() {
                    final boolean up = engineAlive(enginePort);
                    if (up && scanSessions) {
                        activeSessions = scanActiveSessions();
                        lastProbeAt = System.currentTimeMillis();
                    }
                    handler.post(new Runnable() {
                        @Override public void run() {
                            if (!isRunning) return;
                            engineUp = up;
                            updateEngineStatusUi();
                            syncVisibilityFromForeground();   // v1.38：每 2 秒对一次可见性的账
                        }
                    });
                }
            }, "overlay-probe").start();
            handler.postDelayed(this, PROBE_MS);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        isRunning = true;
        instance = this;
        enginePort = enginePort(this);
        wm = pickWindowManager();
        startForegroundCompat();
        buildOverlay();
        addToWindow();
        // v1.54：启动时**默认显示**小鲸鱼。
        // 原来这里抄 MainActivity.overlayForeground 的静态值（默认 true）→ "App 在前台"，
        // 于是刚拉起服务的那一刻鲸鱼是隐藏的；要等 App 真正退到后台的 onStop 才会显示。
        // 调试期间这害得双方状态对不上（我查状态永远是隐藏、用户却以为看得见），
        // 所以改成：服务一起来就显示；App 真的切到前台时，由 MainActivity.onStart 再隐藏。
        foregroundWantsHidden = false;
        applyVisibleNow();
        handler.postDelayed(probeRunnable, 200);
    }

    /**
     * v1.54：公开的面板开关（供 3081 桥 / 通知 / 诊断直接调用，**不依赖悬浮窗触摸**）。
     * 用途：触摸回归修好之前，用户和 AI 都能可靠地把面板打开看回复。
     * @param show true=展开，false=收起
     * @param refresh 打开后是否顺手刷一次回复
     */
    public static String togglePanelFromBridge(final boolean show, final boolean refresh) {
        final OverlayService s = instance;
        if (s == null) return "{\"ok\":false,\"error\":\"overlay not running\"}";
        try {
            // HTTP 桥的线程不是主线程，碰视图必须投递 —— 否则报
            // "Only the original thread that created a view hierarchy can touch its views"。
            s.handler.post(new Runnable() { @Override public void run() {
                try {
                    s.userHidden = false;
                    s.applyVisibleNow();
                    s.setPanelVisible(show, true);
                    if (show && refresh) s.refreshReply(false);
                } catch (Throwable ignored) {}
            }});
            return "{\"ok\":true,\"queued\":true,\"show\":" + show + "}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"error\":\"" + String.valueOf(t.getMessage()).replace("\"", "'") + "\"}";
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 通知栏「显示小鲸鱼」：解除用户隐藏并抖一下示意
        if (intent != null && ACTION_SHOW.equals(intent.getAction())) {
            userHidden = false;
            applyVisibleNow();
            wiggle();
        }
        // v1.43：通知栏「开关面板」—— 悬浮窗收不到触摸时的固定入口
        if (intent != null && ACTION_TOGGLE_PANEL.equals(intent.getAction())) {
            try {
                userHidden = false;
                applyVisibleNow();
                setPanelVisible(!panelVisible, true);
                if (panelVisible) refreshReply(false);   // 打开顺手刷一次回复
            } catch (Throwable ignored) {}
        }
        // 允许通过 intent 指定端口（如换端口后重启）
        if (intent != null && intent.hasExtra("port")) {
            enginePort = intent.getIntExtra("port", enginePort);
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt(KEY_PORT, enginePort).apply();
        }
        return START_STICKY;
    }

    private static final String ACTION_SHOW = "com.deepseek.harness.overlay.SHOW";
    /** v1.43：从通知栏动作触发面板开关（不依赖悬浮窗触摸）。 */
    private static final String ACTION_TOGGLE_PANEL = "com.deepseek.harness.overlay.TOGGLE_PANEL";

    @Override
    public void onDestroy() {
        isRunning = false;
        if (instance == this) instance = null;
        stopVscreenPreview();
        handler.removeCallbacksAndMessages(null);
        if (rootView != null && wm != null) {
            try { wm.removeView(rootView); } catch (Throwable ignored) {}
        }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    /** 前台服务保活（引擎运行期间悬浮窗不被系统回收） */
    private void startForegroundCompat() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "黑鲸鱼悬浮窗",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("黑鲸鱼悬浮窗运行中（引擎状态指示）");
            nm.createNotificationChannel(ch);
        }
        startForeground(NOTIF_ID, buildNotification());
    }

    /** 常驻通知（内容随引擎状态更新；常驻「显示小鲸鱼」动作，拖底隐藏后靠它找回）。 */
    private Notification buildNotification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent show = new Intent(this, OverlayService.class);
        show.setAction(ACTION_SHOW);
        PendingIntent showPi = PendingIntent.getService(this, 1, show,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try { b.addAction(new Notification.Action.Builder(null, "显示小鲸鱼", showPi).build()); }
        catch (Throwable ignored) {
            // 老系统 Action.Builder(null, ...) 不吃图标时退化：不显示动作也不影响主流程
        }
        // v1.43：第二个动作 —— 从通知栏直接开关面板。
        // 为什么必须加：这套 Android 16 / ColorOS 上，悬浮窗窗口能画出来、却收不到触摸
        // （手指和注入触摸都到不了，连 ACTION_DOWN 都没有；详见 §十二）。
        // 通知是**系统窗口**，触摸不受那套限制，所以这里给用户一条固定可用的入口。
        Intent toggle = new Intent(this, OverlayService.class);
        toggle.setAction(ACTION_TOGGLE_PANEL);
        PendingIntent togglePi = PendingIntent.getService(this, 2, toggle,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try { b.addAction(new Notification.Action.Builder(null, "开关面板", togglePi).build()); }
        catch (Throwable ignored) {}
        return b.setContentTitle("🐋 DeepSeek Harness 运行中")
                .setContentText("引擎状态：" + (engineUp ? "运行中（端口 " + enginePort + "）" : "未运行"))
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    /**
     * 把桌宠图裁成圆形头像（对准脸部）并加一圈白描边 —— 悬浮球用。
     * 图来自 payload（pet/whale-shota.png），不放 res/drawable：
     * selfbuild 的 pack 只替换 classes.dex 与 assets/payload.zip、不重建资源表，
     * 新增 drawable 进不了包；payload 每次都能换，所以走这条路。
     * 原图是 1254×1254 的方形插画（带场景背景），直接塞进 40dp 会像"贴图"而不是"球"，
     * 所以：inSampleSize 降采样 → 按脸部居中裁方 → 圆形遮罩 → 白边。
     * 任何一步失败都返回 null，由调用方回退到原图标，不影响悬浮球本身。
     */
    private android.graphics.Bitmap loadPetIcon(int sizePx) {
        try {
            java.io.File pf = new java.io.File(getFilesDir(), "payload/pet/whale-shota.png");
            if (!pf.exists()) return null; // 旧树没这个文件 → 回退原图标
            android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
            o.inSampleSize = 4; // 1254 → ~313，控制内存
            android.graphics.Bitmap src = android.graphics.BitmapFactory
                    .decodeFile(pf.getAbsolutePath(), o);
            if (src == null) return null;
            int w = src.getWidth(), h = src.getHeight();
            int side = Math.min(w, h);
            // 脸部大致在画面偏左上（横向 ~45%、纵向 ~34%），据此居中裁剪
            int cx = (int) (w * 0.45f), cy = (int) (h * 0.34f);
            int x = Math.max(0, Math.min(w - side, cx - side / 2));
            int y = Math.max(0, Math.min(h - side, cy - side / 2));
            android.graphics.Bitmap crop = android.graphics.Bitmap.createBitmap(src, x, y, side, side);
            android.graphics.Bitmap out = android.graphics.Bitmap
                    .createBitmap(sizePx, sizePx, android.graphics.Bitmap.Config.ARGB_8888);
            android.graphics.Canvas c = new android.graphics.Canvas(out);
            android.graphics.Paint p = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
            float r = sizePx / 2f;
            c.drawCircle(r, r, r, p); // 圆形裁切区
            p.setXfermode(new android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN));
            c.drawBitmap(crop, null, new android.graphics.RectF(0, 0, sizePx, sizePx), p); // 缩放贴入
            p.setXfermode(null);
            p.setStyle(android.graphics.Paint.Style.STROKE);
            p.setStrokeWidth(Math.max(2f, sizePx * 0.045f));
            p.setColor(0xFFFFFFFF); // 白描边，压在深色壁纸上也能看清轮廓
            c.drawCircle(r, r, r - p.getStrokeWidth() / 2f, p);
            return out;
        } catch (Throwable t) {
            return null;
        }
    }

    // ===================== 悬浮窗聊天：与引擎的 RPC 通道 =====================
    //
    // 【协议】逆向自 dsh-client-connection / dsh-api-session-controller（2026-09-30 实测）
    //   ① 鉴权两道：
    //        token  → files/dsh-web.log 里 "dsh web: http://127.0.0.1:3080/?token=…" 那行
    //                 ⚠ token 含 - 和 _，只用 [A-Za-z0-9] 匹配会截断
    //        换 Cookie → GET /?token=… 返回 303 + Set-Cookie: dsh-auth-…，之后所有 API 带上它
    //   ② 调用：POST /api/<method>   method 用斜杠（session/list），不是点号
    //        body: {"type":"client-request","rpcId":"…","method":"…","payload":{"args":{…}}}
    //        注意 args 里每个端点的字段名不同：
    //          session/list   → {"_request":{}}
    //          session/prompt → {"request":{…}}
    //      返回: {"type":"server-response","rpcId":"…","result":{"ok":true,"value":…}}
    //
    // 背景：MainActivity.rpcCall() 走的是 /api/session.prompt，payload 缺 args 层、
    // 请求体缺 requestId —— 三个错叠加，它从未成功过。这里按实测协议重写。

    /** 从 dsh-web.log 取最新一次启动打印的引擎 token；取不到返回 null。 */
    private String engineToken() {
        try {
            java.io.File f = new java.io.File(getFilesDir(), "dsh-web.log");
            if (!f.exists()) return null;
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("token=([A-Za-z0-9_-]+)").matcher("");
            String line, last = null;
            while ((line = r.readLine()) != null) {
                m.reset(line);
                if (m.find()) last = m.group(1); // 取最后一次（当前这次启动的）
            }
            r.close();
            return last;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 用 token 换会话 Cookie（只取 name=value 那段）。失败返回 null。 */
    private String engineCookie() {
        try {
            String tok = engineToken();
            if (tok == null) return null;
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("http://127.0.0.1:" + enginePort + "/?token=" + tok).openConnection();
            c.setInstanceFollowRedirects(false); // 303 里才有 Set-Cookie，跟了就丢了
            c.setConnectTimeout(3000);
            c.setReadTimeout(3000);
            c.setRequestProperty("User-Agent", "dsh-overlay");
            c.getResponseCode();
            java.util.List<String> cs = c.getHeaderFields().get("Set-Cookie");
            c.disconnect();
            if (cs == null || cs.isEmpty()) return null;
            String v = cs.get(0);
            int semi = v.indexOf(';');
            return semi > 0 ? v.substring(0, semi) : v;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 发一次 RPC。argsJson 已经是 args 那一层的完整 JSON（含 _request / request）。 */
    private String rpc(String method, String argsJson, String cookie) {
        try {
            String bodyStr = "{\"type\":\"client-request\",\"rpcId\":\"ovl-" + System.currentTimeMillis()
                    + "\",\"method\":\"" + method + "\",\"payload\":{\"args\":" + argsJson + "}}";
            java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                    new java.net.URL("http://127.0.0.1:" + enginePort + "/api/" + method).openConnection();
            c.setRequestMethod("POST");
            c.setRequestProperty("Content-Type", "application/json");
            if (cookie != null) c.setRequestProperty("Cookie", cookie);
            c.setDoOutput(true);
            c.setConnectTimeout(3000);
            c.setReadTimeout(15000);
            c.getOutputStream().write(bodyStr.getBytes("UTF-8"));
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) { c.disconnect(); return null; }
            java.io.InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
            in.close();
            c.disconnect();
            return new String(out.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return null;
        }
    }

    /** 取最近活跃的会话 id（session/list 里 updatedAt 最大的那个）。 */
    private String currentSessionId(String cookie) {
        String resp = rpc("session/list", "{\"_request\":{}}", cookie);
        if (resp == null) return null;
        try {
            org.json.JSONArray items = new org.json.JSONObject(resp)
                    .getJSONObject("result").getJSONObject("value").getJSONArray("items");
            String best = null;
            long bestAt = -1;
            for (int i = 0; i < items.length(); i++) {
                org.json.JSONObject it = items.getJSONObject(i);
                long at = it.optLong("updatedAt", 0);
                if (at > bestAt) { bestAt = at; best = it.optString("sessionId", null); }
            }
            return best;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * v1.25：发消息的结果 —— 从"只有一个字符串错因"升级成"成功时能把 sessionId 带回来"。
     * 带这个 id 是为了读回复：消息进的是哪个会话，就去哪个会话文件里等回答
     * （详见 readReply 上方的大段注释）。
     */
    private static final class SendResult {
        final String error;     // null = 成功
        final String sessionId; // 成功时为目标会话 id
        SendResult(String error, String sessionId) { this.error = error; this.sessionId = sessionId; }
    }

    /** 往当前会话发一条消息。error == null 表示成功。 */
    private SendResult sendPrompt(String text) {
        try {
            String cookie = engineCookie();
            if (cookie == null) return new SendResult("拿不到引擎令牌", null);
            String sid = currentSessionId(cookie);
            if (sid == null) return new SendResult("读不到会话列表", null);
            org.json.JSONObject req = new org.json.JSONObject();
            req.put("requestId", "ovl-" + java.util.UUID.randomUUID());
            req.put("sessionId", sid);
            req.put("mode", "queue");
            req.put("content", new org.json.JSONArray()
                    .put(new org.json.JSONObject().put("type", "text").put("text", text)));
            req.put("clientTimeZone", java.util.TimeZone.getDefault().getID());
            String resp = rpc("session/prompt",
                    new org.json.JSONObject().put("request", req).toString(), cookie);
            if (resp == null) return new SendResult("引擎无响应", null);
            org.json.JSONObject result = new org.json.JSONObject(resp).optJSONObject("result");
            if (result == null) return new SendResult("返回格式异常", null);
            if (result.optBoolean("ok")) return new SendResult(null, sid);
            org.json.JSONObject err = result.optJSONObject("error");
            return new SendResult(err != null ? err.optString("message", "发送失败") : "发送失败", null);
        } catch (Throwable t) {
            return new SendResult(String.valueOf(t.getMessage()), null);
        }
    }

    // ==================== 读回复：逐帧解压会话文件 ====================
    //
    // 【为什么是这条路】引擎的 session/* RPC **全是写操作**，没有"读消息"的端点：
    //   session/list（只有元数据）/ session/prompt / session/steer / session/abort …
    // 所以助手回复只能从会话落盘文件里取：
    //   <files>/payload/dshhome/sessions/<cwd编码>/session-<id>/session.v4.jsonl.zstd
    //
    // 【文件格式（实测）】不是单个 zstd 流，而是**追加写的多帧拼接**（一个文件里 30+ 帧，
    //   每帧一个嵌套 zstd frame，帧头魔数 28 B5 2F FD）。所以不能整体 zstdDecompressSync ——
    //   它只解第一帧，正好只得到会话头那一行（交接文档 7.1 记的就是这个坑）。
    //   解法：按魔数切帧，逐帧解，再拼成 JSONL。
    //
    // 【实现取舍】解压交给 payload 自带的 node（v26 有 zlib.zstdDecompressSync），
    //   Java 侧不引第三方 zstd 依赖；脚本在首次使用时写到 cacheDir/ovl-readreply.js，
    //   之后只 exec 这一个文件 —— 不走 sh -c，也不把 JS 塞进命令行参数，
    //   绕开 shell 引号/转义地狱（交接文档第四节第六坑）。
    //   单次实测 ~0.3 秒（80464 字节 / 35 帧），所以可以"发完自动刷"，
    //   但不要拿去当实时轮询。

    /** 会话根目录（App 视角；node 子进程同 uid，读得到）。 */
    private File sessionsRoot() {
        return new File(getFilesDir(), "payload/dshhome/sessions");
    }

    /** 内嵌的读回复脚本（首次使用时落盘到 cacheDir，之后复用）。 */
    private static final String READ_REPLY_JS =
        "const fs=require('fs'),zlib=require('zlib'),path=require('path');\n" +
        "function readJsonl(file){\n" +
        "  const buf=fs.readFileSync(file);\n" +
        "  const MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);\n" +
        "  const parts=[];let i=0;\n" +
        "  while(i<buf.length){\n" +
        "    let j=buf.indexOf(MAGIC,i+1);if(j<0)j=buf.length;\n" +
        "    try{parts.push(zlib.zstdDecompressSync(buf.slice(i,j)));}catch(e){}\n" +
        "    i=j;\n" +
        "  }\n" +
        "  return Buffer.concat(parts).toString('utf8').split('\\n');\n" +
        "}\n" +
        "function findDir(root,sid){\n" +
        "  if(sid){const p=path.join(root,'session-'+sid);try{if(fs.statSync(p).isDirectory())return p;}catch(e){}}\n" +
        "  let best=null,bt=-1;\n" +
        "  let groups=[];try{groups=fs.readdirSync(root);}catch(e){return null;}\n" +
        "  for(const g of groups){\n" +
        "    const gp=path.join(root,g);let st;try{st=fs.statSync(gp);}catch(e){continue;}\n" +
        "    if(!st.isDirectory())continue;\n" +
        "    let subs=[];try{subs=fs.readdirSync(gp);}catch(e){continue;}\n" +
        "    for(const s of subs){\n" +
        "      if(s.indexOf('session-')!==0)continue;\n" +
        "      try{\n" +
        "        const f=path.join(gp,s,'session.v4.jsonl.zstd');\n" +
        "        const ft=fs.statSync(f).mtimeMs;\n" +
        "        if(ft>bt){bt=ft;best=f;}\n" +
        "      }catch(e){}\n" +
        "    }\n" +
        "  }\n" +
        "  return best?path.dirname(best):null;\n" +
        "}\n" +
        "const root=process.argv[2],sid=process.argv[3]||'';\n" +
        "const dir=findDir(root,sid);\n" +
        "if(!dir){console.log(JSON.stringify({ok:false,error:'no-session-file'}));process.exit(0);}\n" +
        "const file=path.join(dir,'session.v4.jsonl.zstd');\n" +
        "if(!fs.existsSync(file)){console.log(JSON.stringify({ok:false,error:'no-session-file'}));process.exit(0);}\n" +
        "let user=null,userAt=0,reply=null,replyAt=0;\n" +
        "for(const l of readJsonl(file)){\n" +
        "  if(!l)continue;let o;try{o=JSON.parse(l);}catch(e){continue;}\n" +
        "  if(o.type==='user/message'){\n" +
        "    const src=o.data&&o.data.source;\n" +
        "    if(src&&src.kind==='runtime-context')continue;\n" +
        "    const c=o.data&&o.data.content;\n" +
        "    if(Array.isArray(c)){const t=c.filter(function(p){return p.type==='text';}).map(function(p){return p.text;}).join('');\n" +
        "      if(t.trim()){user=t;userAt=o.time||0;}}\n" +
        "  }\n" +
        "  if(o.type==='assistant/message'){\n" +
        "    const c=o.data&&o.data.message&&o.data.message.content;\n" +
        "    if(Array.isArray(c)){const t=c.filter(function(p){return p.type==='text';}).map(function(p){return p.text;}).join('');\n" +
        "      if(t.trim()){reply=t;replyAt=o.time||0;}}\n" +
        "  }\n" +
        "}\n" +
        "console.log(JSON.stringify({ok:true,sessionId:path.basename(dir).slice(8),user:user,userAt:userAt,reply:reply,replyAt:replyAt}));\n";

    /**
     * 保证读回复脚本已落盘，返回可执行路径；任何一步失败返回 null。
     * 每次调用都做一次"长度对比"：脚本被外部改坏/截断时自动重写（内容恒定，无需哈希）。
     */
    private File ensureReadReplyScript() {
        try {
            File f = new File(getCacheDir(), "ovl-readreply.js");
            byte[] want = READ_REPLY_JS.getBytes("UTF-8");
            if (!f.exists() || f.length() != want.length) {
                java.io.FileOutputStream os = new java.io.FileOutputStream(f);
                try { os.write(want); } finally { try { os.close(); } catch (Throwable ignored) {} }
            }
            f.setReadable(true, false);
            return f;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 读会话文件，取最后一条用户发言与最后一条助手正文。**阻塞调用，必须在后台线程跑。**
     * @param sessionId 目标会话（来自发送结果的 sessionId）；为 null 时脚本自己挑最新的
     * @return {"ok":true,"user":…,"userAt":…,"reply":…,"replyAt":…}，失败返回 null
     */
    private JSONObject readReply(String sessionId) {
        File node = new File(getFilesDir(), "payload/runtime/bin/node");
        File script = ensureReadReplyScript();
        if (!node.exists() || script == null) return null;
        java.lang.Process p = null;
        try {
            java.util.List<String> cmd = new java.util.ArrayList<String>();
            cmd.add(node.getAbsolutePath());
            cmd.add(script.getAbsolutePath());
            cmd.add(sessionsRoot().getAbsolutePath());
            cmd.add(sessionId == null ? "" : sessionId);
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(false);
            // 起 node 的几个环境变量：与 MainActivity.spawnNode 同源（Termux 共存 + 证书）
            java.util.Map<String, String> env = pb.environment();
            File lib = new File(getFilesDir(), "payload/runtime/lib");
            if (lib.isDirectory()) env.put("LD_LIBRARY_PATH", lib.getAbsolutePath());
            File ossl = new File(getFilesDir(), "payload/runtime/etc/openssl.cnf");
            if (ossl.exists()) env.put("OPENSSL_CONF", ossl.getAbsolutePath());
            env.put("NODE_NO_WARNINGS", "1");
            p = pb.start();
            // stderr 必须读掉，否则管道写满会把 node 卡死在这个输出上
            final java.io.InputStream err = p.getErrorStream();
            new Thread(new Runnable() { @Override public void run() {
                try {
                    byte[] b = new byte[1024];
                    while (err.read(b) > 0) { /* 丢弃 */ }
                } catch (Throwable ignored) {}
            }}, "ovl-reply-err").start();
            String line = null;
            java.io.BufferedReader r = new java.io.BufferedReader(
                    new java.io.InputStreamReader(p.getInputStream(), "UTF-8"));
            String l;
            while ((l = r.readLine()) != null) line = l;   // 只认最后一行（脚本只打印一行）
            r.close();
            if (!p.waitFor(20, java.util.concurrent.TimeUnit.SECONDS)) {
                p.destroy();
                return null;
            }
            if (line == null || line.isEmpty()) return null;
            return new JSONObject(line);
        } catch (Throwable t) {
            return null;
        } finally {
            if (p != null) { try { p.destroy(); } catch (Throwable ignored) {} }
        }
    }

    // ==================== v1.25 回复区：显示 / 轮询 ====================

    /** 展开面板并置为"正在看回复"的状态（发送成功、长按头像都走它）。 */
    private void showReplyArea() {
        showReplyArea(true);
    }

    /**
     * 展开面板。
     * @param wantArea v1.38：true 才把回复区显示出来；false 只负责把面板打开 ——
     *                 回复区该不该露由 setReplyShown() 决定，这样"没发消息时它不会自己冒出来"。
     */
    private void showReplyArea(boolean wantArea) {
        try {
            if (wantArea) replyHasContent = true;
            setReplyShown(replyHasContent);
            if (!panelVisible) setPanelVisible(true, true);
        } catch (Throwable ignored) {}
    }

    /** 回复区显隐（顺带保证宽度夹在屏幕内）。 */
    private void setReplyShown(boolean show) {
        try {
            if (replyScroll != null) {
                replyScroll.setVisibility(show ? View.VISIBLE : View.GONE);
                if (show) applyReplyWidth();
            }
            if (!show && replyHint != null) replyHint.setVisibility(View.GONE);
        } catch (Throwable ignored) {}
    }

    /** 回复区里有没有"真消息"（刚发出的那句也算）。 */
    private boolean hasReplyContent() {
        try {
            if (replyHasContent) return true;
            if (replyText == null || replyText.getText().length() == 0) return false;
            return lastReplyShown != null && !lastReplyShown.isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 发送成功后立刻把这句话回显到回复区 —— 不等引擎、不等文件，
     * 用户马上能看到"我发了什么"，之后助手正文到了再替换。
     */
    private void showSentEcho(final String txt) {
        try {
            showReplyArea(true);
            setReplyHint("已发送，等回复…");
            final String esc = htmlEscape(txt);
            replyText.setText(android.text.Html.fromHtml(
                    "<font color=\"#9FB3C8\">你：</font>" + esc.replace("\n", "<br>")
                    + "<br><br><font color=\"#7F8FA6\">等待回复…</font>"));
            scrollReplyToBottom();
        } catch (Throwable ignored) {}
    }

    /** 面板里的小号状态行（等回复 / ✗ 错误 / 提示）。text 为空则隐藏。 */
    private void setReplyHint(final String text) {
        try {
            if (replyHint == null) return;
            if (text == null || text.isEmpty()) {
                replyHint.setVisibility(View.GONE);
                replyHint.setText("");
            } else {
                replyHint.setText(text);
                replyHint.setVisibility(View.VISIBLE);
            }
        } catch (Throwable ignored) {}
    }

    private static String htmlEscape(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    /**
     * 把取到的回复渲染进回复区。
     * @param manual   true=手动刷新（不管有没有新内容都渲染）；false=自动轮询（无变化就什么都不做）
     * @param expectUser 自动轮询时要求匹配的那条用户发言（防止把**上一轮**的旧回复当成本次回复显示）
     * @return true = 回复区内容已更新
     */
    private boolean applyReply(final JSONObject o, final boolean manual, final String expectUser) {
        final String reply = o != null ? o.optString("reply", null) : null;
        if (reply == null || reply.isEmpty()) {
            if (manual) {
                setReplyHint(o != null && o.optBoolean("ok")
                        ? "还没有回复（助手可能还在工作中）"
                        : "读不到会话文件");
            }
            return false;
        }
        final String user = o.optString("user", null);
        if (!manual && expectUser != null) {
            String a = user == null ? "" : user.trim();
            String b = expectUser.trim();
            if (!a.equals(b) && !a.endsWith(b) && !b.endsWith(a)) return false; // 不是这一轮的回复
        }
        if (!manual && reply.equals(lastReplyShown) && expectUser == null) return false;
        lastReplyShown = reply;
        replyHasContent = true;          // v1.38：拿到真回复 → 回复区可以出现了
        try {
            StringBuilder sb = new StringBuilder();
            if (user != null && !user.isEmpty()) {
                sb.append("<font color=\"#9FB3C8\">你：</font>")
                  .append(htmlEscape(user).replace("\n", "<br>"))
                  .append("<br><br><font color=\"#9FB3C8\">AI：</font><br>");
            } else {
                sb.append("<font color=\"#9FB3C8\">AI：</font><br>");
            }
            sb.append(htmlEscape(reply).replace("\n", "<br>"));
            replyText.setText(android.text.Html.fromHtml(sb.toString()));
            setReplyShown(true);
            if (!panelVisible) setPanelVisible(true, true);
            setReplyHint("");
            scrollReplyToBottom();
        } catch (Throwable ignored) {}
        return true;
    }

    private void scrollReplyToBottom() {
        try {
            if (replyScroll == null) return;
            replyScroll.post(new Runnable() { @Override public void run() {
                try { replyScroll.fullScroll(View.FOCUS_DOWN); } catch (Throwable ignored) {}
            }});
        } catch (Throwable ignored) {}
    }

    /** 只读一次会话文件（后台线程调用）。 */
    private ReplyData fetchReply(String sessionId) {
        JSONObject o = readReply(sessionId);
        if (o == null || !o.optBoolean("ok")) return null;
        return new ReplyData(o.optString("user", null), o.optLong("userAt", 0),
                o.optString("reply", null), o.optLong("replyAt", 0));
    }

    /** readReply 的一次结果（比到处 optString 清爽）。 */
    private static final class ReplyData {
        final String user; final long userAt; final String reply; final long replyAt;
        ReplyData(String user, long userAt, String reply, long replyAt) {
            this.user = user; this.userAt = userAt; this.reply = reply; this.replyAt = replyAt;
        }
        /** 重新包成 JSONObject，交给统一的 applyReply 渲染。 */
        JSONObject obj() {
            try {
                return new JSONObject().put("ok", true).put("user", user)
                        .put("userAt", userAt).put("reply", reply).put("replyAt", replyAt);
            } catch (Throwable t) {
                return null;
            }
        }
    }

    /**
     * 发完消息后的"温和轮询"：回复是助手异步写的，文件不会立刻更新。
     * 等 1.5s 起、间隔递增（约 1.5/3/5/8/12/18 秒共 6 次），期间一旦拿到**本轮**的回复就停。
     * 轮询不改 replyGen —— 只有"新的一次发送 / 手动刷新"才会让旧结果作废。
     */
    private void startReplyWait(final String sessionId, final String expectUser) {
        showReplyArea(false);   // 发送时 showSentEcho 已经把区域打开了，这里只保证面板可见
        replyWaiting = true;
        try {
            rootView.postDelayed(new Runnable() { @Override public void run() {
                refreshReplyAt(sessionId, expectUser, false, replyGen, 0);
            }}, 1500L);
        } catch (Throwable ignored) {}
    }

    /**
     * 手动刷新：不管有没有变化都渲染一次。
     * @param force v1.38：true = 先把回复区显示出来再读（长按头像这种显式意图）；
     *              false = 读到了才显示（回复区收着的时候点一下，不至于因为"没内容"毫无反应）。
     */
    private void refreshReply(boolean force) {
        if (force) replyHasContent = true;
        refreshReplyAt(null, null, true, ++replyGen, 0);
    }

    /**
     * 跑一次读取。代数 gen 用来丢弃过期结果：用户在这期间又发了一条的话，
     * 旧线程回来时代数已变，直接丢弃，不会把新状态擦掉。
     * attempt = 已经重试过几次（只给自动轮询用，手动刷新固定 0）。
     */
    private void refreshReplyAt(final String sessionId, final String expectUser,
                               final boolean manual, final int gen, final int attempt) {
        if (manual) {
            setReplyShown(true);   // 手动刷新：先把区域露出来，用户才看得到"读取中…"
            setReplyHint("读取中…");
        }
        new Thread(new Runnable() { @Override public void run() {
            final ReplyData d = fetchReply(sessionId);
            try {
                rootView.post(new Runnable() { @Override public void run() {
                    if (gen != replyGen) return;                 // 过期结果
                    if (manual) {
                        applyReply(d == null ? null : d.obj(), true, null);
                        replyWaiting = false;
                        return;
                    }
                    boolean got = d != null && d.reply != null && !d.reply.isEmpty();
                    boolean fresh = true;
                    if (got && expectUser != null) {
                        String a = d.user == null ? "" : d.user.trim();
                        String b = expectUser.trim();
                        fresh = a.equals(b) || a.endsWith(b) || b.endsWith(a);
                    }
                    if (got && fresh) {
                        applyReply(d.obj(), false, expectUser);   // 内容没变也不会重绘
                        replyWaiting = false;
                        return;
                    }
                    // 还没等到：按退避表继续重试（同一代数，所以不算过期）
                    final int[] delays = {3000, 5000, 8000, 12000, 18000};
                    if (replyWaiting && attempt < delays.length) {
                        final int next = attempt;
                        rootView.postDelayed(new Runnable() { @Override public void run() {
                            refreshReplyAt(sessionId, expectUser, false, gen, next + 1);
                        }}, delays[attempt]);
                    } else {
                        replyWaiting = false;
                        setReplyHint("助手还在工作中…可点「刷新」或长按头像再看");
                    }
                }});
            } catch (Throwable ignored) {}
        }}, "ovl-reply").start();
    }

    private void buildOverlay() {
        // ===== 根布局（竖排：图标行 + 状态面板）=====
        rootView = new LinearLayout(this);
        rootView.setOrientation(LinearLayout.VERTICAL);
        // v1.46：内边距必须≈0 —— 它决定"可触摸区"比"看得见的圆"大多少。
        // 实测（density=3.5）：原来 dp(10)/dp(8) 让窗口 238×210，而圆头像只有 140×140，
        // 左右各多 49px、上下各多 35px 的**纯透明**区域也是可点的，
        // 用户反馈"要点悬浮球最底部才能弹聊天框"就是这么来的（顶部那 35px 还是透明的，
        // 手指按在圆的视觉范围内反而落不进）。
        // 现在收到 4dp/2dp：窗口≈168×154、圆 140×140，偏差只剩 ±14px，
        // 落到圆上任意位置都能命中，手感与视觉一致。
        // v1.47：内边距直接归零 —— 让"窗口 = 可触摸区"**正好等于**"看得见的那个圆"。
        // 原委：实测窗口 238×210 而圆只有 140×140，四周一圈纯透明区域也是可点的；
        // 用户反馈"必须按住圆最下方那条白线才能弹面板/拖动"。收到 4dp/2dp 后仍有
        // 28/14px 残差，且用户手感没变 —— 说明残余偏差在窗口真实落点上，不在 padding。
        // 与其猜，不如让窗口尺寸 == 圆尺寸：触点只要能看见圆就必定在窗口内。
        // v1.53：还原成能工作那版的 padding（dp(10)/dp(8)）。
        // 前面为了"让可触摸区等于看得见的圆"，我把它一路收到 0 —— 那是在错误方向上优化，
        // 现在回到原始值，减少"到底是哪一处改动弄坏了"的变量。
        rootView.setPadding(dp(10), dp(8), dp(10), dp(8));
        // 收起态无背景（只留小鲸鱼图标）；背景移到展开面板 panelView 上

        // ===== 图标行（小鲸鱼）=====
        LinearLayout iconRow = new LinearLayout(this);
        iconRow.setOrientation(LinearLayout.HORIZONTAL);
        iconRow.setGravity(Gravity.CENTER_VERTICAL);
        iconRow.setPadding(0, 0, 0, 0);

        iconView = new ImageView(this);
        // v1.24：悬浮球图标从「黑鲸鱼剪影」换成桌宠形象（whale-shota），圆形裁剪 + 白描边。
        // 原图标 R.drawable.ic_whale_black 保留未删，想换回只需改这一处。
        android.graphics.Bitmap petIcon = loadPetIcon(dp(40));
        if (petIcon != null) {
            iconView.setImageBitmap(petIcon);
        } else {
            iconView.setImageResource(R.drawable.ic_whale_black); // 兜底：解码失败仍用原图标
        }
        iconView.setLayoutParams(new LinearLayout.LayoutParams(dp(40), dp(40)));
        // ⛔ v1.60 根因修复：**不要再给 iconView 挂 OnLongClickListener / OnClickListener**。
        // 它是"点不中悬浮球"的真正原因（v1.24 可点、v1.37 起只能点最底部）：
        //   挂上长按监听后 iconView 变成 clickable，落在图标范围内的触摸被**图标自己消费**，
        //   不再冒泡到 rootView 的 OnTouchListener（拖动/点击都在那里处理）。
        //   于是只剩"窗口多出来、图标盖不到"的那一小条（图标下方约 20~30px）还能命中 ——
        //   表现就是"必须按住圆的底部才行"。
        // 手动刷回复现在有两个不冲突的入口：面板里的「刷新」按钮、通知栏「开关面板」。
        // 想再加长按刷新，必须挂在**不被触摸消费**的位置（例如给 rootView 的 onTouch
        // 自己实现长按判定），而不是给 iconView 挂监听。
        iconRow.addView(iconView);
        rootView.addView(iconRow);

        // ===== 状态面板（紧凑版，默认隐藏）=====
        panelView = new LinearLayout(this);
        panelView.setOrientation(LinearLayout.VERTICAL);
        panelView.setPadding(dp(10), dp(8), dp(10), dp(8));
        GradientDrawable pbg = new GradientDrawable();
        pbg.setColor(getColor(R.color.panel_bg));              // 深蓝半透明（统一配色资源）
        pbg.setCornerRadius(dp(12));
        panelView.setBackground(pbg);

        statusText = new TextView(this);
        statusText.setText("状态：检测中…");
        statusText.setTextColor(getColor(R.color.panel_text_bright));
        statusText.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
        panelView.addView(statusText);

        // AI 会话状态（/proc 会话写入器扫描，每 ~6 秒刷新；v1.13.12 起不再是永远"空闲"）
        aiText = new TextView(this);
        aiText.setText("AI：—");
        aiText.setTextColor(getColor(R.color.panel_text_dim));
        aiText.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
        panelView.addView(aiText);

        // v1.9 虚拟屏预览（默认隐藏）：悬浮窗实时显示虚拟屏画面
        vscreenImageView = new ImageView(this);
        LinearLayout.LayoutParams vsp = new LinearLayout.LayoutParams(dp(176), dp(298));
        vsp.topMargin = dp(6);
        vscreenImageView.setLayoutParams(vsp);
        vscreenImageView.setScaleType(ImageView.ScaleType.FIT_CENTER);
        vscreenImageView.setVisibility(View.GONE);
        vscreenImageView.setBackgroundColor(0x88000000);
        panelView.addView(vscreenImageView);

        // v1.13.12：按钮重做 —— 面板不需要大按钮，两行小胶囊足够；端口行整体移除
        // （端口在控制台/通知里都有，天天显示在悬浮窗上没有信息量）。
        // ===== v1.24：聊天输入行 —— 在悬浮窗里直接给引擎发消息 =====
        // 关键点：窗口带 FLAG_NOT_FOCUSABLE，EditText 收不到键盘输入，
        // 所以在获得/失去焦点时临时切换该标志（失焦立刻恢复，避免悬浮窗抢返回键）。
        LinearLayout chatRow = new LinearLayout(this);
        chatRow.setOrientation(LinearLayout.HORIZONTAL);
        chatRow.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams crp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        crp.topMargin = dp(8);
        chatRow.setLayoutParams(crp);

        final android.widget.EditText chatInput = new android.widget.EditText(this);
        chatInput.setHint("说点什么…");
        chatInput.setTextColor(getColor(R.color.panel_text_bright));
        chatInput.setHintTextColor(getColor(R.color.panel_text_dim));
        chatInput.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
        chatInput.setSingleLine(true);
        chatInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEND);
        GradientDrawable ibg = new GradientDrawable();
        ibg.setColor(0x33FFFFFF);
        ibg.setCornerRadius(dp(9));
        chatInput.setBackground(ibg);
        chatInput.setPadding(dp(8), dp(5), dp(8), dp(5));
        chatInput.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        chatRow.addView(chatInput);

        final TextView chatStatus = new TextView(this);
        chatStatus.setTextColor(getColor(R.color.panel_text_dim));
        chatStatus.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
        LinearLayout.LayoutParams cslp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cslp.leftMargin = dp(6);
        chatStatus.setLayoutParams(cslp);
        chatRow.addView(chatStatus);

        // 输入框聚焦时解除 NOT_FOCUSABLE，失焦恢复 —— 否则点不出输入法
        chatInput.setOnFocusChangeListener(new View.OnFocusChangeListener() {
            @Override public void onFocusChange(View v, boolean has) {
                try {
                    if (lp == null) return;
                    int base = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH;
                    lp.flags = has ? base : (base | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
                    wm.updateViewLayout(rootView, lp);
                    if (has) {
                        chatInput.requestFocus();
                        android.view.inputmethod.InputMethodManager imm =
                                (android.view.inputmethod.InputMethodManager)
                                        getSystemService(INPUT_METHOD_SERVICE);
                        if (imm != null) imm.showSoftInput(chatInput, 0);
                    }
                } catch (Throwable ignored) {}
            }
        });

        final Runnable doSend = new Runnable() { @Override public void run() {
            final String txt = chatInput.getText().toString().trim();
            if (txt.isEmpty()) return;
            chatInput.setText("");
            chatStatus.setText("发送中…");
            new Thread(new Runnable() { @Override public void run() {
                final SendResult res = sendPrompt(txt); // error==null = 成功
                rootView.post(new Runnable() { @Override public void run() {
                    final String shown = res.error == null ? "已发送 ✓" : "✗ " + res.error;
                    chatStatus.setText(shown);
                    // 3.5 秒后自动清掉；若期间又发了一条（文案已变）就不清，避免擦掉新状态
                    rootView.postDelayed(new Runnable() { @Override public void run() {
                        if (shown.contentEquals(chatStatus.getText())) chatStatus.setText("");
                    }}, 3500);
                    if (res.error == null) {
                        // v1.25：发完自动刷回复 —— 立刻把刚发出的这句话显示出来（不用等引擎），
                        // 然后温和轮询（1.5s / 3s / 5s / 8s / 12s / 18s，最多 6 次）等助手写完。
                        showSentEcho(txt);
                        startReplyWait(res.sessionId, txt);
                    }
                }});
            }}, "ovl-send").start();
        }};
        chatInput.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int actionId, android.view.KeyEvent e) {
                if (actionId == android.view.inputmethod.EditorInfo.IME_ACTION_SEND
                        || (e != null && e.getKeyCode() == android.view.KeyEvent.KEYCODE_ENTER)) {
                    doSend.run();
                    return true;
                }
                return false;
            }
        });
        chatRow.addView(pillButton("发送", doSend));
        panelView.addView(chatRow);

        // ===== v1.25：回复区（可滚动，显示会话里最后一条用户发言 + 最后一条助手回复）=====
        // 为什么需要它：引擎没有"读消息"的 RPC（session/* 全是写操作），
        // 回复只能从会话落盘文件里解出来 —— 解压一次约 0.3~1 秒，
        // 所以策略是「发完自动刷几次」+「点刷新/长按头像手动刷」，而不是实时轮询。
        replyHint = new TextView(this);
        replyHint.setTextColor(getColor(R.color.panel_text_dim));
        replyHint.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
        LinearLayout.LayoutParams rhp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rhp.topMargin = dp(7);
        replyHint.setLayoutParams(rhp);
        replyHint.setVisibility(View.GONE);
        panelView.addView(replyHint);

        replyScroll = new android.widget.ScrollView(this);
        LinearLayout.LayoutParams rsp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(150));
        rsp.topMargin = dp(5);
        replyScroll.setLayoutParams(rsp);
        replyScroll.setScrollBarStyle(View.SCROLLBARS_INSIDE_OVERLAY);
        replyScroll.setVisibility(View.GONE);
        GradientDrawable rbg = new GradientDrawable();
        rbg.setColor(0x1AFFFFFF);
        rbg.setCornerRadius(dp(9));
        replyScroll.setBackground(rbg);
        replyScroll.setPadding(dp(8), dp(6), dp(8), dp(6));

        replyText = new TextView(this);
        replyText.setTextColor(getColor(R.color.panel_text_bright));
        replyText.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
        replyText.setLineSpacing(dp(2), 1f);
        replyText.setTextIsSelectable(true);   // 回复能选中复制
        replyText.setLayoutParams(new android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT));
        replyScroll.addView(replyText);
        panelView.addView(replyScroll);

        // v1.24：原来的「打开应用 / 虚拟屏」两个按钮已按用户要求移除（面板太挤）。
        // 回 App 走通知栏或桌面图标；虚拟屏预览仍可由其他入口唤起。
        LinearLayout btnRow2 = new LinearLayout(this);
        btnRow2.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams r2p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        r2p.topMargin = dp(5);
        btnRow2.setLayoutParams(r2p);
        // 销毁屏：替代旧预览窗上的 ✕（用户要求销毁功能收进小鲸鱼面板）
        destroyBtn = pillButton("销毁屏", new Runnable() { @Override public void run() {
            try { VsreenBridgeService.destroyVscreenFromWhale(); } catch (Throwable ignored) {}
            setPanelVisible(false, true);
        }});
        destroyBtn.setVisibility(View.GONE);
        btnRow2.addView(destroyBtn);
        // v1.38：回复区平时是收着的，所以「刷新」要能**把它拉出来**，不能只读不显示。
        btnRow2.addView(pillButton("刷新", new Runnable() { @Override public void run() {
            refreshReply(true);   // sessionId=null → 脚本自己挑最新会话；不强求匹配某条发言
        }}));
        btnRow2.addView(pillButton("收起", new Runnable() { @Override public void run() {
            setPanelVisible(false, true);
        }}));

        panelView.addView(btnRow2);
        rootView.addView(panelView);
        setPanelVisible(false, false);

        // ===== 拖动 + 点击 + 拖底隐藏 =====
        rootView.setOnTouchListener(new View.OnTouchListener() {
            private long downAt = 0;
            @Override public boolean onTouch(View v, MotionEvent ev) {
                switch (ev.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        downAt = System.currentTimeMillis();
                        touchX = ev.getRawX(); touchY = ev.getRawY();
                        startX = lp.x; startY = lp.y;
                        dragging = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        if (Math.abs(ev.getRawX() - touchX) > dp(8) || Math.abs(ev.getRawY() - touchY) > dp(8)) {
                            dragging = true;
                        }
                        if (dragging) {
                            lp.x = (int) (startX + (ev.getRawX() - touchX));
                            lp.y = (int) (startY + (ev.getRawY() - touchY));
                            try { wm.updateViewLayout(rootView, lp); } catch (Throwable ignored) {}
                            updateDismissHint(ev.getRawY());
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        // v1.56：判定改回**原版口径**（`!dragging && 按下<400ms` 就算点击）。
                        // 我在 v1.25/v1.38 陆续加了两个条件：
                        //   ① v == rootView（要求触点落在根布局本身）
                        //   ② !insidePanel(rawX, rawY)（要求触点不在面板矩形内）
                        // 用户的实测反馈是"必须按住白色圆最底部才响应" —— 这与判定被收窄高度吻合：
                        // 只要触点被判成"面板内部"，这次点击就被丢掉，表现为可点范围整体偏下/偏小。
                        // 原版没有这两个条件，就是单纯"没拖动 + 按得够短 = 点击"，这里还原。
                        // （面板内的按钮/输入框本来就会自己消费触摸，不会走到这里。）
                        boolean onRoot = true;
                        if (dragging && dismissHint && !panelVisible) {
                            // v1.63：隐藏手势收紧成两条 ——
                            //   ① **面板展开时一律不隐藏**，改为吸附到底边半藏。
                            //      面板状态下"整个消失"最让人意外，而且"面板展开"
                            //      和"拖底隐藏"抢的是同一个向下手势（用户反馈"拖到底部直接收起来"）。
                            //   ② 只有收起态、且真的拖进屏幕最底那一条（DISMISS_ZONE_EDGE_DP）
                            //      才隐藏。
                            hideByDragToBottom();
                        } else if (dragging) {
                            // v1.61：按松手时手指位置吸附最近的一条边（四边都支持），
                            // 并按面板状态决定半藏还是完整贴边。
                            snapToEdge(ev.getRawX(), ev.getRawY());
                            if (panelVisible) setPanelVisible(true, false);
                        } else if (System.currentTimeMillis() - downAt < 400) {
                            setPanelVisible(!panelVisible, true);
                        }
                        logDrag("up", ev, v, onRoot);
                        setDismissHintInternal(false);
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        // v1.38 诊断：系统/上层窗口把触摸抢走时走到这里。
                        // 用户报"拖不动"时，这条日志能区分"根本没收到触摸"和"收到了但被取消"。
                        logDrag("cancel", ev, v, false);
                        setDismissHintInternal(false);
                        return true;
                    case MotionEvent.ACTION_OUTSIDE:
                        // 点击悬浮窗外区域：收回面板（回到静置态）
                        if (panelVisible) setPanelVisible(false, true);
                        return true;
                }
                return false;
            }
        });
    }

    /** 面板里的小胶囊按钮（v1.13.12 重做：小、轻、不抢眼）。 */
    private Button pillButton(String text, final Runnable action) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
        b.setTextColor(getColor(R.color.accent_brand));
        b.setTypeface(null, Typeface.BOLD);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFFFFFFFF);
        bg.setCornerRadius(dp(11));
        b.setBackground(bg);
        b.setSingleLine(true);
        b.setPadding(dp(4), 0, dp(4), 0);
        b.setMinHeight(0);
        b.setMinWidth(0);
        b.setMinimumHeight(0);
        b.setMinimumWidth(0);
        b.setHeight(dp(25));
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(0, dp(25), 1f);
        lp2.leftMargin = dp(3);
        lp2.rightMargin = dp(3);
        b.setLayoutParams(lp2);
        b.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) {
            try { action.run(); } catch (Throwable ignored) {}
        }});
        return b;
    }

    // ==================== 可见性 / 贴边 / 动画 ====================

    /** 悬浮窗整体可见性（App 前台隐藏、退后台显示；服务常驻只切视图）。 */
    public static void setOverlayVisible(boolean show) {
        OverlayService s = instance;
        if (s != null) { s.foregroundWantsHidden = !show; s.applyVisibleNow(); }
    }

    /**
     * v1.38：可见性**自愈**。
     * 起因（实测复现）：覆盖安装后 MainActivity 重来一遍 onStart→onStop，
     * 而 OverlayService 可能在同一进程里活着、`foregroundWantsHidden` 记着旧值，
     * 一旦两边"想的一样"就不再有人调 applyVisibleNow —— 表现就是
     * **后台明明该显示小鲸鱼，它却一直是 GONE**（服务在跑、窗口在、就是不露脸）。
     * 修法：探针每 2 秒对一次账，把真实可见性和"应该可见"对齐。
     */
    private void syncVisibilityFromForeground() {
        try {
            // v1.65：用**无障碍看到的真实前台包名**纠正 MainActivity 的生命周期标志。
            // 为什么必须这样：foregroundWantsHidden 是"服务实例里的状态"，由 onStart/onStop 维护；
            // 一旦时序错位（重装、服务被桥拉起、Activity 提前 onStart），它就会永久卡住 ——
            // 实测现象就是"回到桌面了、鲸鱼还是不显示"（用户报"悬浮球不见了"）。
            // 无障碍服务的 activePackage 是系统事件直接给的，不会卡。
            if (AccessibilityService.isRunning) {
                String fg = AccessibilityService.activePackage;
                if (fg != null && !fg.isEmpty()) {
                    boolean dshInFront = fg.equals(getPackageName());
                    if (dshInFront == foregroundWantsHidden) {
                        // 与生命周期标志不一致 → 以真实前台为准
                        foregroundWantsHidden = dshInFront;
                        logVis("fg-heal: activePackage=" + fg + " -> fgHidden=" + dshInFront);
                    }
                }
            }
            boolean wantVisible = !foregroundWantsHidden && !userHidden;
            if (wantVisible != visible) {
                logVis("selfheal: want=" + wantVisible + " visible=" + visible
                        + " fgHidden=" + foregroundWantsHidden + " userHidden=" + userHidden);
                applyVisibleNow();
            }
            // v1.44：旋转自愈。普通 Service 不一定收到 onConfigurationChanged，
            // 而位置算错 = 触摸区域错位 = "看得见点不着"。这里每 2 秒对一次账。
            int w = getResources().getDisplayMetrics().widthPixels;
            int h = getResources().getDisplayMetrics().heightPixels;
            if (w != lastScreenW || h != lastScreenH) {
                logVis("rotate-heal: " + lastScreenW + "x" + lastScreenH + " -> " + w + "x" + h);
                lastScreenW = w; lastScreenH = h;
                relayoutForCurrentScreen();
            }
        } catch (Throwable ignored) {}
    }

    /** 记录上一次用于摆放的屏幕尺寸（旋转自愈的基准）。 */
    private int lastScreenW = 0;
    private int lastScreenH = 0;

    /** 按当前屏幕尺寸重算窗口位置/边界（旋转自愈与 onConfigurationChanged 共用）。 */
    private void relayoutForCurrentScreen() {
        try {
            if (lp == null || rootView == null) return;
            if (panelVisible) applyReplyWidth();
            // v1.61：旋转后按当前吸附边重新摆放（上下左右都支持）
            applyDockPos();
            settleAfterLayout();
        } catch (Throwable ignored) {}
    }

    /**
     * v1.39 诊断：可见性每次**变化**都记一行（<cacheDir>/ovl-visible.log）。
     * 排查"窗口在、surface 没有、点不动"时，这份日志能直接指出是谁把鲸鱼藏了。
     */
    private void logVis(String why) {
        try {
            File f = new File(getCacheDir(), "ovl-visible.log");
            if (f.exists() && f.length() > 64 * 1024) f.delete();
            String line = System.currentTimeMillis() + " " + why + "\n";
            java.io.FileOutputStream os = new java.io.FileOutputStream(f, true);
            try { os.write(line.getBytes("UTF-8")); } finally { try { os.close(); } catch (Throwable ignored) {} }
        } catch (Throwable ignored) {}
    }

    /** 悬浮球内部状态（供 /overlay status 自述，排查用）。 */
    public static String debugState() {
        OverlayService s = instance;
        if (s == null) return "{\"instance\":null,\"isRunning\":" + isRunning + ",\"visible\":" + visible + "}";
        try {
            // v1.44：把"窗口坐标"和"图标真实位置"一起报出来。
            // 用户反馈"要点悬浮球最底部才能弹出聊天框" → 说明可触摸区比看得见的圆大得多，
            // 这两个数一比就能确认偏移量，不用再靠截图估。
            int[] loc = new int[2];
            if (s.rootView != null) s.rootView.getLocationOnScreen(loc);
            int[] iloc = new int[2];
            if (s.iconView != null) s.iconView.getLocationOnScreen(iloc);
            return "{\"instance\":true,\"isRunning\":" + isRunning
                    + ",\"visible\":" + visible
                    + ",\"viewVisibility\":" + (s.rootView == null ? -1 : s.rootView.getVisibility())
                    + ",\"viewAttached\":" + (s.rootView != null && s.rootView.isAttachedToWindow())
                    + ",\"fgHidden\":" + s.foregroundWantsHidden
                    + ",\"userHidden\":" + s.userHidden
                    + ",\"panelVisible\":" + s.panelVisible
                    + ",\"dockSide\":" + s.dockSide
                    + ",\"lp\":[" + (s.lp == null ? -1 : s.lp.x) + "," + (s.lp == null ? -1 : s.lp.y) + "]"
                    + ",\"rootOnScreen\":[" + loc[0] + "," + loc[1] + "]"
                    + ",\"rootSize\":[" + (s.rootView == null ? -1 : s.rootView.getWidth())
                    + "," + (s.rootView == null ? -1 : s.rootView.getHeight()) + "]"
                    + ",\"iconOnScreen\":[" + iloc[0] + "," + iloc[1] + "]"
                    + ",\"iconSize\":[" + (s.iconView == null ? -1 : s.iconView.getWidth())
                    + "," + (s.iconView == null ? -1 : s.iconView.getHeight()) + "]"
                    + ",\"density\":" + s.getResources().getDisplayMetrics().density
                    + "}";
        } catch (Throwable t) {
            return "{\"error\":\"" + String.valueOf(t.getMessage()).replace("\"", "'") + "\"}";
        }
    }

    /**
     * v1.13.11：虚拟屏预览「收起到小鲸鱼」。
     * v1.13.12 语义收窄：pin 只代表"预览帧继续在小鲸鱼面板里拉"，**不再强制可见** ——
     * 之前它会盖过前台隐藏，用户在 App 里也会看到小鲸鱼（报过"偶尔在 dsh 中也显示小鲸鱼"）。
     * @param pin true=开始拉虚拟屏画面到面板；false=停止
     */
    public static void pinForVscreen(boolean pin) {
        OverlayService s = instance;
        if (s != null) s.applyVscreenPin(pin);
    }

    private void applyVscreenPin(boolean pin) {
        try {
            vscreenPinned = pin;
            if (pin) startVscreenPreview();
            else stopVscreenPreview();
        } catch (Throwable ignored) {}
    }

    /**
     * 实际可见性。v1.13.12 起规则只有两条：
     * ① App 在前台（foregroundWantsHidden）→ 隐藏，无论虚拟屏是否钉住；
     * ② 用户拖底主动隐藏（userHidden）→ 隐藏，直到通知栏「显示小鲸鱼」。
     */
    private void applyVisibleNow() {
        try {
            if (rootView != null) {
                boolean show = !foregroundWantsHidden && !userHidden;
                if (visible != show) {
                    logVis("apply: " + visible + " -> " + show
                            + " fgHidden=" + foregroundWantsHidden + " userHidden=" + userHidden);
                }
                rootView.setVisibility(show ? View.VISIBLE : View.GONE);
                visible = show;
                if (show) {
                    // v1.64：修"从通知栏恢复后小鲸鱼变得非常小"。
                    // 原因：窗口尺寸用的是 WindowManager 的"抹掉尺寸"常量（lp.width/height），
                    // 隐藏期间布局可能塌缩；恢复可见时若不重新测一次，视图会沿用塌缩后的尺寸。
                    // 这里把缩放/透明复位 + 重新按 WRAP_CONTENT 测一次 + 延迟再校一次位置。
                    rootView.setScaleX(1f);
                    rootView.setScaleY(1f);
                    rootView.setAlpha(1f);
                    if (iconView != null) {
                        iconView.setScaleX(1f); iconView.setScaleY(1f); iconView.setAlpha(1f);
                    }
                    if (lp != null) {
                        lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
                        lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
                        try { wm.updateViewLayout(rootView, lp); } catch (Throwable ignored) {}
                    }
                    rootView.requestLayout();
                    settleAfterLayout();
                }
            }
        } catch (Throwable ignored) {}
    }

    /**
     * v1.49 关键修复：改用**无障碍覆盖窗**（TYPE_ACCESSIBILITY_OVERLAY）。
     *
     * 为什么非改不可（2026-09-30 实测链条，全部有据）：
     *   · 窗口画得出来、描边与圆完全重合、`dumpsys input` 里
     *     `touchableRegion=[21,699][161,839]` 正好等于那 140×140 的圆、alpha=0.79；
     *   · 但**手指和注入触摸都到不了**，连 ACTION_DOWN 都没有（诊断日志一行不写）。
     * 这是 Android 12+ 对**不受信任的 TYPE_APPLICATION_OVERLAY** 的遮挡保护：
     *   只要下层窗口带 canOccludePresentation/BLOCK_UNTRUSTED（现代 App 基本都是），
     *   系统就有权把触摸收回去、不派发给第三方 overlay。
     * Android 官方对这个问题的推荐解法就是换成无障碍覆盖窗 —— 它属于系统信任的窗口类型。
     * 本机 DSH 的无障碍服务长期开启（用户自己开的），所以这条路稳定可用。
     *
     * 失败时回退到 TYPE_APPLICATION_OVERLAY，保证别的机器上至少还能显示。
     */
    private int overlayWindowType() {
        // v1.53：回到 TYPE_APPLICATION_OVERLAY。
        // v1.49 我按"官方推荐解法"换成了 TYPE_ACCESSIBILITY_OVERLAY —— 结果更糟：
        // 用户实测"桌面能看到鲸鱼但点不通"，且 cache 里连一个手势日志文件都没生成
        // （= 触摸处理分支从未执行）。无障碍覆盖窗挂在无障碍服务名下，
        // 触摸派发路径与应用覆盖窗不同，手指/注入触摸都可能被无障碍框架接管而到不了视图。
        // 而它能工作的时候用的就是应用覆盖窗，所以这里还原。
        if (Build.VERSION.SDK_INT >= 26) return WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        return WindowManager.LayoutParams.TYPE_PHONE;
    }

    /** v1.53：统一用应用自己的 WindowManager（与窗口类型配套，别再用无障碍服务的）。 */
    private WindowManager pickWindowManager() {
        return (WindowManager) getSystemService(WINDOW_SERVICE);
    }

    private void addToWindow() {
        int type = overlayWindowType();
        lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        // FLAG_LAYOUT_NO_LIMITS：允许窗口越出屏幕边界（虚拟屏预览等用得上）
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                PixelFormat.TRANSLUCENT);
        // v1.47：显式置零 CENTER 位。
        // 原来写完 TOP|START 之后又给 lp.gravity 留了 CENTER 位的历史残留，
        // 配合 FLAG_LAYOUT_NO_LIMITS 会让窗口的**实际落点**与 getLocationOnScreen()
        // 报的坐标不一致（这正是"看得见的圆"和"能点的区域"错开的可疑来源）。
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = dp(12);
        lp.y = dp(160);
        // v1.51：把不透明度改回 1.0。
        // v1.41 我按"Android 12 起 SYSTEM_ALERT_WINDOW 的 overlay 必须相当透明"这条
        // 行为变更，把 alpha 从 1 降到 0.79，指望它换来触摸可派发 —— 现在看这是**反效果**：
        // 用户明确反馈"最开始的原版能打开"，而原版就是 alpha=1。
        // 那条规则管的是 FLAG_NOT_TOUCHABLE（点击穿透），跟"我们这种需要自己收触摸的窗口"
        // 不是一回事；降 alpha 反而可能把窗口推进了"不接收触摸"的判定里。
        lp.alpha = 1.0f;
        try {
            wm.addView(rootView, lp);
            // 只做一次"布局落定后摆正"。
            // ⚠ 不要在这里挂长期的 OnLayoutChangeListener：拖动窗口、以及系统重测宽度
            // 都会触发 layoutChange，长期监听会把 x 每帧拽回贴边位 ——
            // 表现就是"小鲸鱼横向拖不动"。而这里要修的只是"面板展开/收起瞬间
            // getWidth() 还是旧值"，一次性摆正就够。
            settleAfterLayout();
        } catch (Throwable t) {
            // v1.49：无障碍覆盖窗被拒（无障碍服务没开/被系统收回）时回退到老的应用覆盖窗，
            // 至少还能显示，不至于整个浮窗消失。
            try {
                logVis("addView(ACCESSIBILITY_OVERLAY) failed: " + t);
                lp.type = Build.VERSION.SDK_INT >= 26
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE;
                wm.addView(rootView, lp);
                settleAfterLayout();
            } catch (Throwable t2) {
                stopSelf();
            }
        }
    }

    /**
     * v1.61：吸附到最近的边（上下左右都可），并根据面板状态决定"半隐藏"还是"完整贴边"。
     *
     * 半隐藏（tuck）：面板收起时把窗口推一部分到屏幕外，只露出一部分，静置不挡视野。
     * 完整贴边：面板展开时必须完整留在屏内，否则面板会被截掉。
     *
     * @param rawX 松手时的屏幕 x（用于判断吸附哪条边；传 -1 表示用窗口中心推算）
     * @param rawY 松手时的屏幕 y（同上）
     */
    private void snapToEdge(float rawX, float rawY) {
        try {
            if (lp == null || rootView == null) return;
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            int w = rootView.getWidth() > 0 ? rootView.getWidth() : dp(60);
            int h = rootView.getHeight() > 0 ? rootView.getHeight() : dp(56);

            // 用"手指位置"判断吸附边；没传就退回窗口中心（老调用点）
            int px = rawX >= 0 ? (int) rawX : lp.x + w / 2;
            int py = rawY >= 0 ? (int) rawY : lp.y + h / 2;
            // v1.64：**底边不参与吸附**（用户明确不要）。
            // 底边和"拖底隐藏"抢同一个向下手势，怎么做都别扭；顶部/左右已经够用。
            int dLeft = px, dRight = screenW - px, dTop = py;
            int min = Math.min(Math.min(dLeft, dRight), dTop);
            if (min == dLeft) dockSide = DOCK_LEFT;
            else if (min == dRight) dockSide = DOCK_RIGHT;
            else dockSide = DOCK_TOP;

            // 半隐藏的位移量：露出一部分（收起态）或 0（展开态）
            int offW = Math.round(w * (1f - TUCK_VISIBLE_FRACTION));
            // v1.64：上边**不能用满 offH**。窗口 y 是相对状态栏下沿的坐标，
            // 直接 -offH 会把鲸鱼推进状态栏/挖孔区里（实测 frame 顶到 y=31，用户"看不到"）。
            // 上边改成只收 TUCK_TOP_DP，让鲸鱼贴在状态栏下沿露出大半。
            int offH = dp(TUCK_TOP_DP);
            boolean tuck = !panelVisible;

            switch (dockSide) {
                case DOCK_LEFT:
                    lp.x = tuck ? -offW : dp(EDGE_GAP_DP);
                    lp.y = clampY(lp.y, h, screenH);
                    break;
                case DOCK_RIGHT:
                    lp.x = tuck ? screenW - w + offW : Math.max(dp(EDGE_GAP_DP), screenW - w - dp(EDGE_GAP_DP));
                    lp.y = clampY(lp.y, h, screenH);
                    break;
                case DOCK_TOP:
                    lp.y = tuck ? -offH : dp(EDGE_GAP_DP);
                    lp.x = clampX(lp.x, w, screenW);
                    break;
                default: // v1.64：不再有 DOCK_BOTTOM；兜底按左/右处理
                    lp.x = tuck ? -offW : dp(EDGE_GAP_DP);
                    lp.y = clampY(lp.y, h, screenH);
                    break;
            }
            wm.updateViewLayout(rootView, lp);
        } catch (Throwable ignored) {}
    }

    private int clampX(int x, int w, int screenW) {
        int max = Math.max(0, screenW - w);
        if (x < 0) x = 0;
        if (x > max) x = max;
        return x;
    }

    private int clampY(int y, int h, int screenH) {
        int max = Math.max(0, screenH - h);
        if (y < 0) y = 0;
        if (y > max) y = max;
        return y;
    }

    /**
     * v1.61：按 dockSide + 面板状态算出正确落点（把窗口摆正）。
     * 与 snapToEdge 的区别：这里**不改 dockSide**，只按已知的边重新摆放，
     * 供布局落定、旋转、面板开合后校正用。
     */
    private void applyDockPos() {
        try {
            if (lp == null || rootView == null) return;
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            int w = rootView.getWidth() > 0 ? rootView.getWidth() : dp(60);
            int h = rootView.getHeight() > 0 ? rootView.getHeight() : dp(56);
            // 先按当前边把"垂直/水平方向"夹回屏内，避免窗口跑到屏幕外找不回来
            if (dockSide == DOCK_LEFT || dockSide == DOCK_RIGHT) {
                lp.y = clampY(lp.y, h, screenH);
            } else {
                lp.x = clampX(lp.x, w, screenW);
            }
            wm.updateViewLayout(rootView, lp);
        } catch (Throwable ignored) {}
    }

    /**
     * v1.61 贴边规则小结
     * （v1.13.12 的"半藏"曾在 v1.38 被误当成触摸故障元凶而取消；现已查明真凶是
     *  iconView 上的长按监听，故恢复并扩展到四边）：
     *
     *  · 面板收起（静置）→ **半藏**：把窗口推一部分到屏幕外，只露 TUCK_VISIBLE_FRACTION，
     *    不起眼、不挡视野；左/右/上/下四条边都支持（横屏游戏时上下更合适）。
     *  · 面板展开 → **完整贴边**：面板必须完整留在屏内，否则会被截掉。
     */

    /** 面板显示/隐藏；animate=true 时带旋转抖动 + 位置过渡（唤出、收起共用）。 */
    private void setPanelVisible(boolean show, boolean animate) {
        panelVisible = show;
        if (panelView != null) panelView.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show) {
            refreshPanelDynamicRows();
            // v1.38：回复区只在**真有消息**时才露出来（用户要求：没发消息时它不该出现）。
            // 所以这里不再自动去读会话文件 —— 打开面板只是把已有内容按需显示。
            boolean has = hasReplyContent();
            setReplyShown(has);
            if (has) applyReplyWidth();   // 宽度必须夹在屏幕内（长回复不然会把面板撑出屏）
        }
        if (lp == null) return;
        lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
        lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
        try { wm.updateViewLayout(rootView, lp); } catch (Throwable ignored) {}
        if (!animate) {
            snapToEdge(-1, -1);   // v1.61：不改吸附边，只按当前边+面板状态摆正
        } else {
            wiggle();
        }
        // 展开/收起必然改变窗口尺寸，而 getWidth() 在下一次 layout 之前仍是旧值：
        // 用它算贴边坐标 → 展开时按"图标宽度"摆（面板被推出右边）、收起时按"面板宽度"
        // 算半藏位（整只鲸鱼被推出屏幕）。又因为 FLAG_LAYOUT_NO_LIMITS 系统不夹边界，
        // 算错就真的出屏。原实现用 rootView.post() 补救，但 post 只延后一条消息、
        // 常常仍在下一次 layout 之前，等于没夹。改为等布局真正落定后再算。
        settleAfterLayout();
    }

    /**
     * 布局真正落定后，按**真实尺寸**重算贴边位置。
     * 这是"小鲸鱼/面板跑出屏幕"的根因修法 —— 不能再依赖调用时刻的 getWidth()。
     */
    private void settleAfterLayout() {
        try {
            if (rootView == null) return;
            rootView.getViewTreeObserver().addOnGlobalLayoutListener(
                    new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
                @Override public void onGlobalLayout() {
                    try {
                        android.view.ViewTreeObserver vto = rootView.getViewTreeObserver();
                        if (vto.isAlive()) vto.removeOnGlobalLayoutListener(this);
                    } catch (Throwable ignored) {}
                    applyEdgePos(true);
                }
            });
        } catch (Throwable ignored) {
            applyEdgePos(false);
        }
    }

    /**
     * 布局落定后把窗口摆到「当前吸附边 + 当前面板状态」对应的正确落点。
     * v1.61：改为委托 animateToEdge()（它已按四边半藏算好目标位，带平滑过渡）。
     * @param animate 是否平滑过渡（布局刚落定时用 true，观感更顺）
     */
    private void applyEdgePos(boolean animate) {
        try {
            if (lp == null || rootView == null) return;
            if (animate) {
                animateToEdge();
            } else {
                applyDockPos();
            }
        } catch (Throwable ignored) {}
    }

    /** 面板每次展开时刷新"看场景才该出现"的行（如销毁屏按钮）。 */
    private void refreshPanelDynamicRows() {
        try {
            if (destroyBtn != null) {
                destroyBtn.setVisibility(VsreenBridgeService.sVscreenRunning
                        ? View.VISIBLE : View.GONE);
            }
        } catch (Throwable ignored) {}
    }

    /** 触点是否落在面板矩形内（用于区分"点空白收起"和"点面板内部"）。 */
    private boolean insidePanel(float rawX, float rawY) {
        try {
            if (panelView == null || panelView.getVisibility() != View.VISIBLE) return false;
            int[] loc = new int[2];
            panelView.getLocationOnScreen(loc);
            return rawX >= loc[0] && rawX <= loc[0] + panelView.getWidth()
                    && rawY >= loc[1] && rawY <= loc[1] + panelView.getHeight();
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * v1.25：把回复区的宽度夹在屏幕内。
     * 悬浮窗是 WRAP_CONTENT，一段长回复（几百字一行不换行的地方）会把窗口撑得比屏幕宽，
     * FLAG_LAYOUT_NO_LIMITS 又不会帮你夹 —— 结果面板横着跑出屏幕。
     * ScrollView 自己不知道上限，所以这里显式算一个：屏宽的 78%，上限 260dp。
     */
    private void applyReplyWidth() {
        try {
            if (replyScroll == null) return;
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int max = Math.max(dp(150), Math.min((int) (screenW * 0.78f), dp(260)));
            android.view.ViewGroup.LayoutParams lp2 = replyScroll.getLayoutParams();
            if (lp2 != null && lp2.width != max) {
                lp2.width = max;
                replyScroll.setLayoutParams(lp2);
            }
        } catch (Throwable ignored) {}
    }

    /**
     * 「看一眼最新回复」：强制把回复区显示出来并读一次。
     *
     * ⚠ v1.60：当前**没有挂到任何触摸监听**（原来是挂 iconView 的长按，那就是"点不中悬浮球"
     * 的根因，已删）。保留这个方法是为了将来接"不消费触摸"的入口 ——
     * 例如在 rootView 的 onTouch 里自己做长按判定，或由通知/桥触发。
     */
    private void peekReply() {
        replyHasContent = true;
        refreshReply(true);
    }

    /**
     * 位置过渡：把窗口从当前位置平滑滑到「当前吸附边 + 当前面板状态」对应的正确落点。
     * v1.61：改为按方向（左右滑 x、上下滑 y）动画，兼容四边半藏。
     */
    private void animateToEdge() {
        try {
            if (lp == null || rootView == null) return;
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            int w = rootView.getWidth() > 0 ? rootView.getWidth() : dp(60);
            int h = rootView.getHeight() > 0 ? rootView.getHeight() : dp(56);
            int offW = Math.round(w * (1f - TUCK_VISIBLE_FRACTION));
            int offH = Math.round(h * (1f - TUCK_VISIBLE_FRACTION));
            boolean tuck = !panelVisible;
            final int targetX, targetY;
            switch (dockSide) {
                case DOCK_RIGHT:
                    targetX = tuck ? screenW - w + offW : Math.max(dp(EDGE_GAP_DP), screenW - w - dp(EDGE_GAP_DP));
                    targetY = clampY(lp.y, h, screenH);
                    break;
                case DOCK_TOP:
                    targetY = tuck ? -offH : dp(EDGE_GAP_DP);
                    targetX = clampX(lp.x, w, screenW);
                    break;
                case DOCK_BOTTOM:
                    targetY = tuck ? screenH - h + offH : Math.max(dp(EDGE_GAP_DP), screenH - h - dp(EDGE_GAP_DP));
                    targetX = clampX(lp.x, w, screenW);
                    break;
                default: // DOCK_LEFT
                    targetX = tuck ? -offW : dp(EDGE_GAP_DP);
                    targetY = clampY(lp.y, h, screenH);
                    break;
            }
            final int fromX = lp.x, fromY = lp.y;
            if (fromX == targetX && fromY == targetY) return;
            android.animation.ValueAnimator va =
                    android.animation.ValueAnimator.ofFloat(0f, 1f);
            va.setDuration(260);
            va.setInterpolator(new OvershootInterpolator(0.6f));
            va.addUpdateListener(new android.animation.ValueAnimator.AnimatorUpdateListener() {
                @Override public void onAnimationUpdate(android.animation.ValueAnimator a) {
                    if (lp == null || rootView == null) return;
                    float t = (Float) a.getAnimatedValue();
                    lp.x = Math.round(fromX + (targetX - fromX) * t);
                    lp.y = Math.round(fromY + (targetY - fromY) * t);
                    try { wm.updateViewLayout(rootView, lp); } catch (Throwable ignored) {}
                }
            });
            va.start();
        } catch (Throwable ignored) {}
    }

    /** 旋转抖动动画（唤出/收起时的"小鲸鱼摆尾巴"）。只转图标，不转整块面板。 */
    private void wiggle() {
        try {
            if (iconView == null) return;
            android.animation.ObjectAnimator.ofFloat(
                    iconView, View.ROTATION, 0f, -14f, 11f, -8f, 5f, 0f)
                    .setDuration(420)
                    .start();
        } catch (Throwable ignored) {}
    }

    /**
     * 拖动中：真正拖到**屏幕最底那一条**时才给出"松手即隐藏"的暗示（图标缩小变淡）。
     *
     * v1.62：隐藏区从 84dp 收窄到 DISMISS_ZONE_EDGE_DP。
     * 原来底部 84dp 全算"松手即隐藏"，和"下边吸附 + 半藏"直接打架
     * —— 用户把鲸鱼拖到下边想半藏，结果被整个收起来了。
     * 现在只有拖出屏幕边缘一小条才隐藏，其余底部区域 = 正常吸附半藏。
     */
    private void updateDismissHint(float rawY) {
        int screenH = getResources().getDisplayMetrics().heightPixels;
        boolean inZone = rawY > screenH - dp(DISMISS_ZONE_EDGE_DP);
        if (inZone != dismissHint) setDismissHintInternal(inZone);
    }

    private void setDismissHintInternal(boolean on) {
        dismissHint = on;
        try {
            if (iconView == null) return;
            iconView.animate().scaleX(on ? 0.62f : 1f).scaleY(on ? 0.62f : 1f)
                    .alpha(on ? 0.7f : 1f).setDuration(140).start();
        } catch (Throwable ignored) {}
    }

    /**
     * v1.38 诊断日志：把悬浮窗收到的手势写进 <cacheDir>/ovl-gesture.log。
     *
     * 为什么留它：用户报「拖不动悬浮球」时，最难判断的是**触摸到底有没有到应用**
     * （没到 = 被系统边缘手势/上层窗口抢走；到了但被 cancel = 中途被抢；正常 up = 应用自己没处理好）。
     * 这三条日志一眼就能分开。纯文件写入，不影响功能，可随时删。
     */
    private void logDrag(String phase, MotionEvent ev, View v, boolean onRoot) {
        try {
            File f = new File(getCacheDir(), "ovl-gesture.log");
            if (f.exists() && f.length() > 200 * 1024) f.delete();   // 别无限长
            String line = System.currentTimeMillis()
                    + " " + phase
                    + " dragging=" + dragging
                    + " raw=(" + (int) ev.getRawX() + "," + (int) ev.getRawY() + ")"
                    + " start=(" + startX + "," + startY + ")"
                    + " win=(" + (lp != null ? lp.x : -1) + "," + (lp != null ? lp.y : -1) + ")"
                    + " v=" + (v == rootView ? "root" : "child")
                    + " panel=" + panelVisible
                    + " onRoot=" + onRoot + "\n";
            java.io.FileOutputStream os = new java.io.FileOutputStream(f, true);
            try { os.write(line.getBytes("UTF-8")); } finally { try { os.close(); } catch (Throwable ignored) {} }
        } catch (Throwable ignored) {}
    }

    /**
     * v1.55 关键实测：把"手指的屏幕坐标"和"应用当时算出来的圆坐标"写进
     * <cacheDir>/ovl-touch.log。
     *
     * 用途：用户反馈"必须按住白色圆形的最底部才响应" —— 也就是可触摸区相对圆整体偏下。
     * 有了这两组数，偏移量（方向 + 像素）就是算出来的，不用再靠截图目测：
     *   算出的圆底边 = iconOnScreen.y + iconSize.h
     *   手指 y       = rawY
     * 若手指 y 明显大于圆的底边才有效，就说明真实窗口比自报坐标低，差值即需修正的偏移。
     */
    private void logTouchProbe(MotionEvent ev) {
        try {
            int[] rloc = new int[2], iloc = new int[2];
            if (rootView != null) rootView.getLocationOnScreen(rloc);
            if (iconView != null) iconView.getLocationOnScreen(iloc);
            File f = new File(getCacheDir(), "ovl-touch.log");
            if (f.exists() && f.length() > 128 * 1024) f.delete();
            String line = "raw=(" + (int) ev.getRawX() + "," + (int) ev.getRawY() + ")"
                    + " rootOnScreen=(" + rloc[0] + "," + rloc[1] + ")"
                    + " rootSize=(" + (rootView == null ? -1 : rootView.getWidth())
                    + "," + (rootView == null ? -1 : rootView.getHeight()) + ")"
                    + " iconOnScreen=(" + iloc[0] + "," + iloc[1] + ")"
                    + " iconSize=(" + (iconView == null ? -1 : iconView.getWidth())
                    + "," + (iconView == null ? -1 : iconView.getHeight()) + ")"
                    + " lp=(" + (lp == null ? -1 : lp.x) + "," + (lp == null ? -1 : lp.y) + ")"
                    + " panel=" + panelVisible
                    + " winVis=" + (rootView == null ? -1 : rootView.getVisibility()) + "\n";
            java.io.FileOutputStream os = new java.io.FileOutputStream(f, true);
            try { os.write(line.getBytes("UTF-8")); } finally { try { os.close(); } catch (Throwable ignored) {} }
        } catch (Throwable ignored) {}
    }

    /** 拖到底部松手：隐藏小鲸鱼（通知栏「显示小鲸鱼」可恢复）。 */
    private void hideByDragToBottom() {
        userHidden = true;
        // v1.63 诊断：把"隐藏分支被触发时的现场"记进手势日志。
        // 用户反馈"拖到底部直接收起来了"，但按代码应该先命中底边半藏 ——
        // 这条日志能确认到底是不是走了这个分支，以及当时松手在哪。
        logDrag("hideByDragToBottom", null, rootView, false);
        try {
            rootView.animate().alpha(0f).scaleX(0.5f).scaleY(0.5f).setDuration(180)
                    .withEndAction(new Runnable() { @Override public void run() {
                        try {
                            rootView.setAlpha(1f);
                            setDismissHintInternal(false);
                            applyVisibleNow();
                        } catch (Throwable ignored) {}
                    }}).start();
        } catch (Throwable ignored) {
            applyVisibleNow();
        }
        try {
            android.widget.Toast.makeText(getApplicationContext(),
                    "小鲸鱼已隐藏，可从通知栏「显示小鲸鱼」恢复", android.widget.Toast.LENGTH_LONG).show();
        } catch (Throwable ignored) {}
    }

    private void clampPanelOnScreen() {
        try {
            if (lp == null || rootView == null) return;
            int w = rootView.getWidth();
            if (w <= 0) return;
            // v1.61：收起时按当前吸附边重新摆正（四边都支持），展开时只夹水平位置
            if (!panelVisible) {
                applyDockPos();
                return;
            } else {
                int maxX = getResources().getDisplayMetrics().widthPixels - w - dp(4);
                if (lp.x > maxX) lp.x = Math.max(dp(4), maxX);
                int maxY = getResources().getDisplayMetrics().heightPixels - rootView.getHeight() - dp(4);
                if (lp.y > maxY) lp.y = Math.max(dp(4), maxY);
            }
            wm.updateViewLayout(rootView, lp);
        } catch (Throwable ignored) {}
    }

    // ==================== 屏幕旋转（v1.44 关键修复） ====================
    //
    // 症状（2026-09-30 实测，用户报"看得到小鲸鱼但点它完全没反应"）：
    //   横屏 App（游戏）在前台时，`dumpsys input` 里鲸鱼窗口的触摸区域还是**竖屏坐标**
    //   （实测 [996,160][1206,398]），而画面已经 2772x1240 —— 绘制位置和触摸区域错位，
    //   手指点在"看得见的那只鲸鱼"上，事件落在屏幕别处，所以连 ACTION_DOWN 都没有。
    //
    // 根因：主 Activity 声明了 `configChanges="orientation|screenSize|keyboardHidden"`，
    //   旋转由 Activity 自己吞掉；而 OverlayService 是**普通 Service**，不会因为旋转重建，
    //   于是 `lp.x/lp.y` 永远停在旋转前按竖屏算的那套坐标，触摸区域也跟着错。
    //
    // 修法：旋转后按**新的屏幕尺寸**重算位置与边界，并同步窗口。
    @Override
    public void onConfigurationChanged(android.content.res.Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        try {
            // 与探针里的旋转自愈共用一个实现，避免两处逻辑漂移
            int w = getResources().getDisplayMetrics().widthPixels;
            int h = getResources().getDisplayMetrics().heightPixels;
            logVis("onConfigurationChanged: " + w + "x" + h);
            lastScreenW = w; lastScreenH = h;
            relayoutForCurrentScreen();
        } catch (Throwable ignored) {}
    }

    // ==================== 引擎探测 / AI 会话状态 ====================

    /** 探测引擎是否在跑。
     *  v1.13：0.1.5 起首页需要一次性 token —— 不带 token 返回 401 + 纯文本
     *  “dsh web authentication required…”，带有效 token 返回 303 跳转；两种都说明“引擎在跑”。 */
    private boolean engineAlive(int port) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/").openConnection();
            c.setConnectTimeout(1200);
            c.setReadTimeout(1500);
            c.setRequestProperty("User-Agent", "dsh-overlay-probe");
            c.setInstanceFollowRedirects(false);
            int code = c.getResponseCode();
            if (code == 303 || code == 302) return true;
            if (code == 401) return bodyContains(c, "dsh web authentication required");
            if (code < 200 || code >= 500) return false;
            InputStream in = c.getInputStream();
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
            if (c != null) c.disconnect();
        }
    }

    /** 读一小段响应正文（401 的正文在错误流里）。 */
    private boolean bodyContains(HttpURLConnection c, String needle) {
        try {
            InputStream in = null;
            try { in = c.getInputStream(); } catch (Throwable t) { in = c.getErrorStream(); }
            if (in == null) return false;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[2048];
            int r;
            while ((r = in.read(buf)) > 0 && out.size() < 8192) out.write(buf, 0, r);
            try { in.close(); } catch (Throwable ignored) {}
            return out.toString("UTF-8").contains(needle);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 扫出"正在被引擎写入"的会话集合（session 目录路径）。
     *
     * 机制依据：dsh-session-persistence-jsonl 的 SessionWriteLease 在会话写入器存活期间
     * 持有 <会话目录>/session.lock 的独占锁，释放 = 关闭 fd。所以
     * 「同 uid 进程的 /proc/<pid>/fd 里存在指向 session.lock 的 fd」⟺ 该会话正在工作。
     * node 是本 App 的子进程（同 uid），/proc 对同 uid 可读 —— findEnginePid 已验证过这条路。
     *
     * 旧实现走 POST /api/session.list：0.1.5 起要认证 cookie，悬浮窗拿不到（永远 401），
     * 表现就是"AI：空闲"永远不变。此扫描不需要任何认证。
     *
     * /proc 完全扫不动（被 SELinux 拦等极端情况）返回 null，调用方保持上次结果。
     */
    private HashSet<String> scanActiveSessions() {
        HashSet<String> out = new HashSet<String>();
        try {
            File[] procs = new File("/proc").listFiles();
            if (procs == null) return null;
            for (File d : procs) {
                String name = d.getName();
                if (name == null || name.isEmpty() || !Character.isDigit(name.charAt(0))) continue;
                File fdDir = new File(d, "fd");
                String[] fds;
                try { fds = fdDir.list(); } catch (Throwable t) { fds = null; }
                if (fds == null) continue;   // 别的 uid 的进程：无权读，跳过
                for (String fd : fds) {
                    String target;
                    try { target = new File(fdDir, fd).getCanonicalPath(); } catch (Throwable t) { continue; }
                    int i = target.indexOf("/dshhome/sessions/");
                    if (i < 0) continue;
                    if (!target.endsWith("/session.lock")) continue;
                    // 会话目录 = session.lock 所在目录（…/sessions/<cwd编码>/<session-id>）
                    out.add(target.substring(0, target.lastIndexOf('/')));
                }
            }
            return out;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 更新悬浮窗状态文字 + 常驻通知（在主线程调用）。 */
    private void updateEngineStatusUi() {
        if (statusText != null) {
            statusText.setText("状态：" + (engineUp ? "引擎运行中 ✓" : "引擎未运行"));
        }
        if (aiText != null) {
            aiText.setText(aiStatusText());
        }
        // 面板开着的话顺带刷新销毁屏按钮的可见性
        if (panelVisible) refreshPanelDynamicRows();
        // 更新常驻通知
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_ID, buildNotification());
        } catch (Throwable ignored) {}
    }

    /**
     * AI 状态行：空闲 / 工作中会话（可多个）/ 已完成。
     *  - 有持锁会话 → "工作中 N 个会话"；
     *  - 上次还工作中、现在没了 → 记一个"刚完成"时间点，60 秒内显示"已完成"；
     *  - 其余 → "空闲"。引擎不在跑时显示"—"。
     */
    private String aiStatusText() {
        if (!engineUp) return "AI：—";
        HashSet<String> cur = activeSessions;
        if (cur == null) return "AI：—";       // 还没扫过 / /proc 扫不了
        int n = cur.size();
        long now = System.currentTimeMillis();
        if (n > 0) {
            lastSessionsHadWork = true;   // 边沿触发源：从"有会话工作"变"没有"时报已完成
            finishedAt = 0L;
            return n == 1 ? "AI：1 个会话工作中…" : "AI：" + n + " 个会话工作中…";
        }
        if (finishedAt == 0L && lastSessionsHadWork) {
            finishedAt = now;
        }
        if (finishedAt > 0L && now - finishedAt < FINISHED_TTL_MS) {
            return "AI：会话已完成 ✓";
        }
        lastSessionsHadWork = false;
        return "AI：空闲";
    }
    /** 上次扫描是否看到过工作中的会话（用于"已完成"的边沿触发）。 */
    private volatile boolean lastSessionsHadWork = false;

    // ==================== v1.9 虚拟屏预览（悬浮窗实时看 AI 操作虚拟屏） ====================

    /** 开始虚拟屏预览：每 ~1s 拉 server /preview（base64 JPEG）并显示到悬浮窗。 */
    public void startVscreenPreview() {
        if (vscreenPreviewRunning) return;
        vscreenPreviewRunning = true;
        vscreenHandler.post(vscreenPreviewRunnable);
    }

    /** 停止虚拟屏预览。 */
    public void stopVscreenPreview() {
        vscreenPreviewRunning = false;
        vscreenHandler.removeCallbacks(vscreenPreviewRunnable);
        if (vscreenImageView != null) {
            vscreenHandler.post(new Runnable() {
                @Override public void run() {
                    vscreenImageView.setVisibility(View.GONE);
                }
            });
        }
    }

    /** 预览帧拉取任务：HTTP GET 127.0.0.1:8999/vscreen/preview → base64 JPEG → ImageView。 */
    private final Runnable vscreenPreviewRunnable = new Runnable() {
        @Override public void run() {
            if (!vscreenPreviewRunning || !isRunning) return;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:8999/vscreen/preview").openConnection();
                c.setConnectTimeout(2000); c.setReadTimeout(2000);
                String resp = readAll(c.getInputStream());
                c.disconnect();
                JSONObject o = new JSONObject(resp);
                if (o.optBoolean("ok", false)) {
                    String b64 = o.optString("previewB64");
                    if (b64 != null && !b64.isEmpty()) {
                        byte[] bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                        final android.graphics.Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                        if (bmp != null) {
                            vscreenHandler.post(new Runnable() {
                                @Override public void run() {
                                    if (vscreenImageView != null) {
                                        vscreenImageView.setImageBitmap(bmp);
                                        vscreenImageView.setVisibility(View.VISIBLE);
                                    }
                                }
                            });
                        }
                    }
                }
            } catch (Throwable ignored) {
                // server 未跑（虚拟屏未创建）时静默，预览保持隐藏
            }
            vscreenHandler.postDelayed(this, 1000);
        }
    };

    private String readAll(java.io.InputStream in) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[8192]; int n;
        while ((n = in.read(b)) > 0) bos.write(b, 0, n);
        return bos.toString("UTF-8");
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
