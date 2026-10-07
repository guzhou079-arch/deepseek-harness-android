package com.deepseek.harness;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
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
    /** v1.37：面板上的「开/关虚拟屏」按钮。 */
    private Button vscreenBtn;
    // v1.9 虚拟屏预览：悬浮窗实时显示虚拟屏画面（用户可看 AI 操作）
    private ImageView vscreenImageView = null;
    // v1.67：面板里的输入框引用（收起面板时要主动还焦点/关输入法/恢复 NOT_FOCUSABLE）
    private android.widget.EditText chatInputView = null;
    // v1.67 诊断：当前球上是不是桌宠图（false = 兜底 ic_whale_black）
    private volatile boolean iconIsPet = false;
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
     * 设计约束：没发消息时不要出现、发了消息才出现 —— 所以打开面板不再自动加载历史回复，
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
     * 设计约束：左右能半隐藏外、上下也可以 —— 横屏打游戏时左右贴边会让画面很别扭，
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
        loadPetConfig();   // v1.71：先说 pet.json（球大小/裁剪/台词），再建视图
        loadBalanceState();   // v1.75：恢复「今日已用」的记账（自然日/起点余额）
        loadCardPrefs();      // v1.83：用户自己对「流体云」的开关（优先于 pet.json 的默认值）
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
        VoiceManager.get(this).addCallback(voiceCallback);
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
                    s.setUserHidden(false);
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
        // 通知栏「显示小鲸鱼」：解除用户关闭并抖一下示意（v1.88 起通知栏那个按钮走下面的两态开关）
        if (intent != null && ACTION_SHOW.equals(intent.getAction())) {
            setUserHidden(false);
            applyVisibleNow();
            wiggle();
        }
        // v1.88：通知栏「开启/关闭悬浮球」一键开关（与「流体云:开/关」同一套：先动状态，再刷新按钮文字）
        if (intent != null && ACTION_TOGGLE_BALL.equals(intent.getAction())) {
            try { toggleBall(); } catch (Throwable ignored) {}
            try { startForegroundCompat(); } catch (Throwable ignored) {}
        }
        // v1.84：通知栏「流体云:开/关」
        if (intent != null && ACTION_TOGGLE_FLUID.equals(intent.getAction())) {
            setFluid(!cardAutoShow);
            try { startForegroundCompat(); } catch (Throwable ignored) {}   // 刷新通知上那行文字
        }
        // v1.37：通知栏「开/关虚拟屏」
        if (intent != null && ACTION_TOGGLE_VSCREEN.equals(intent.getAction())) {
            try { VsreenBridgeService.toggleFromUi(); } catch (Throwable ignored) {}
            try { startForegroundCompat(); } catch (Throwable ignored) {}   // 刷新按钮文字
        }
        // v1.43：通知栏「开关面板」—— 悬浮窗收不到触摸时的固定入口
        if (intent != null && ACTION_TOGGLE_PANEL.equals(intent.getAction())) {
            try {
                setUserHidden(false);   // v1.88：开面板 = 用户要它，顺手把"关闭"状态解除并落盘
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
    /** v1.37：通知栏「开/关虚拟屏」。 */
    private static final String ACTION_TOGGLE_VSCREEN = "com.deepseek.harness.overlay.TOGGLE_VSCREEN";
    /** v1.88：通知栏「隐藏/显示小鲸鱼」—— 一键开关悬浮球（两态文案）。 */
    private static final String ACTION_TOGGLE_BALL = "com.deepseek.harness.overlay.TOGGLE_BALL";

    @Override
    public void onDestroy() {
        isRunning = false;
        if (instance == this) instance = null;
        VoiceManager.get(this).removeCallback(voiceCallback);
        stopVscreenPreview();
        handler.removeCallbacksAndMessages(null);
        hideBubble();   // v1.71：气泡是第二个窗口，必须一起 remove
        hideCard();     // v1.77：回复卡是第三个窗口，同样要 remove
        if (rootView != null && wm != null) {
            try { wm.removeView(rootView); } catch (Throwable ignored) {}
        }
        super.onDestroy();
    }

    private final VoiceManager.VoiceCallback voiceCallback = new VoiceManager.VoiceCallback() {
        @Override
        public void onStateChange(final String state, final String message) {
            handler.post(new Runnable() {
                @Override
                public void run() {
                    if ("listening".equals(state) || "recording".equals(state)) {
                        showBubble("🎤 " + message, 6000);
                    } else if ("recognizing".equals(state) || "processing".equals(state)) {
                        showBubble("💭 " + message, 5000);
                    } else if ("speaking".equals(state)) {
                        showBubble("🔊 " + message, 4000);
                    }
                }
            });
        }

        @Override
        public void onResult(final String text, final boolean isFinal) {
            handler.post(new Runnable() {
                @Override
                public void run() {
                    if (text != null && !text.isEmpty()) {
                        showBubble((isFinal ? "🗣️ " : "🎤 ") + text, isFinal ? 5000 : 3000);
                    }
                }
            });
        }

        @Override
        public void onError(final String error) {
            handler.post(new Runnable() {
                @Override
                public void run() {
                    if (error != null && !error.isEmpty()) {
                        showBubble("⚠️ " + error, 3500);
                    }
                }
            });
        }
    };

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
        // v1.88：通知栏那一格改成**一键开关**（原来只有单向「显示小鲸鱼」，
        // 想关掉只能把球拖到屏幕底部 —— 用户报"没法直接关"）。
        // 文案看 userHidden（用户意图）而不是当前像素可见性：App 在前台时球本来就不显示，
        // 那时按钮若跟着说「显示」，用户会以为开关坏了。
        // （旧动作 ACTION_SHOW 仍然保留处理，老通知点下去照样能恢复。）
        Intent ball = new Intent(this, OverlayService.class);
        ball.setAction(ACTION_TOGGLE_BALL);
        PendingIntent ballPi = PendingIntent.getService(this, 5, ball,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try { b.addAction(new Notification.Action.Builder(null, ballLabel(), ballPi).build()); }
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
        // v1.84：把「流体云:开/关」也放到通知栏这一排，和小鲸鱼开关在一起
        Intent fluid = new Intent(this, OverlayService.class);
        fluid.setAction(ACTION_TOGGLE_FLUID);
        PendingIntent fluidPi = PendingIntent.getService(this, 3, fluid,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try { b.addAction(new Notification.Action.Builder(null, fluidLabel(), fluidPi).build()); }
        catch (Throwable ignored) {}
        // v1.37：虚拟屏开关也放通知栏这一排
        Intent vs = new Intent(this, OverlayService.class);
        vs.setAction(ACTION_TOGGLE_VSCREEN);
        PendingIntent vsPi = PendingIntent.getService(this, 4, vs,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        try { b.addAction(new Notification.Action.Builder(null, vscreenLabel(), vsPi).build()); }
        catch (Throwable ignored) {}
        return b.setContentTitle("DeepSeek Harness")
                .setContentText(engineUp ? "引擎运行中 · 点按回到应用" : "引擎未运行 · 点按回到应用")
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
    }

    /** v1.37：通知栏按钮文字随虚拟屏状态变。 */
    private String vscreenLabel() {
        try { return VsreenBridgeService.isVscreenRunning() ? "关虚拟屏" : "开虚拟屏"; }
        catch (Throwable t) { return "虚拟屏"; }
    }

    /**
     * v1.88：通知栏那一格的文字 —— 写成**动作**，不写状态（和「开/关流体云」同一个理由）。
     * 判据是 userHidden（**用户意图**），不是像素可见性：App 在前台时球本来就不显示，
     * 那时若跟着说「开启悬浮球」，用户会以为这个开关坏了。
     */
    private String ballLabel() {
        return userHidden ? "开启悬浮球" : "关闭悬浮球";
    }

    /**
     * v1.88：一键**开关**悬浮球 —— 用户要的是"关掉"，不是"藏一下"。
     *   关 = userHidden=true 且**落盘**（PREF_BALL_OFF）：
     *        球立刻淡出，而且 App 重启 / 换内核 / 服务被系统重建之后**都不会再自己冒出来**，
     *        直到用户自己点「开启悬浮球」。面板是 rootView 的子视图，所以关球时面板一起收，
     *        不会留一个"没有球的浮层"。
     *   开 = 解除并抖一下示意（与旧的「显示小鲸鱼」一致）。
     */
    private void toggleBall() {
        if (userHidden) {
            setUserHidden(false);
            applyVisibleNow();
            wiggle();
            return;
        }
        setUserHidden(true);
        if (panelVisible) { try { setPanelVisible(false, true); } catch (Throwable ignored) {} }
        try {
            rootView.animate().alpha(0f).scaleX(0.5f).scaleY(0.5f).setDuration(180)
                    .withEndAction(new Runnable() { @Override public void run() {
                        try {
                            rootView.setAlpha(1f);
                            applyVisibleNow();
                        } catch (Throwable ignored) {}
                    }}).start();
        } catch (Throwable ignored) {
            applyVisibleNow();
        }
        try {
            android.widget.Toast.makeText(getApplicationContext(),
                    "悬浮球已关闭，需要时点通知栏「开启悬浮球」",
                    android.widget.Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {}
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
            p.setStrokeWidth(Math.max(2f, sizePx * petStrokeRatio));
            p.setColor(0xFFFFFFFF); // 白描边，压在深色壁纸上也能看清轮廓
            c.drawCircle(r, r, r - p.getStrokeWidth() / 2f, p);
            return out;
        } catch (Throwable t) {
            return null;
        }
    }

    // ===================== v1.71 桌宠：pet.json 驱动 + 台词气泡 =====================
    //
    // 设计与决策（2026-09-30 拍板，本版首次实现）见 notes/桌宠加功能-设计与决策-20260930.md：
    //   · 单击悬浮球 → 吐一句台词（气泡）；点那个气泡 → 展开面板。⛔ 不用双击（半藏小圆上双击＝老"点不中"的坑）。
    //   · **气泡必须是第二个悬浮窗**：图标窗只有图标那么大，把它撑大后多出来的空白区会吃掉触摸
    //     —— 正是 v1.60「点不中悬浮球」的同类坑。
    //   · 🔴 监听**绝不挂在 iconView 上**（见 buildOverlay 里的警告）；气泡是新窗口，挂 OnClickListener 没问题。
    //   · 配置挂 payload/pet/pet.json（与形象图同目录）→ 改台词/换皮**不用重新出包**。
    //     ⛔ 形象图不随包（授权仅限本机自用）；pet.json 是我们原创文本，可以随包。

    private volatile boolean petJsonOk = false;
    private int petBallDp = 40;
    private int petSample = 4;
    private float petCropX = 0.45f, petCropY = 0.34f;
    private float petStrokeRatio = 0.045f;
    private volatile String[] petLines = {};
    private int petLineIdx = 0;
    private int petAutoHideMs = 3000;   // v1.72（用户指定）：3 秒没有下一步动作 → 气泡自动消失；另一点是「点气泡与球以外」
    private float petMaxWidthFrac = 0.72f;
    private int petBgColor = 0xE6101A2B, petTextColor = 0xFFFFFFFF;
    private int petRadiusDp = 12, petPadHdp = 10, petPadVdp = 7, petGapDp = 8;
    private String petOnBubble = "panel";

    private TextView bubbleView = null;
    private WindowManager.LayoutParams bubbleLp = null;
    private boolean bubbleVisible = false;
    // v1.73：气泡相对球窗的偏移（拖动时靠它跟随，不必每帧重量尺寸）
    private int bubbleDx = 0, bubbleDy = 0;
    private final Handler bubbleHandler = new Handler(Looper.getMainLooper());
    private final Runnable bubbleHider = new Runnable() {
        @Override public void run() { hideBubble(); }
    };

    /** 读 payload/pet/pet.json。**任何异常都回退内置默认值** —— 配置坏了不能连累悬浮球。 */
    private void loadPetConfig() {
        try {
            java.io.File f = new java.io.File(getFilesDir(), "payload/pet/pet.json");
            if (!f.exists()) return;
            JSONObject o = new JSONObject(readFileUtf8(f));
            JSONObject ap = o.optJSONObject("appearance");
            if (ap != null) {
                petBallDp = Math.max(24, ap.optInt("ballDp", petBallDp));
                petSample = Math.max(1, ap.optInt("sample", petSample));
                petCropX = (float) ap.optDouble("cropCenterX", petCropX);
                petCropY = (float) ap.optDouble("cropCenterY", petCropY);
                petStrokeRatio = (float) ap.optDouble("strokeRatio", petStrokeRatio);
            }
            JSONObject tp = o.optJSONObject("tap");
            if (tp != null) {
                petAutoHideMs = tp.optInt("bubbleAutoHideMs", petAutoHideMs);
                petOnBubble = tp.optString("onBubble", petOnBubble);
            }
            JSONObject bb = o.optJSONObject("bubble");
            if (bb != null) {
                petMaxWidthFrac = (float) bb.optDouble("maxWidthFrac", petMaxWidthFrac);
                petBgColor = parseColorSafe(bb.optString("bgColor", ""), petBgColor);
                petTextColor = parseColorSafe(bb.optString("textColor", ""), petTextColor);
                petRadiusDp = bb.optInt("radiusDp", petRadiusDp);
                petPadHdp = bb.optInt("padHdp", petPadHdp);
                petPadVdp = bb.optInt("padVdp", petPadVdp);
                petGapDp = bb.optInt("gapDp", petGapDp);
            }
            org.json.JSONArray ls = o.optJSONArray("lines");
            if (ls != null && ls.length() > 0) {
                String[] arr = new String[ls.length()];
                for (int i = 0; i < ls.length(); i++) arr[i] = ls.optString(i, "");
                petLines = arr;
            }
            org.json.JSONArray bs = o.optJSONArray("bubbles");
            if (bs != null && bs.length() > 0) {
                java.util.ArrayList<String> seq = new java.util.ArrayList<String>();
                for (int i = 0; i < bs.length(); i++) {
                    JSONObject b = bs.optJSONObject(i);
                    if (b == null) continue;
                    String kind = b.optString("kind", "line");
                    int w = Math.max(1, Math.min(20, b.optInt("weight", 1)));
                    for (int j = 0; j < w; j++) seq.add(kind);
                }
                if (!seq.isEmpty()) bubbleSeq = seq.toArray(new String[0]);
            }
            JSONObject bal = o.optJSONObject("balance");
            if (bal != null) {
                balanceEndpoint = bal.optString("endpoint", balanceEndpoint);
                balanceKeyRef = bal.optString("keyRef", balanceKeyRef);
                balanceRefreshSec = Math.max(30, bal.optInt("refreshSec", balanceRefreshSec));
                balanceLowWarn = bal.optDouble("lowWarn", balanceLowWarn);
                balanceDayBudget = bal.optDouble("dayBudget", balanceDayBudget);
            }
            JSONObject pr = o.optJSONObject("pricing");
            if (pr != null) {
                pricingTz = pr.optString("tz", pricingTz);
                org.json.JSONArray ws = pr.optJSONArray("peakWindows");
                if (ws != null && ws.length() > 0) {
                    java.util.ArrayList<String[]> tmp = new java.util.ArrayList<String[]>();
                    for (int i = 0; i < ws.length(); i++) {
                        org.json.JSONArray w = ws.optJSONArray(i);
                        if (w != null && w.length() >= 2) tmp.add(new String[]{w.optString(0), w.optString(1)});
                    }
                    if (!tmp.isEmpty()) pricingPeakWindows = tmp.toArray(new String[tmp.size()][]);
                }
                org.json.JSONArray hs = pr.optJSONArray("holidays");
                if (hs != null) {
                    String[] arr = new String[hs.length()];
                    for (int i = 0; i < hs.length(); i++) arr[i] = hs.optString(i, "");
                    pricingHolidays = arr;
                }
            }
            JSONObject cd = o.optJSONObject("card");
            if (cd != null) {
                cardMaxWidthFrac = (float) cd.optDouble("maxWidthFrac", cardMaxWidthFrac);
                cardMaxHeightFrac = (float) cd.optDouble("maxHeightFrac", cardMaxHeightFrac);
                cardRadiusDp = cd.optInt("radiusDp", cardRadiusDp);
                cardGapDp = cd.optInt("gapDp", cardGapDp);
                cardBgTop = parseColorSafe(cd.optString("bgTop", ""), cardBgTop);
                cardBgBottom = parseColorSafe(cd.optString("bgBottom", ""), cardBgBottom);
                cardTextColor = parseColorSafe(cd.optString("textColor", ""), cardTextColor);
                cardHoldMs = cd.optInt("holdMs", cardHoldMs);
                cardPollMs = Math.max(400, cd.optInt("pollMs", cardPollMs));
                cardAtTop = cd.optBoolean("atTop", cardAtTop);
                cardTopOffsetDp = cd.optInt("topOffsetDp", cardTopOffsetDp);
                cardSideMarginDp = cd.optInt("sideMarginDp", cardSideMarginDp);
                cardAutoShow = cd.optBoolean("autoShow", cardAutoShow);
                cardGuiPollMs = Math.max(800, cd.optInt("guiPollMs", cardGuiPollMs));
                cardShowClose = cd.optBoolean("showClose", cardShowClose);
                cardAnimMs = Math.max(80, cd.optInt("animMs", cardAnimMs));
                cardRiseDp = cd.optInt("riseDp", cardRiseDp);
                cardCapsule = cd.optBoolean("capsule", cardCapsule);
                cardCapsuleMaxWidthDp = cd.optInt("capsuleMaxWidthDp", cardCapsuleMaxWidthDp);
                cardExpandOnTap = cd.optBoolean("expandOnTap", cardExpandOnTap);
                cardDismissOnOutside = cd.optBoolean("dismissOnOutside", cardDismissOnOutside);
            }
            petJsonOk = true;
            logVis("pet.json ok: lines=" + petLines.length + " ballDp=" + petBallDp
                    + " crop=" + petCropX + "," + petCropY + " autoHide=" + petAutoHideMs);
        } catch (Throwable t) {
            logVis("pet.json load failed: " + t);
        }
    }

    private static String readFileUtf8(java.io.File f) throws Exception {
        java.io.FileInputStream in = new java.io.FileInputStream(f);
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } finally {
            try { in.close(); } catch (Throwable ignored) {}
        }
    }

    private static int parseColorSafe(String s, int def) {
        try { return (s == null || s.isEmpty()) ? def : android.graphics.Color.parseColor(s); }
        catch (Throwable t) { return def; }
    }

    /**
     * 单击悬浮球：
     * 面板开着 → 收起面板并贴边半藏；
     * 面板没开 → 展开面板（露出快捷聊天、剪贴板卡片、控制按钮）。
     */
    private void onBallTap() {
        try {
            if (panelVisible) {
                ballTucked = true;
                setPanelVisible(false, true);
            } else {
                hideBubble();
                ballTucked = false;
                setPanelVisible(true, true);
            }
        } catch (Throwable ignored) {}
    }

    private String nextPetLine() {
        try {
            if (petLines.length == 0) return "我在。";
            String s = petLines[petLineIdx % petLines.length];
            petLineIdx++;
            return s;
        } catch (Throwable t) {
            return "我在。";
        }
    }

    // ===================== v1.74 阶段 2：余额泡泡 =====================
    // 设计出处：9-30 文档「bubbles[] 并列加权（台词 / 余额 / 今日 / 峰谷 / 图片）」的第一种非文本泡泡。
    // 数据源：$DSH_HOME/.credentials.yaml 的 refs.<keyRef>（默认 DEEPSEEK_API_KEY）
    //         → GET https://api.deepseek.com/user/balance（Authorization: Bearer <key>）。
    // ⛔ 钥匙只在本进程内存里用：**不写日志、不进任何随包文件**；泡泡上只显示金额本身。

    private volatile String[] bubbleSeq = {"line", "line", "line", "balance"};  // 加权展开后的序列
    private int bubbleSeqIdx = 0;
    private volatile String balanceEndpoint = "https://api.deepseek.com/user/balance";
    private volatile String balanceKeyRef = "DEEPSEEK_API_KEY";
    private volatile int balanceRefreshSec = 300;
    private volatile double balanceLowWarn = 10;
    private volatile String balanceText = null;     // 已格式化文案（null=还没查到）
    private volatile long balanceAt = 0L;
    private volatile boolean balanceFetching = false;

    /** 按 bubbles[] 加权选下一条泡泡内容。**不阻塞**：余额用缓存，过期了在后台刷。 */
    private String nextBubbleText() {
        try {
            if (bubbleSeq.length == 0) return nextPetLine();
            String kind = bubbleSeq[bubbleSeqIdx % bubbleSeq.length];
            bubbleSeqIdx++;
            if ("balance".equals(kind)) return balanceBubbleText();
            if ("today".equals(kind)) return todaySpentText();
            if ("turn".equals(kind)) return turnSpentText();
            if ("peak".equals(kind)) return peakBubbleText();
            return nextPetLine();
        } catch (Throwable t) {
            return nextPetLine();
        }
    }

    private String balanceBubbleText() {
        long age = System.currentTimeMillis() - balanceAt;
        if (balanceAt == 0L || age > balanceRefreshSec * 1000L) fetchBalanceAsync(false);
        if (balanceText != null && !balanceText.isEmpty()) return balanceText;
        return balanceFetching ? "余额查询中…" : "余额没查到（网络或钥匙）";
    }

    private void fetchBalanceAsync(boolean force) {
        if (balanceFetching) return;
        if (!force && balanceAt != 0L
                && System.currentTimeMillis() - balanceAt <= balanceRefreshSec * 1000L) return;   // 缓存还新
        balanceFetching = true;
        new Thread(new Runnable() { @Override public void run() {
            String txt = null;
            try {
                String key = readCredentialRef(balanceKeyRef);
                if (key == null || key.isEmpty()) {
                    logVis("balance: 没有钥匙引用 " + balanceKeyRef);
                } else {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection)
                            new URL(balanceEndpoint).openConnection();
                    c.setRequestMethod("GET");
                    c.setRequestProperty("Authorization", "Bearer " + key);
                    c.setConnectTimeout(10000);
                    c.setReadTimeout(15000);
                    int code = c.getResponseCode();
                    if (code == 200) {
                        JSONObject o = new JSONObject(readStreamUtf8(c.getInputStream()));
                        org.json.JSONArray infos = o.optJSONArray("balance_infos");
                        if (infos != null && infos.length() > 0) {
                            JSONObject b = infos.optJSONObject(0);
                            String cur = b.optString("currency", "CNY");
                            String sym = "CNY".equals(cur) ? "¥" : (cur + " ");
                            double total = Double.parseDouble(b.optString("total_balance", "0"));
                            if (!"CNY".equals(cur)) { txt = "余额 " + sym + String.format(java.util.Locale.US, "%.2f", total); }
                            else { txt = applyBalance(total); }   // v1.75：跨天重置/持久化/本轮结算都在里面
                        }
                    } else {
                        logVis("balance: http " + code);
                    }
                    try { c.disconnect(); } catch (Throwable ignored) {}
                }
            } catch (Throwable t) {
                logVis("balance 查询失败: " + t);   // ⚠️ 只记异常，绝不记 key
            }
            if (txt != null) { balanceText = txt; balanceAt = System.currentTimeMillis(); }
            balanceFetching = false;
        }}, "ovl-balance").start();
    }

    private static String readStreamUtf8(java.io.InputStream in) throws Exception {
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } finally {
            try { in.close(); } catch (Throwable ignored) {}
        }
    }

    // ===================== v1.75 阶段 3：今日已用 / 上一轮消耗 =====================
    // ⚠️ 口径（必须诚实，不许写成精确账单）：余额只有**我们查的时候**才知道，
    //    所以「今日已用」是**按余额差估算**；「上一轮」只统计**从球里发出去**的那一轮
    //    （GUI 里发的轮次没有起点，不计）。
    private static final String PREF_BAL_DAY = "ovl_bal_day";   // 记账日（本地时区 yyyy-MM-dd）
    private static final String PREF_BAL_REF = "ovl_bal_ref";   // 当日起点余额
    private volatile String balDay = null;
    private volatile double balRef = -1;
    private volatile double balLast = -1;
    private volatile double turnPre = -1;     // 本轮开始前记下的余额
    private volatile double turnSpent = -1;   // 上一轮消耗
    private volatile boolean turnArmed = false;

    // ===================== v1.76 阶段 4：峰谷时段 + 预算预警 =====================
    // 官方口径（2026-10-02 抓 https://api-docs.deepseek.com/quick_start/pricing 核实）：
    //   高峰 = UTC 01:00-04:00 与 06:00-10:00 的**周一至周五**（不含中国法定节假日）；
    //   其余全部空闲（周末与节假日**整日**空闲）。北京时间(UTC+8) → 09:00-12:00 与 14:00-18:00。
    // ⛔ 时段一律从 pet.json 读，**别在代码里写死**（官方会调整，节假日表我们也不掌握）。
    private volatile String pricingTz = "Asia/Shanghai";
    private volatile String[][] pricingPeakWindows = {{"09:00", "12:00"}, {"14:00", "18:00"}};
    private volatile String[] pricingHolidays = {};
    private volatile double balanceDayBudget = 0;   // 0 = 不预警

    private static int hm2min(String hm) {
        try {
            String[] p = hm.split(":");
            return Integer.parseInt(p[0].trim()) * 60 + Integer.parseInt(p[1].trim());
        } catch (Throwable t) {
            return -1;
        }
    }

    private java.util.Calendar nowInPricingTz() {
        return java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone(pricingTz));
    }

    /** 现在是高峰吗？（周末与配置里的节假日整日算空闲） */
    private boolean isPeakNow() {
        try {
            java.util.Calendar c = nowInPricingTz();
            int dow = c.get(java.util.Calendar.DAY_OF_WEEK);
            if (dow == java.util.Calendar.SATURDAY || dow == java.util.Calendar.SUNDAY) return false;
            String ymd = String.format(java.util.Locale.US, "%04d-%02d-%02d",
                    c.get(java.util.Calendar.YEAR),
                    c.get(java.util.Calendar.MONTH) + 1,
                    c.get(java.util.Calendar.DAY_OF_MONTH));
            for (String h : pricingHolidays) if (ymd.equals(h)) return false;
            int mins = c.get(java.util.Calendar.HOUR_OF_DAY) * 60 + c.get(java.util.Calendar.MINUTE);
            for (String[] w : pricingPeakWindows) {
                int a = hm2min(w[0]), b = hm2min(w[1]);
                if (a < 0 || b < 0) continue;
                if (a <= b ? (mins >= a && mins < b) : (mins >= a || mins < b)) return true;
            }
        } catch (Throwable ignored) {}
        return false;
    }

    /** 下一次切换时刻（定价时区 HH:MM）；今天没有了就返回空串。 */
    private String nextSwitchHm() {
        try {
            java.util.Calendar c = nowInPricingTz();
            int mins = c.get(java.util.Calendar.HOUR_OF_DAY) * 60 + c.get(java.util.Calendar.MINUTE);
            int best = Integer.MAX_VALUE;
            for (String[] w : pricingPeakWindows) {
                for (String b : new String[]{w[0], w[1]}) {
                    int m = hm2min(b);
                    if (m > mins && m < best) best = m;
                }
            }
            if (best == Integer.MAX_VALUE) return "";
            return String.format(java.util.Locale.US, "%02d:%02d", best / 60, best % 60);
        } catch (Throwable t) {
            return "";
        }
    }

    /** 泡泡：现在高峰还是空闲 + 下一次切换。 */
    private String peakBubbleText() {
        boolean peak = isPeakNow();
        String t = peak ? "现在高峰（全价）" : "现在空闲（半价）";
        String nx = nextSwitchHm();
        if (!nx.isEmpty()) t += "，" + nx + " 转" + (peak ? "空闲" : "高峰");
        return t;
    }

    // ===================== v1.77 阶段 5：流体云式回复卡（逐字流式） =====================
    // 设计出处：9-30 文档「流体云 —— 只做视觉仿」。视觉取自本地设计草图（未随仓库分发）：
    //   品牌蓝 #4D6BFE、深蓝渐变卡面、大圆角、闪烁光标；原稿的 backdrop-filter 模糊在 Android 悬浮窗上
    //   **做不了真模糊**（那要模糊"身后的东西"）→ 这里用半透明渐变近似，别写"已实现模糊"。
    // ⚠️「逐字」的实现方式：引擎是**边生成边往会话文件落盘**的，所以我们用**密集轮询**（默认 1.2s）
    //   把快照一次次贴到卡片上 —— 不是 SSE/真流式。轮询要跑 node 解压会话文件，**有 CPU 代价**，
    //   所以：只在卡片可见时密集轮询、连续两次读到的内容不再变长就收尾（上限 40 次）。

    private LinearLayout cardView = null;
    private TextView cardText = null;
    private MaxHeightScrollView cardScroll = null;
    // v1.89（用户实测）：手动往上翻时**不要**被自动下滑拽回去
    private volatile boolean cardUserTouching = false;   // 手指还在卡上
    private volatile boolean cardFollowTail = true;      // 是否"跟着最新内容走"（翻上去后暂停，滑回底部恢复）   // v1.88：限高 + 自动往下滚（用户报"文字停在这、后面直接省略号"）
    private WindowManager.LayoutParams cardLp = null;
    private boolean cardVisible = false;
    private String lastStreamText = null;
    private int streamAttempts = 0;
    private String cardBody = "";
    private boolean cursorOn = true;
    private volatile boolean cardStreaming = false;
    private volatile int cardPollMs = 1200;
    private volatile int cardHoldMs = 6000;
    private volatile float cardMaxWidthFrac = 0.78f, cardMaxHeightFrac = 0.32f;
    private volatile int cardRadiusDp = 20, cardGapDp = 10;
    private volatile int cardBgTop = 0xF2141B2E, cardBgBottom = 0xF20B0F1A, cardTextColor = 0xFFCFD8EA;
    private volatile boolean cardAtTop = true;          // v1.78：默认贴顶部状态栏下沿（草图口径）
    private volatile int cardTopOffsetDp = 34, cardSideMarginDp = 12;
    private TextView cardState = null;                  // 头部右上角状态字（生成中 / 已完成）
    private ImageView cardAvatar = null;
    private View cardProg = null;
    // v1.79（用户选 A）：不管消息从 GUI 还是从球里发出去，只要 AI 在写就飘卡。
    private volatile boolean cardAutoShow = true;
    private volatile int cardGuiPollMs = 1500;
    private volatile String streamSessionId = null;
    // v1.83（用户报"没新内容也循环播报上一条"）：记住已播报过的内容 + 防重入 + 开关持久化
    private volatile String lastBroadcastHash = null;   // v1.84：内容指纹（String.valueOf(t.hashCode())）
    private volatile boolean cardBroadcasting = false;
    private static final String PREF_FLUID = "ovl_fluid";
    /**
     * v1.88：悬浮球「关了就是关了」——用户按通知栏那一格关掉后，**跨重启也要保持关闭**
     * （原来只有内存里的 userHidden，服务一重建球又冒出来，用户报"我不想要它出现的时候关不掉"）。
     */
    private static final String PREF_BALL_OFF = "ovl_ball_off";
    private static final String PREF_LAST_BCAST = "ovl_last_bcast";   // v1.84：已播报内容的指纹（持久化）
    /** v1.84：通知栏上的「流体云:开/关」动作（与小鲸鱼开关放一起）。 */
    private static final String ACTION_TOGGLE_FLUID = "com.deepseek.harness.overlay.TOGGLE_FLUID";
    private Button fluidBtn = null;
    // v1.80（用户指定）：流体感（向上升入）+ 关闭键 + 顶到电量那一栏
    private volatile boolean cardShowClose = true;
    private volatile int cardAnimMs = 240;
    private volatile int cardRiseDp = 30;
    // v1.81（用户给的参考 = 酷狗音乐流体云）：**两态** —— 状态栏小胶囊 ↔ 点开成卡片 ↔ 点别处消失
    private volatile boolean cardCapsule = true;
    private volatile int cardCapsuleMaxWidthDp = 170;
    private volatile boolean cardExpandOnTap = true;
    private volatile boolean cardDismissOnOutside = true;
    private LinearLayout capsuleRow = null;      // 收起态：小胶囊（头像 + 短状态）
    private TextView capsuleText = null;
    private LinearLayout cardFull = null;        // 展开态：整张卡（头部 + 正文 + 进度条）
    private volatile boolean cardExpanded = false;
    private volatile long cardShownAt = 0L;   // v1.85：卡片亮起的时刻（用于过滤"刚亮就被摸掉"）
    private final Handler cardHandler = new Handler(Looper.getMainLooper());
    private final Runnable cardHider = new Runnable() { @Override public void run() { hideCard(); } };
    private final Runnable cursorBlink = new Runnable() {
        @Override public void run() {
            try {
                if (!cardVisible || cardText == null) return;
                cursorOn = !cursorOn;
                renderCardText();
                cardHandler.postDelayed(this, 500);
            } catch (Throwable ignored) {}
        }
    };

    /** 起一张流式回复卡（发送成功后调用）。 */
    private void showCard(String initial) {
        try {
            if (cardView == null) {
                cardView = new LinearLayout(this);
                cardView.setOrientation(LinearLayout.VERTICAL);
                // ---- 收起态：小胶囊（头像 + 短状态），点它展开 ----
                capsuleRow = new LinearLayout(this);
                capsuleRow.setOrientation(LinearLayout.HORIZONTAL);
                capsuleRow.setGravity(Gravity.CENTER_VERTICAL);
                ImageView cav = new ImageView(this);
                android.graphics.Bitmap cb = loadPetIcon(dp(18));
                if (cb != null) cav.setImageBitmap(cb);
                else cav.setImageResource(R.drawable.ic_whale_black);
                LinearLayout.LayoutParams calp = new LinearLayout.LayoutParams(dp(18), dp(18));
                calp.rightMargin = dp(6);
                cav.setLayoutParams(calp);
                capsuleRow.addView(cav);
                capsuleText = new TextView(this);
                capsuleText.setTextColor(cardTextColor);
                capsuleText.setTextSize(TypedValue.COMPLEX_UNIT_PX,
                        getResources().getDimension(R.dimen.text_caption));
                capsuleText.setMaxLines(1);
                capsuleText.setEllipsize(android.text.TextUtils.TruncateAt.END);
                capsuleText.setMaxWidth(dp(cardCapsuleMaxWidthDp));
                capsuleText.setText("生成中…");
                capsuleRow.addView(capsuleText);
                capsuleRow.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { if (cardExpandOnTap) expandCard(); }
                });
                cardView.addView(capsuleRow);
                cardFull = new LinearLayout(this);
                cardFull.setOrientation(LinearLayout.VERTICAL);
                cardView.addView(cardFull);
                cardFull.setVisibility(View.GONE);
                // 点"别处"→ 消失（参考里的行为；与气泡同一个坑：带 WATCH_OUTSIDE_TOUCH 还得自己写 ACTION_OUTSIDE）
                cardView.setOnTouchListener(new View.OnTouchListener() {
                    @Override public boolean onTouch(View v, MotionEvent ev) {
                        if (ev.getAction() == MotionEvent.ACTION_OUTSIDE) {
                            // ⚠️ v1.85 实测：本机的 ACTION_OUTSIDE **不是"用户点了别处"** ——
                            //   用户只要在屏幕上任何地方碰一下（滚动/打字/看消息），我们的窗就会收到它；
                            //   而且坐标常常是 (0,0)。上一版照单全收，于是卡片刚飘起来就被自己的手指秒关，
                            //   用户看到的现象就是"压根没看到流体云"（日志：card show 后 0.1~0.2s 必有一条 outside-hide）。
                            //   ⇒ 只认"**坐标真实** 且 **卡片已经亮了 1.5 秒以上**"的窗外点击，其余忽略。
                            boolean real = (ev.getRawX() != 0f || ev.getRawY() != 0f);
                            boolean settled = (System.currentTimeMillis() - cardShownAt) > 1500L;
                            if (cardVisible && cardDismissOnOutside && real && settled) {
                                logVis("card outside-tap -> hide at(" + (int) ev.getRawX() + "," + (int) ev.getRawY() + ")");
                                hideCard();
                            } else {
                                logVis("card outside-ignored real=" + real + " settled=" + settled);
                            }
                            return true;
                        }
                        return false;
                    }
                });
                // v1.78：按草图做"一眼认得出"的流体云卡 —— 头部（品牌点+标题+状态）+ 正文行（桌宠头像+文字+光标）+ 品牌色进度条
                LinearLayout head = new LinearLayout(this);
                head.setOrientation(LinearLayout.HORIZONTAL);
                head.setGravity(Gravity.CENTER_VERTICAL);
                View dot = new View(this);
                GradientDrawable dg = new GradientDrawable();
                dg.setColor(0xFF4D6BFE);
                dg.setCornerRadius(dp(4));
                dot.setBackground(dg);
                LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(dp(8), dp(8));
                dlp.rightMargin = dp(7);
                dot.setLayoutParams(dlp);
                head.addView(dot);
                TextView title = new TextView(this);
                title.setText("DSH 桌宠");
                title.setTextColor(0xFF9DB4FF);
                title.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
                title.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
                head.addView(title);
                cardState = new TextView(this);
                cardState.setTextColor(0xFF8B98A9);
                cardState.setTextSize(TypedValue.COMPLEX_UNIT_PX, getResources().getDimension(R.dimen.text_caption));
                cardState.setText("生成中");
                head.addView(cardState);
                if (cardShowClose) {
                    // v1.80（用户指定）：**手动关闭键** —— 之前卡片只能等自己超时，用户明确说"无法关闭"。
                    TextView close = new TextView(this);
                    close.setText("✕");
                    close.setTextColor(0xFFB9C6E8);
                    close.setTextSize(TypedValue.COMPLEX_UNIT_PX,
                            getResources().getDimension(R.dimen.text_caption));
                    LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(dp(26), dp(26));
                    clp.leftMargin = dp(6);
                    close.setLayoutParams(clp);
                    close.setGravity(Gravity.CENTER);
                    close.setOnClickListener(new View.OnClickListener() {
                        @Override public void onClick(View v) { collapseCard(); }   // v1.87：✕ = 收回胶囊，不是关掉整个流体云
                    });
                    head.addView(close);
                }
                head.setPadding(0, 0, 0, dp(7));
                cardFull.addView(head);

                LinearLayout body = new LinearLayout(this);
                body.setOrientation(LinearLayout.HORIZONTAL);
                cardAvatar = new ImageView(this);
                android.graphics.Bitmap av = loadPetIcon(dp(26));
                if (av != null) cardAvatar.setImageBitmap(av);
                else cardAvatar.setImageResource(R.drawable.ic_whale_black);
                LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(dp(26), dp(26));
                alp.rightMargin = dp(9);
                cardAvatar.setLayoutParams(alp);
                body.addView(cardAvatar);
                cardText = new TextView(this);
                cardText.setTextColor(cardTextColor);
                cardText.setTextSize(TypedValue.COMPLEX_UNIT_PX,
                        getResources().getDimension(R.dimen.text_caption));
                cardText.setLineSpacing(dp(2), 1f);
                cardText.setLayoutParams(new android.widget.FrameLayout.LayoutParams(
                        android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                        android.widget.FrameLayout.LayoutParams.WRAP_CONTENT));
                cardScroll = new MaxHeightScrollView(this);
                cardScroll.setMaxPx((int) (getResources().getDisplayMetrics().heightPixels * cardMaxHeightFrac));
                cardScroll.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
                cardScroll.setVerticalScrollBarEnabled(false);
                cardScroll.setOnTouchListener(new View.OnTouchListener() {
                    @Override public boolean onTouch(View v, MotionEvent ev) {
                        int a = ev.getAction();
                        if (a == MotionEvent.ACTION_DOWN) {
                            cardUserTouching = true;
                        } else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) {
                            cardUserTouching = false;
                            cardFollowTail = isCardAtBottom();   // 滑回底部才恢复"跟随最新"
                        }
                        return false;   // 让 ScrollView 自己滚
                    }
                });
                cardScroll.addView(cardText);
                body.addView(cardScroll);
                cardFull.addView(body);

                cardProg = new View(this);
                GradientDrawable pg = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                        new int[]{0xFF4D6BFE, 0xFF9DB4FF});
                pg.setCornerRadius(dp(1));
                cardProg.setBackground(pg);
                LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, dp(2));
                plp.topMargin = dp(9);
                cardProg.setLayoutParams(plp);
                cardProg.setAlpha(0.25f);
                cardFull.addView(cardProg);
            }
            cardBody = initial == null ? "" : initial;
            cardShownAt = System.currentTimeMillis();
            cardFollowTail = true;    // v1.89：新飘一次 → 重新跟随
            cardUserTouching = false;
            cardExpanded = false;                       // v1.81：每次飘起来都是小胶囊，点它才展开
            if (cardFull != null) cardFull.setVisibility(View.GONE);
            if (capsuleRow != null) capsuleRow.setVisibility(View.VISIBLE);
            streamAttempts = 0;
            lastStreamText = null;
            cardStreaming = true;
            cursorOn = true;
            GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                    new int[]{cardBgTop, cardBgBottom});
            bg.setCornerRadius(dp(cardRadiusDp));
            bg.setStroke(dp(1), 0x334D6BFE);   // 品牌蓝细边（原稿的 border）
            cardView.setBackground(bg);
            cardView.setPadding(dp(12), dp(9), dp(12), dp(9));
            renderCardText();

            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            cardText.setMaxWidth(Math.max(dp(140), (int) (screenW * cardMaxWidthFrac) - dp(24)));
            // v1.88：不再截断成"…" —— 交给限高 ScrollView，超出的部分往下滚（可下滑）
            cardText.setMaxLines(Integer.MAX_VALUE);
            cardText.setEllipsize(null);
            if (cardScroll != null) {
                cardScroll.setMaxPx((int) (getResources().getDisplayMetrics().heightPixels * cardMaxHeightFrac));
            }

            cardLp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    overlayWindowType(),
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                    PixelFormat.TRANSLUCENT);
            // v1.82：**水平居中**（用户明确说"不曾居中"）—— 交给 gravity，别手算 x
            cardLp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            positionCard();

            if (!cardVisible) {
                wm.addView(cardView, cardLp);
                cardVisible = true;
            } else {
                try { wm.updateViewLayout(cardView, cardLp); } catch (Throwable ignored) {}
            }
            cardHandler.removeCallbacks(cardHider);
            cardHandler.removeCallbacks(cursorBlink);
            cardHandler.postDelayed(cursorBlink, 500);
            // v1.80：流体感 —— 从下方"升"到位（用户反馈"向上升"）+ 轻微放大回弹
            try {
                cardView.setAlpha(0f);
                cardView.setTranslationY(dp(cardRiseDp));
                cardView.setScaleX(0.94f);
                cardView.setScaleY(0.94f);
                cardView.animate().alpha(1f).translationY(0f).scaleX(1f).scaleY(1f)
                        .setDuration(cardAnimMs)
                        .setInterpolator(new android.view.animation.DecelerateInterpolator())
                        .start();
            } catch (Throwable ignored) {}
            logVis("card show");
        } catch (Throwable t) {
            logVis("card show failed: " + t);
        }
    }

    /**
     * v1.87：**✕ = 收回胶囊形态**，不再整个关掉。
     * （用户反馈："怎么点取消是关掉整个流体云，把他改成为恢复胶囊形态"）
     * 整个关掉仍然有两条路：①"点别处"（护栏：坐标真实 + 已亮 >1.5s）②开/关按钮（面板与通知栏各一份）。
     */
    private void collapseCard() {
        try {
            cardExpanded = false;
            if (cardFull != null) cardFull.setVisibility(View.GONE);
            if (capsuleRow != null) capsuleRow.setVisibility(View.VISIBLE);
            if (cardLp != null) {
                cardLp.width = WindowManager.LayoutParams.WRAP_CONTENT;
                try { wm.updateViewLayout(cardView, cardLp); } catch (Throwable ignored) {}
            }
            logVis("card collapse -> capsule");
        } catch (Throwable ignored) {}
    }

    /** v1.81：小胶囊 → 展开成卡片（参考里"点胶囊变卡片"）。 */
    private void expandCard() {
        try {
            if (cardExpanded) return;
            cardExpanded = true;
            if (cardFull != null) cardFull.setVisibility(View.VISIBLE);
            if (capsuleRow != null) capsuleRow.setVisibility(View.GONE);
            int screenW = getResources().getDisplayMetrics().widthPixels;
            if (cardLp != null) {
                cardLp.width = screenW - dp(cardSideMarginDp) * 2;
                cardLp.height = WindowManager.LayoutParams.WRAP_CONTENT;
                try { wm.updateViewLayout(cardView, cardLp); } catch (Throwable ignored) {}
            }
            try {
                cardView.setAlpha(0.92f);
                cardView.setScaleX(0.96f);
                cardView.setScaleY(0.96f);
                cardView.animate().alpha(1f).scaleX(1f).scaleY(1f)
                        .setDuration(Math.max(120, cardAnimMs))
                        .setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
            } catch (Throwable ignored) {}
            logVis("card expand");
        } catch (Throwable ignored) {}
    }

    /** v1.89：卡内是否已经滚到底（留 24dp 容差）。 */
    private boolean isCardAtBottom() {
        try {
            if (cardScroll == null || cardText == null) return true;
            int diff = cardText.getBottom() - (cardScroll.getScrollY() + cardScroll.getHeight());
            return diff <= dp(24);
        } catch (Throwable t) {
            return true;
        }
    }

    private void renderCardText() {
        try {
            if (cardText == null) return;
            String body = cardBody == null ? "" : cardBody.replace("**", "").replace("`", "");
            cardText.setText(body + (cardStreaming && cursorOn ? "▍" : ""));
            // v1.88：跟着最新内容往下滑（用户："文字一直停留在这"）
            try {
                // v1.89：只在"没人在摸 + 用户没翻上去"时才跟着最新内容走
                if (cardScroll != null && cardFollowTail && !cardUserTouching) {
                    cardScroll.post(new Runnable() { @Override public void run() {
                        try {
                            if (cardFollowTail && !cardUserTouching) cardScroll.fullScroll(View.FOCUS_DOWN);
                        } catch (Throwable ignored) {}
                    }});
                }
            } catch (Throwable ignored) {}
            try {
                if (capsuleText != null) {
                    // 收起态只显示很短的提示（参考里胶囊也是小小的）
                    String one = body.replace("\n", " ").trim();
                    if (one.length() > 14) one = one.substring(0, 14) + "…";
                    capsuleText.setText(one.isEmpty() ? "生成中…" : one);
                }
            } catch (Throwable ignored) {}
        } catch (Throwable ignored) {}
    }

    /** 轮询到新内容时刷新卡片（还在长就继续闪光标）。 */
    private void updateCard(String text) {
        try {
            if (!cardVisible || text == null) return;
            if (text.equals(cardBody)) return;
            cardBody = text;
            renderCardText();
            positionCard();
            try { wm.updateViewLayout(cardView, cardLp); } catch (Throwable ignored) {}
        } catch (Throwable ignored) {}
    }

    /**
     * 落点（v1.78 按草图改）：**顶部状态栏下沿展开，浮在内容之上，不挡悬浮球**。
     * 布局依据见本地设计草图（未随仓库分发）「① 在哪出现」。
     * 仍然要补偿"窗口帧 vs 绘制位置"那个固定偏移（本机约 139px）。
     */
    private void positionCard() {
        try {
            if (cardLp == null || rootView == null || lp == null) return;
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            int[] rloc = new int[2];
            rootView.getLocationOnScreen(rloc);
            if (cardAtTop) {
                // v1.82（**实测修正**，别再改回去）：
                //   `dumpsys input` 里本机窗口的真·可触区 = frame=[-67,699][143,895]，
                //   而 lp.y=560 —— **真实位置 = lp.y + 139**（139 = 状态栏高度）。
                //   我上一版为了"贴到电量那一栏"把 y 减了 139，于是卡片落进**状态栏那一条**里，
                //   而状态栏是**系统窗口、压在我们之上**：用户点胶囊全被状态栏吃掉，
                //   我们只收到 ACTION_OUTSIDE（= 自己写的"点别处消失"）⇒ 表现为"点不开、还自己消失"。
                //   ⛔ 结论：第三方悬浮窗**进不了状态栏那一条**（酷狗能是因为它系统预装）。
                //   ⇒ 不补偿，直接放在状态栏**下面**那一行，可点、可展开、✕ 也能点。
                cardLp.width = cardExpanded ? (screenW - dp(cardSideMarginDp) * 2)
                                            : WindowManager.LayoutParams.WRAP_CONTENT;
                cardLp.height = WindowManager.LayoutParams.WRAP_CONTENT;
                cardLp.x = 0;   // 靠 gravity 居中，见下面 CENTER_HORIZONTAL
                cardLp.y = dp(cardTopOffsetDp);
                return;
            }
            int offY = rloc[1] - lp.y;   // 非顶部模式（贴球）才用这个补偿
            cardLp.width = WindowManager.LayoutParams.WRAP_CONTENT;
            cardView.measure(View.MeasureSpec.makeMeasureSpec((int) (screenW * cardMaxWidthFrac), View.MeasureSpec.AT_MOST),
                    View.MeasureSpec.makeMeasureSpec((int) (screenH * cardMaxHeightFrac), View.MeasureSpec.AT_MOST));
            int cw = Math.max(1, cardView.getMeasuredWidth());
            int ch = Math.max(1, cardView.getMeasuredHeight());
            int cx = Math.max(dp(4), Math.min(rloc[0], screenW - cw - dp(4)));
            int cy = (rloc[1] < screenH / 2) ? (rloc[1] + rootView.getHeight() + dp(cardGapDp))
                                             : (rloc[1] - ch - dp(cardGapDp));
            cy = Math.max(dp(4), Math.min(cy, screenH - ch - dp(4)));
            cardLp.x = cx;
            cardLp.y = cy - offY;
        } catch (Throwable ignored) {}
    }

    /** 回复收尾：卡片留 holdMs 再收（可配）。 */
    private void scheduleCardHide() {
        try {
            cardStreaming = false;
            renderCardText();
            try { if (cardState != null) cardState.setText("已完成"); } catch (Throwable ignored) {}
            try { if (cardProg != null) cardProg.setAlpha(1f); } catch (Throwable ignored) {}
            cardHandler.removeCallbacks(cursorBlink);
            cardHandler.removeCallbacks(cardHider);
            if (cardHoldMs > 0) cardHandler.postDelayed(cardHider, cardHoldMs);
            else hideCard();
        } catch (Throwable ignored) {}
    }

    private void hideCard() {
        try {
            cardHandler.removeCallbacks(cursorBlink);
            cardHandler.removeCallbacks(cardHider);
            final View v = cardView;
            final boolean wasVisible = cardVisible;
            cardVisible = false;          // 先标记不可见：轮询/探针立刻停手
            cardStreaming = false;
            if (wasVisible && v != null && wm != null) {
                try {
                    v.animate().alpha(0f).translationY(-dp(16))
                            .setDuration(Math.min(200, cardAnimMs))
                            .withEndAction(new Runnable() { @Override public void run() {
                                try { wm.removeView(v); } catch (Throwable ignored) {}
                            }}).start();
                    return;               // 由动画结束回调负责 remove
                } catch (Throwable ignored) {}
                try { wm.removeView(v); } catch (Throwable ignored) {}
            }
        } catch (Throwable ignored) {}
    }

    /**
     * v1.79（用户选 A）：**只要 AI 在写就飘卡**，不管那条消息是从 GUI 还是从球面板发出去的。
     * 判据复用现成的"会话正在写"扫描（`scanActiveSessions()`：扫 /proc 里持着 session.lock 的进程，
     * 面板上那句「AI: N 个会话工作中…」用的就是它）—— 那是**引擎自己持有写锁**的一手证据，不需要认证。
     * 每 2 秒的探针里调用；不忙了就收尾（留 holdMs 再消失）。
     */
    private void maybeStreamCard() {
        try {
            if (!cardAutoShow) return;
            java.util.HashSet<String> act = scanActiveSessions();
            boolean busy = act != null && !act.isEmpty();
            if (busy) {
                if (!cardVisible && !cardBroadcasting) {
                    // v1.83：**先读到内容再决定飘不飘** —— 原来一看到"会话在写"就飘，
                    // 于是没有新内容时会把上一条反复播报（用户实测："循环播报上一条"）。
                    cardBroadcasting = true;
                    final String sid = act.iterator().next();
                    streamSessionId = sid;
                    new Thread(new Runnable() { @Override public void run() {
                        String txt = null;
                        try {
                            JSONObject o = readReply(sid);
                            if (o != null) txt = o.optString("reply", null);
                        } catch (Throwable ignored) {}
                        final String t = txt;
                        try { rootView.post(new Runnable() { @Override public void run() {
                            cardBroadcasting = false;
                            if (t == null || t.isEmpty()) return;            // 没内容 → 不飘
                            String h = String.valueOf(t.hashCode());
                            if (h.equals(lastBroadcastHash)) return;          // 同上一条 → 不重复播报（跨重启也算）
                            lastBroadcastHash = h;
                            persistLastBroadcast(h);
                            showCard("正在生成…");
                            updateCard(t);
                            scheduleStreamPoll(0);
                        }}); } catch (Throwable ignored) {}
                    }}, "ovl-card-pre").start();
                }
            } else if (cardVisible && cardStreaming) {
                scheduleCardHide();
            }
        } catch (Throwable ignored) {}
    }

    /** 自动流：定期读一次会话里的最新回复，贴到卡上（读一次要跑 node 解压会话文件，有代价，故间隔偏宽）。 */
    private void scheduleStreamPoll(final int attempt) {
        try {
            if (attempt > 40 || !cardVisible || !cardStreaming) return;
            cardHandler.postDelayed(new Runnable() { @Override public void run() {
                if (!cardVisible || !cardStreaming) return;
                new Thread(new Runnable() { @Override public void run() {
                    final String sid = streamSessionId;
                    String txt = null;
                    try {
                        if (sid != null) {
                            JSONObject o = readReply(sid);
                            if (o != null) txt = o.optString("reply", null);
                        }
                    } catch (Throwable ignored) {}
                    if (txt != null && !txt.isEmpty()) {
                        final String t = txt;
                        try { rootView.post(new Runnable() { @Override public void run() {
                            updateCard(t);
                            String h = String.valueOf(t.hashCode());   // v1.84：记指纹，避免重复播报
                            lastBroadcastHash = h;
                            persistLastBroadcast(h);
                        }}); } catch (Throwable ignored) {}
                    }
                    scheduleStreamPoll(attempt + 1);
                }}, "ovl-stream").start();
            }}, cardGuiPollMs);
        } catch (Throwable ignored) {}
    }

    /** v1.83：读用户对"流体云"的开关（pet.json 的 card.autoShow 只是首次默认值）。 */
    private void loadCardPrefs() {
        try {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            cardAutoShow = p.getBoolean(PREF_FLUID, cardAutoShow);
            lastBroadcastHash = p.getString(PREF_LAST_BCAST, null);   // v1.84：重启后不再把上一条重播
            // v1.88：用户上次把悬浮球关掉了吗？关了就一直不出现，直到他自己再打开。
            userHidden = p.getBoolean(PREF_BALL_OFF, false);
        } catch (Throwable ignored) {}
    }

    /**
     * v1.88：改「用户是否主动关掉了悬浮球」，并**落盘**。
     * 所有改 userHidden 的地方都必须走这里 —— 只改内存字段的话，
     * 服务一重建（换内核/App 重启）球就又冒出来，正是用户报的那个问题。
     */
    private void setUserHidden(boolean hidden) {
        userHidden = hidden;
        try {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_BALL_OFF, hidden).apply();
        } catch (Throwable ignored) {}
    }

    private void persistLastBroadcast(String h) {
        try {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(PREF_LAST_BCAST, h).apply();
        } catch (Throwable ignored) {}
    }

    /**
     * ⚠️ v1.84：标签必须写成**动作**，不能写成状态。
     * 用户反馈"根本就没看到流体云"—— 很可能就是因为上一版写的是「流体云:开」（=当前状态），
     * 用户读成"点它开启" → 一点反而把开关**关掉**并持久化了。
     * 现在：开着时显示「关流体云」，关着时显示「开流体云」。
     */
    /**
     * v1.86：统一的"流体云开关"入口（通知栏动作 + 面板按钮都走这里）。
     * 用户报"开关作用只有一次" → 真因是**内容去重**：关掉再打开时回复没变，被 lastBroadcastHash 挡掉了，
     * 于是"打开没反应"。⇒ 开启时**清掉指纹并立刻播一次最新回复**，给用户可见反馈。
     */
    private void setFluid(boolean on) {
        try {
            cardAutoShow = on;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_FLUID, on).apply();
            logVis("fluid -> " + on);
            if (!on) {
                hideCard();
            } else {
                lastBroadcastHash = null;       // 允许立刻把"当前这条"重播一次
                persistLastBroadcast("");
                streamSessionId = null;
                maybeStreamCard();              // 立刻试一次（有内容就飘）
            }
            try { if (fluidBtn != null) fluidBtn.setText(fluidLabel()); } catch (Throwable ignored) {}
        } catch (Throwable ignored) {}
    }

    private String fluidLabel() {
        return cardAutoShow ? "关流体云" : "开流体云";
    }

    private void loadBalanceState() {
        try {
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            balDay = p.getString(PREF_BAL_DAY, null);
            balRef = p.getFloat(PREF_BAL_REF, -1f);
        } catch (Throwable ignored) {}
    }

    /** 查到余额后的统一入口：跨天重置 + 持久化 + 本轮结算 + 返回泡泡文案。 */
    private String applyBalance(double total) {
        try {
            String today = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                    .format(new java.util.Date());
            SharedPreferences p = getSharedPreferences(PREFS, MODE_PRIVATE);
            if (balDay == null || !balDay.equals(today) || balRef < 0) {
                balDay = today;
                balRef = total;        // 跨天（或首次）：把今天第一笔余额当"当日起点"
                p.edit().putString(PREF_BAL_DAY, balDay).putFloat(PREF_BAL_REF, (float) total).apply();
            }
            balLast = total;
            if (turnArmed && turnPre >= 0) {
                turnSpent = turnPre - total;   // 本轮结束：余额差 = 这一轮花的
                turnArmed = false;
            }
        } catch (Throwable ignored) {}
        return balanceLine(total);
    }

    private String balanceLine(double total) {
        String t = "余额 ¥" + String.format(java.util.Locale.US, "%.2f", total);
        if (total < balanceLowWarn) t += "，该充了";
        return t;
    }

    /** 泡泡：今日已用（按余额差估算，别当精确账单）。 */
    private String todaySpentText() {
        long age = System.currentTimeMillis() - balanceAt;
        if (balanceAt == 0L || age > balanceRefreshSec * 1000L) fetchBalanceAsync(false);
        if (balRef < 0 || balLast < 0) return "今日消耗还没数";
        double spent = balRef - balLast;
        if (spent < 0.005) return "今日账上还没动";
        String t = "今日 ≈ ¥" + String.format(java.util.Locale.US, "%.2f", spent);
        if (balanceDayBudget > 0 && spent > balanceDayBudget) t += "，超预算了";
        return t;
    }

    /** 泡泡：上一轮消耗（只算从球里发出去的那一轮）。 */
    private String turnSpentText() {
        if (turnSpent < 0) return "上一轮还没计时";
        return "上一轮 ≈ ¥" + String.format(java.util.Locale.US, "%.2f", turnSpent);
    }

    /** 球内发送成功时调用：记下这一轮的起点余额。 */
    private void markTurnStart() {
        turnArmed = true;
        turnPre = balLast;
        if (balLast < 0) fetchBalanceAsync(true);   // 还没有基准，先查一次
    }

    /** 拿到真回复时调用：后台把这一轮的余额差算出来（不阻塞界面）。 */
    private void finishTurnAccounting() {
        if (turnArmed) fetchBalanceAsync(true);
    }

    /** 从 $DSH_HOME/.credentials.yaml 的 refs.<名> 取钥匙（只认这一行；失败返回 null）。 */
    private String readCredentialRef(String refName) {
        try {
            java.io.File f = new java.io.File(getFilesDir(), "payload/dshhome/.credentials.yaml");
            if (!f.exists()) return null;
            for (String line : readFileUtf8(f).split("\n")) {
                String t = line.trim();
                if (t.startsWith(refName + ":")) {
                    String v = t.substring(refName.length() + 1).trim();
                    if (v.length() >= 2 && (v.startsWith("\"") || v.startsWith("'"))) {
                        v = v.substring(1, v.length() - 1);
                    }
                    return v.trim();
                }
            }
        } catch (Throwable t) {
            logVis("credentials 读取失败: " + t);
        }
        return null;
    }

    /**
     * 显示台词气泡（第二个悬浮窗）。落点按 dockSide 避开贴边的那个方向，
     * 并补偿本机实测的"窗口帧 vs 绘制位置"偏移（见下面的 offY）。
     */
    private void showBubble(final String text) {
        showBubble(text, petAutoHideMs);
    }

    private void showBubble(final String text, final int autoHideMs) {
        if (text == null || text.isEmpty()) return;
        if (foregroundWantsHidden || userHidden || !isRunning) return;
        try {
            if (bubbleView == null) {
                bubbleView = new TextView(this);
                bubbleView.setTextSize(TypedValue.COMPLEX_UNIT_PX,
                        getResources().getDimension(R.dimen.text_caption));
                bubbleView.setMaxLines(3);
                bubbleView.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        hideBubble();
                        setPanelVisible(true, true);
                    }
                });
                bubbleView.setOnTouchListener(new View.OnTouchListener() {
                    @Override public boolean onTouch(View v, MotionEvent ev) {
                        if (ev.getAction() == MotionEvent.ACTION_OUTSIDE) {
                            boolean onBall = (ev.getRawX() != 0f || ev.getRawY() != 0f)
                                    && insideBall(ev.getRawX(), ev.getRawY());
                            logVis("bubble outside-tap at(" + (int) ev.getRawX() + "," + (int) ev.getRawY()
                                    + ") onBall=" + onBall);
                            if (!onBall) hideBubble();
                            return true;
                        }
                        return false;
                    }
                });
            }
            bubbleView.setTextColor(petTextColor);
            bubbleView.setText(text);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(petBgColor);
            bg.setCornerRadius(dp(petRadiusDp));
            bubbleView.setBackground(bg);
            bubbleView.setPadding(dp(petPadHdp), dp(petPadVdp), dp(petPadHdp), dp(petPadVdp));

            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            int maxW = Math.max(dp(120), (int) (screenW * petMaxWidthFrac));
            bubbleView.measure(View.MeasureSpec.makeMeasureSpec(maxW, View.MeasureSpec.AT_MOST),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            int bw = Math.max(1, bubbleView.getMeasuredWidth());
            int bh = Math.max(1, bubbleView.getMeasuredHeight());

            int[] rloc = new int[2];
            if (rootView != null) rootView.getLocationOnScreen(rloc);
            int w = rootView == null ? 0 : rootView.getWidth();
            int h = rootView == null ? 0 : rootView.getHeight();
            int gap = dp(petGapDp);
            int bx;
            if (dockSide == 1) bx = rloc[0] - bw - gap;        // 球贴右边 → 气泡放左侧
            else if (dockSide == 2) bx = rloc[0];              // 球贴上边 → 气泡放下方
            else bx = rloc[0] + w + gap;                       // 左贴边 → 气泡放右侧
            int by = (dockSide == 2) ? (rloc[1] + h + gap) : (rloc[1] + (h - bh) / 2);
            bx = Math.max(dp(4), Math.min(bx, screenW - bw - dp(4)));
            by = Math.max(dp(4), Math.min(by, screenH - bh - dp(4)));

            bubbleLp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    overlayWindowType(),
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                    PixelFormat.TRANSLUCENT);
            bubbleLp.gravity = Gravity.TOP | Gravity.START;
            int offY = (lp == null) ? 0 : (rloc[1] - lp.y);
            bubbleLp.x = bx;
            bubbleLp.y = by - offY;
            bubbleDx = bubbleLp.x - (lp == null ? 0 : lp.x);
            bubbleDy = bubbleLp.y - (lp == null ? 0 : lp.y);

            if (!bubbleVisible) {
                wm.addView(bubbleView, bubbleLp);
                bubbleVisible = true;
            } else {
                try { wm.updateViewLayout(bubbleView, bubbleLp); } catch (Throwable ignored) {}
            }
            bubbleHandler.removeCallbacks(bubbleHider);
            int delay = autoHideMs > 0 ? autoHideMs : petAutoHideMs;
            if (delay > 0) bubbleHandler.postDelayed(bubbleHider, delay);
            logVis("bubble show: " + text + " at(" + bx + "," + by + ") offY=" + offY);
        } catch (Throwable t) {
            logVis("bubble show failed: " + t);
        }
    }

    /**
     * v1.73（用户实测）：拖动悬浮球时，气泡要**跟着走**。
     * 用"相对偏移"跟随（显示时算好 bubbleDx/Dy），比每帧重算省事，也不会碰到
     * 「拖动中 getLocationOnScreen() 还是旧值」这个坑。
     */
    private void followBubble() {
        try {
            if (!bubbleVisible || bubbleView == null || bubbleLp == null || lp == null) return;
            bubbleLp.x = lp.x + bubbleDx;
            bubbleLp.y = lp.y + bubbleDy;
            wm.updateViewLayout(bubbleView, bubbleLp);
        } catch (Throwable ignored) {}
    }

    /** v1.73：拖动结束时把气泡按当前位置夹回屏内，并重新计时（松手也算一步动作）。 */
    private void clampBubble() {
        try {
            if (!bubbleVisible || bubbleView == null || bubbleLp == null) return;
            int screenW = getResources().getDisplayMetrics().widthPixels;
            int screenH = getResources().getDisplayMetrics().heightPixels;
            bubbleLp.x = Math.max(dp(4), Math.min(bubbleLp.x, screenW - bubbleView.getWidth() - dp(4)));
            bubbleLp.y = Math.max(dp(4), Math.min(bubbleLp.y, screenH - bubbleView.getHeight() - dp(4)));
            wm.updateViewLayout(bubbleView, bubbleLp);
            bubbleHandler.removeCallbacks(bubbleHider);
            if (petAutoHideMs > 0) bubbleHandler.postDelayed(bubbleHider, petAutoHideMs);
        } catch (Throwable ignored) {}
    }

    /** v1.88：限高的 ScrollView —— 跟着文本长，但不超过 maxPx（超过就滚动）。 */
    private static class MaxHeightScrollView extends android.widget.ScrollView {
        private int maxPx = 0;
        MaxHeightScrollView(Context c) { super(c); }
        void setMaxPx(int px) { maxPx = px; }
        @Override protected void onMeasure(int wSpec, int hSpec) {
            int capped = hSpec;
            if (maxPx > 0) capped = View.MeasureSpec.makeMeasureSpec(maxPx, View.MeasureSpec.AT_MOST);
            super.onMeasure(wSpec, capped);
        }
    }

    /** 触点是否落在悬浮球窗口内（气泡的 outside 判定要排除「点在球上」）。 */
    private boolean insideBall(float rawX, float rawY) {
        try {
            if (rootView == null) return false;
            int[] loc = new int[2];
            rootView.getLocationOnScreen(loc);
            int w = rootView.getWidth(), h = rootView.getHeight();
            return rawX >= loc[0] && rawX <= loc[0] + w && rawY >= loc[1] && rawY <= loc[1] + h;
        } catch (Throwable t) {
            return false;
        }
    }

    private void hideBubble() {
        try {
            bubbleHandler.removeCallbacks(bubbleHider);
            if (bubbleVisible && bubbleView != null && wm != null) {
                try { wm.removeView(bubbleView); } catch (Throwable ignored) {}
            }
        } catch (Throwable ignored) {}
        bubbleVisible = false;
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
        finishTurnAccounting();          // v1.75：这一轮结束 → 后台算本轮消耗
        updateCard(reply);               // v1.77：卡片跟着长（逐字观感）
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
            // v1.78：卡片（流体云）在显示时，**不再**把面板的回复区一起铺开 ——
            // 否则同一段回复同时出现在"顶部卡片"和"面板大框"里（用户实测报"这不像流体云"就是因为后者更抢眼）。
            // 手动「刷新」路径（manual=true）不受影响：那时会显式 setReplyShown(true)。
            if (!cardVisible) {
                setReplyShown(true);
                if (!panelVisible) setPanelVisible(true, true);
            }
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
                        boolean changed = !d.reply.equals(lastStreamText);
                        lastStreamText = d.reply;
                        applyReply(d.obj(), false, expectUser);   // 内容没变也不会重绘
                        updateCard(d.reply);                      // v1.77：卡片跟着长
                        // v1.77：卡片开着且内容还在变长 → 继续密集轮询（"逐字"就靠这个）。
                        // 连续两次一样（= 写完了）或到上限就收尾。⚠️ 每次都要跑 node 解压会话文件，有代价。
                        if (cardVisible && changed && streamAttempts < 40) {
                            streamAttempts++;
                            rootView.postDelayed(new Runnable() { @Override public void run() {
                                refreshReplyAt(sessionId, expectUser, false, gen, attempt + 1);
                            }}, cardPollMs);
                            return;
                        }
                        replyWaiting = false;
                        scheduleCardHide();
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
        android.graphics.Bitmap petIcon = loadPetIcon(dp(petBallDp));   // v1.71：大小来自 pet.json
        if (petIcon != null) {
            iconView.setImageBitmap(petIcon);
            iconIsPet = true;                      // v1.67 诊断：/overlay 里报 iconSrc
        } else {
            iconView.setImageResource(R.drawable.ic_whale_black); // 兜底：解码失败仍用原图标
            iconIsPet = false;
        }
        iconView.setLayoutParams(new LinearLayout.LayoutParams(dp(petBallDp), dp(petBallDp)));
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
        chatInputView = chatInput;   // v1.67：收起面板时要用它还焦点（原来拿不到，只能靠失焦回调）

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
                        markTurnStart();   // v1.75：记下这一轮的起点余额
                        showCard("正在生成…");   // v1.77：流式回复卡
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

        // v1.24：原来的「打开应用 / 虚拟屏」两个按钮已移除（面板太挤）。
        // 回 App 走通知栏或桌面图标；虚拟屏预览仍可由其他入口唤起。
        LinearLayout btnRow2 = new LinearLayout(this);
        btnRow2.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams r2p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        r2p.topMargin = dp(5);
        btnRow2.setLayoutParams(r2p);
        // 销毁屏：替代旧预览窗上的 ✕（销毁功能收进小鲸鱼面板）
        // v1.37：面板里给出「开/关虚拟屏」——一个按钮，文字随状态变
        vscreenBtn = pillButton("开虚拟屏", new Runnable() { @Override public void run() {
            try { VsreenBridgeService.toggleFromUi(); } catch (Throwable ignored) {}
            setPanelVisible(false, true);
        }});
        btnRow2.addView(vscreenBtn);
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
        // v1.70（用户用截图纠正了我的误解）：
        //   「收起」= 把**那块长的对话/回复区**收起来、回到紧凑面板（面板本身留着）；
        //             ⛔ 不是关掉整个面板（v1.69 我做成关面板了，用户明确否掉）。
        //   「隐藏」= 球收回**半隐藏**（面板一起收起）。
        btnRow2.addView(pillButton("收起", new Runnable() { @Override public void run() {
            setReplyShown(false);
            // 顺手把"有内容"标记清掉：否则下次再打开面板时 setPanelVisible(true) 会按
            // hasReplyContent() 又把它自动铺开 —— 用户会觉得"收起没生效"。
            // 新回复到达时 applyReply→showReplyArea() 会重新标记并铺开，所以不会漏消息。
            replyHasContent = false;
            try {
                if (lp != null) {   // 窗口是 WRAP_CONTENT，收起后必须让它重新量一次
                    lp.width = WindowManager.LayoutParams.WRAP_CONTENT;
                    lp.height = WindowManager.LayoutParams.WRAP_CONTENT;
                    wm.updateViewLayout(rootView, lp);
                }
            } catch (Throwable ignored) {}
            settleAfterLayout();
        }}));
        // v1.83（可自行开关）：面板上一个开关，选择记进 prefs
        fluidBtn = pillButton(fluidLabel(), new Runnable() { @Override public void run() {
            setFluid(!cardAutoShow);
        }});
        btnRow2.addView(fluidBtn);
        btnRow2.addView(pillButton("隐藏", new Runnable() { @Override public void run() {
            ballTucked = true;           // 半隐藏（静置态）
            setPanelVisible(false, true);
        }}));

        panelView.addView(btnRow2);
        rootView.addView(panelView);
        setPanelVisible(false, false);

        // ===== 拖动 + 点击 + 长按唤醒语音 + 拖底隐藏 =====
        rootView.setOnTouchListener(new View.OnTouchListener() {
            private long downAt = 0;
            private boolean longPressFired = false;
            private final Runnable longPressRunnable = new Runnable() {
                @Override
                public void run() {
                    if (!dragging) {
                        longPressFired = true;
                        VoiceManager.get(OverlayService.this).triggerVoiceInteraction();
                    }
                }
            };

            @Override public boolean onTouch(View v, MotionEvent ev) {
                switch (ev.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        downAt = System.currentTimeMillis();
                        touchX = ev.getRawX(); touchY = ev.getRawY();
                        startX = lp.x; startY = lp.y;
                        dragging = false;
                        longPressFired = false;
                        handler.postDelayed(longPressRunnable, 450);
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        if (Math.abs(ev.getRawX() - touchX) > dp(8) || Math.abs(ev.getRawY() - touchY) > dp(8)) {
                            dragging = true;
                            handler.removeCallbacks(longPressRunnable);
                        }
                        if (dragging) {
                            lp.x = (int) (startX + (ev.getRawX() - touchX));
                            lp.y = (int) (startY + (ev.getRawY() - touchY));
                            try { wm.updateViewLayout(rootView, lp); } catch (Throwable ignored) {}
                            updateDismissHint(ev.getRawY());
                            followBubble();   // v1.73：气泡跟着球走（用户实测原来不跟随）
                        }
                        return true;
                    case MotionEvent.ACTION_UP:
                        handler.removeCallbacks(longPressRunnable);
                        boolean onRoot = true;
                        if (longPressFired) {
                            // 已经触发长按语音唤醒，松手不再处理点击
                        } else if (dragging && dismissHint && !panelVisible) {
                            hideByDragToBottom();
                        } else if (dragging) {
                            snapToEdge(ev.getRawX(), ev.getRawY());
                            if (panelVisible) setPanelVisible(true, false);
                            clampBubble();
                        } else if (System.currentTimeMillis() - downAt < 400) {
                            onBallTap();
                        }
                        logDrag("up", ev, v, onRoot);
                        setDismissHintInternal(false);
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        handler.removeCallbacks(longPressRunnable);
                        logDrag("cancel", ev, v, false);
                        setDismissHintInternal(false);
                        return true;
                    case MotionEvent.ACTION_OUTSIDE:
                        // v1.69 关键修复：**输入框有焦点时（用户正在打字）不要关面板**。
                        // 为什么：键盘是另一个窗口，用户每按一个键，对我们来说都是"落在窗口外的 DOWN"
                        // → 系统给我们发 ACTION_OUTSIDE → 原来一律关面板。
                        // 实测线索：注入点球开面板后 1~2 秒面板自己变回关闭，当时用户正在**微信**里打字
                        // （键盘前台 = com.sohu.inputmethod.sogouoem）—— 键盘的每一次按键都会把它关掉。
                        // 这也顺带解释了老报障"输入以后对话框收不回去/一闪"：面板在跟键盘抢同一个事件流。
                        // v1.72：顺手补旧欠账 —— outside 事件一直没记坐标，没法判「是不是点在面板下半部分」。
                        logVis("ball outside-tap at(" + (int) ev.getRawX() + "," + (int) ev.getRawY() + ")");
                        hideBubble();   // 点别处 → 气泡消失（用户指定的唯一途径）
                        if (panelVisible) {
                            if (inputHasFocus()) {
                                logVis("outside-ignored: input focused");
                            } else {
                                logVis("outside-close");
                                setPanelVisible(false, true);
                            }
                        }
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
                // ⛔ v1.68 血的教训（装机后 40 秒就被用户抓到）：把 `==` 改成 `!=` 之后，
                //   这条"不一致就以真实前台为准"的自愈**才真的会动**，于是立刻暴露了它的前提是错的：
                //   **a11y 报的 activePackage 会是我们自己的包** —— 只要用户碰了我们自己的悬浮窗
                //   （尤其点输入框、让它变成可获焦窗口），前台就被报成 com.deepseek.harness。
                //   实测日志（1.29/112，2026-10-01 21:12:59 起）：
                //     harness -> fgHidden=true  → 球当场消失
                //     launcher -> fgHidden=false → 球又回来   （如此往复，用户报"一点说点什么球就消失一会"）
                //   还有第三个数：输入法（com.sohu.inputmethod.sogouoem）在前台时也被当成"别的 App"。
                //   ⇒ 这个信号**只能判"确实切到别的 App 了"，不能判"回到 App 了"**。
                // v1.68 因此收紧成三条（每条都独立可回滚）：
                //   ① 只朝"该露出来"一个方向治（永不因为 a11y 报文把球藏起来）；
                //   ② 跳过 systemui 与当前默认输入法；
                //   ③ 要求连续 2 次（≈4 秒）读到同一个包才动手，瞬时抖动不再引起闪烁。
                boolean ignorable = fg == null || fg.isEmpty()
                        || fg.startsWith("com.android.systemui")
                        || (!defaultImePackage().isEmpty() && fg.equals(defaultImePackage()));
                if (ignorable) {
                    lastFgPkg = null;
                    sameFgCount = 0;
                } else {
                    if (fg.equals(lastFgPkg)) sameFgCount++;
                    else { lastFgPkg = fg; sameFgCount = 1; }
                    boolean dshInFront = fg.equals(getPackageName());
                    if (!dshInFront && foregroundWantsHidden && sameFgCount >= 2) {
                        // 只在"确实在别的 App / 桌面上，且已经稳定 4 秒"时，把球放出来
                        foregroundWantsHidden = false;
                        logVis("fg-heal: activePackage=" + fg + " (stable x" + sameFgCount
                                + ") -> fgHidden=false");
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
            maybeStreamCard();   // v1.79：不管从哪儿发的，只要 AI 在写就飘一张卡
        } catch (Throwable ignored) {}
    }

    /** 记录上一次用于摆放的屏幕尺寸（旋转自愈的基准）。 */
    private int lastScreenW = 0;
    private int lastScreenH = 0;

    // v1.68：a11y 前台账的"连续同值"计数（自愈防抖用），以及输入法包名缓存。
    private String lastFgPkg = null;
    private int sameFgCount = 0;
    private String imePkgCache = null;

    /**
     * v1.69（用户指定）：球的"半隐藏"意图。
     * true = 静置半藏（默认，也是「隐藏」按钮的效果）；
     * false = 完整露出（点「收起」只收对话窗口后，球留在原地不缩回去）。
     * 摆放时与面板状态一起决定落点：`tuck = ballTucked && !panelVisible`。
     */
    private boolean ballTucked = true;

    /** v1.69：面板输入框当前是否有焦点（= 用户正在面板里打字）。 */
    private boolean inputHasFocus() {
        try { return chatInputView != null && chatInputView.hasFocus(); } catch (Throwable t) { return false; }
    }

    /**
     * v1.68：当前默认输入法的包名（缓存；取不到返回空串）。
     * 为什么要它：默认输入法弹出来时 a11y 会把前台报成输入法包名（实测 com.sohu.inputmethod.sogouoem），
     * 那并不代表"用户离开了 App" —— 而是用户**正在我们的面板里打字**。把它当成"切到别的 App"
     * 会让球在打字时忽隐忽现（v1.67 就是这么被用户抓到的）。
     */
    private String defaultImePackage() {
        if (imePkgCache == null) {
            String p = "";
            try {
                String ime = android.provider.Settings.Secure.getString(
                        getContentResolver(), android.provider.Settings.Secure.DEFAULT_INPUT_METHOD);
                if (ime != null && ime.indexOf('/') > 0) p = ime.substring(0, ime.indexOf('/'));
            } catch (Throwable ignored) {}
            imePkgCache = p;
        }
        return imePkgCache;
    }

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
                    // v1.67 诊断：用户报「调出来之后球变得很小」，光看 getWidth() 分不清是
                    // ①窗口/视图真的变小 ②被 scale 缩了 ③图换成了兜底黑鲸鱼 ④密度取错。
                    // 这四项各自独立报出来，下次一眼就能定性。
                    + ",\"iconSrc\":" + (s.iconIsPet ? "\"pet\"" : "\"fallback\"")
                    + ",\"rootScale\":[" + (s.rootView == null ? -1 : s.rootView.getScaleX())
                    + "," + (s.rootView == null ? -1 : s.rootView.getScaleY()) + "]"
                    + ",\"iconScale\":[" + (s.iconView == null ? -1 : s.iconView.getScaleX())
                    + "," + (s.iconView == null ? -1 : s.iconView.getScaleY()) + "]"
                    + ",\"rootAlpha\":" + (s.rootView == null ? -1 : s.rootView.getAlpha())
                    + ",\"lpWH\":[" + (s.lp == null ? -1 : s.lp.width)
                    + "," + (s.lp == null ? -1 : s.lp.height) + "]"
                    // v1.67：Bug A 的判据 —— FLAG_NOT_FOCUSABLE(0x8) 在不在 lp.flags 里。
                    // 正常（收起态）必须置位；点过输入框后若它没了、inputFocused 还 true，
                    // 就坐实"输入后窗口一直可获焦 → 抢焦点吃返回键 → 收不回去"。
                    + ",\"lpFlags\":" + (s.lp == null ? -1 : s.lp.flags)
                    + ",\"inputFocused\":" + (s.chatInputView != null && s.chatInputView.hasFocus())
                    + ",\"screen\":[" + s.getResources().getDisplayMetrics().widthPixels
                    + "," + s.getResources().getDisplayMetrics().heightPixels + "]"
                    + ",\"density\":" + s.getResources().getDisplayMetrics().density
                    + ",\"petJsonOk\":" + s.petJsonOk
                    + ",\"petLines\":" + s.petLines.length
                    + ",\"bubbleVisible\":" + s.bubbleVisible
                    + ",\"cardVisible\":" + s.cardVisible
                    + ",\"balanceOk\":" + (s.balanceText != null)
                    + ",\"peakNow\":" + s.isPeakNow()
                    + ",\"todaySpentCents\":" + (s.balRef < 0 || s.balLast < 0 ? -1 : Math.round((s.balRef - s.balLast) * 100))
                    + ",\"turnSpentCents\":" + (s.turnSpent < 0 ? -1 : Math.round(s.turnSpent * 100))
                    + ",\"balanceAgeSec\":" + (s.balanceAt == 0L ? -1 : (System.currentTimeMillis() - s.balanceAt) / 1000)
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
                // v1.79：球藏起来时收气泡，但**不收卡片** —— 卡片是"流体云"，本来就要能浮在
                // App 自己的界面上（用户选 A：GUI 里聊天也要看得到）。它由生成结束/服务销毁来收。
                if (!show) hideBubble();
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
            boolean tuck = ballTucked && !panelVisible;   // v1.69：面板开着必完整露出；收起后看「收起/隐藏」意图

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

    /**
     * v1.67 修「在面板里输入过之后，对话框/输入法收不回去」。
     *
     * 原实现只把 panelView 置 GONE，**完全没碰**下面三样：
     *   ① 输入框焦点 —— 原来唯一会恢复窗口标志的地方是 chatInput 的 OnFocusChangeListener；
     *      而把 panelView 置 GONE 并不保证触发它。一旦没触发，lp 就**一直停在"可获焦"**，
     *      悬浮窗继续抢焦点、吃掉返回键 → 表现就是面板/输入法都"收不回去"。
     *   ② 输入法本身 —— 没有任何一处调 hideSoftInputFromWindow，软键盘就留在屏上。
     *   ③ lp.flags —— 上面那条的后果；这里**显式**再补一次 NOT_FOCUSABLE，不依赖任何回调。
     * 三步都幂等：面板没开、没输入时调用无副作用。
     */
    private void releasePanelInput() {
        try {
            if (chatInputView != null) {
                chatInputView.clearFocus();
                android.view.inputmethod.InputMethodManager imm =
                        (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm != null) {
                    imm.hideSoftInputFromWindow(chatInputView.getWindowToken(), 0);
                }
            }
        } catch (Throwable ignored) {}
        try {
            if (lp != null && rootView != null) {
                lp.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
                wm.updateViewLayout(rootView, lp);
            }
        } catch (Throwable ignored) {}
    }

    /**
     * v1.67：控制台「显示悬浮球」在服务**还活着**时的正确语义 —— 解除"用户拖底隐藏"并重新应用可见性。
     *
     * 为什么需要它：原来 /overlay?action=show 在 isRunning==true 时直接返回"已在运行"、
     * 什么都不做。于是球只要是被"拖到底部隐藏"（userHidden=true）藏起来的，
     * 从控制台怎么点都调不出来（服务在跑、窗口在、就是不露脸）。
     * 真正的可见性规则仍然只有 applyVisibleNow() 一处（App 在前台时照旧隐藏，不会违反 v1.13.12）。
     */
    public static String reshowFromBridge() {
        final OverlayService s = instance;
        if (s == null) return "{\"ok\":false,\"error\":\"overlay not running\"}";
        try {
            s.handler.post(new Runnable() { @Override public void run() {
                try {
                    s.setUserHidden(false);   // v1.88：也落盘（控制台点「显示悬浮球」= 用户要它）
                    s.applyVisibleNow();   // 里面已含缩放/尺寸复位（v1.64）
                    s.wiggle();
                } catch (Throwable ignored) {}
            }});
            return "{\"ok\":true,\"queued\":true}";
        } catch (Throwable t) {
            return "{\"ok\":false,\"error\":\"" + String.valueOf(t.getMessage()).replace("\"", "'") + "\"}";
        }
    }

    /** 面板显示/隐藏；animate=true 时带旋转抖动 + 位置过渡（唤出、收起共用）。 */
    private void setPanelVisible(boolean show, boolean animate) {
        // v1.69 诊断：面板每次变化都记一行（含球的半隐藏意图）—— 用户报"面板开了又自己关"
        // 时，这行 + 上面的 outside-ignored/outside-close 就能直接指认是谁干的。
        logVis("panel " + panelVisible + " -> " + show + " (animate=" + animate
                + " ballTucked=" + ballTucked + " inputFocused=" + inputHasFocus() + ")");
        panelVisible = show;
        if (panelView != null) panelView.setVisibility(show ? View.VISIBLE : View.GONE);
        if (!show) releasePanelInput();   // v1.67：收起时把焦点 / 输入法 / 窗口标志一起收回
        if (show) {
            refreshPanelDynamicRows();
            // v1.38：回复区只在**真有消息**时才露出来（没发消息时不该出现）。
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
            boolean tuck = ballTucked && !panelVisible;   // v1.69：与 snapToEdge 必须一致
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

    /** 拖到底部松手：关掉小鲸鱼（通知栏「开启悬浮球」可恢复；v1.88 起这个状态会落盘）。 */
    private void hideByDragToBottom() {
        setUserHidden(true);
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
                    "小鲸鱼已关闭，可从通知栏「开启悬浮球」恢复", android.widget.Toast.LENGTH_LONG).show();
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
