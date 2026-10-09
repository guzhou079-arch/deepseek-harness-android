package com.deepseek.harness;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.drawable.GradientDrawable;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLConnection;

import moe.shizuku.server.IRemoteProcess;
import moe.shizuku.server.IShizukuService;
import rikka.shizuku.Shizuku;

/**
 * 虚拟屏【接入桥】。
 *
 * 分工（v1.11 起）：
 *  - 真正的能力由**特权服务端**提供：{@code com.deepseek.harness.vscreen.Main} 以 shell 身份
 *    （Shizuku app_process）运行，在 127.0.0.1:8998 上提供 create/launch/see/preview/tap/swipe/key/close。
 *  - 本服务只做两件事：① 拉起并守护那个特权进程；② 在 8999 上把它**原样代理**给插件（插件协议不变）。
 *
 * 为什么不能在 App 进程里建屏（旧实现的方向性错误）：
 *  - App 身份建的虚拟屏是主屏镜像（MediaProjection），既弹授权框，又只有 mDisplayIdToMirror=0；
 *  - App 身份把外部 App 启动到虚拟屏会被 SafeActivityOptions.checkPermissions 拒绝
 *    （logcat 实测：Permission Denial ... with launchDisplayId=N）。
 *  shell 身份两件事都成立，这是本文件存在的唯一理由。
 */
public class VsreenBridgeService extends Service {

    private static final String TAG = "VsreenBridge";

    /** 插件使用的对外端口（本服务的代理端口）。 */
    private static final int PORT = 8999;
    /** 特权服务端端口。 */
    private static final int CORE_PORT = 8998;
    /** 特权服务端主类。 */
    private static final String CORE_MAIN = "com.deepseek.harness.vscreen.Main";

    /**
     * 期望的服务端构建指纹（必须与 vscreen/Main.java 的 BUILD 一致）。
     * 不匹配 → 杀掉旧 core 重新拉起。旧进程偷生过很多次，
     * 表现为“服务在跑但新路由/新参数静默失效”（如 create 的 width/height 被完全忽略）。
     * v1.13.12：core 加了心跳看门狗（App 死了 → 20 秒后自动销毁虚拟屏并退出）。
     */
    private static final String EXPECTED_CORE_BUILD = "vs-audit-20261009-origin";

    /** 持有 Shizuku 拉起的进程引用：被 GC 回收会连带清理子进程。 */
    private static volatile IRemoteProcess sCoreProc;
    private static volatile boolean sCoreStarting;

    private volatile ServerSocket serverSocket;
    private volatile boolean running;

    // ==================== 预览浮窗状态 ====================
    private android.widget.FrameLayout previewRootView = null;
    private ImageView previewImageView = null;
    private WindowManager previewWm = null;
    private WindowManager.LayoutParams previewLp = null;
    private final Handler previewHandler = new Handler(Looper.getMainLooper());
    private android.view.ScaleGestureDetector scaleDetector = null;
    private float downX, downY, startLpX, startLpY;
    private volatile boolean previewWindowVisible = false;
    private volatile boolean previewPolling = false;
    private Thread previewPollThread = null;
    private Thread coreWatcher = null;
    // v1.14：Shizuku 不可用（ColorOS 冻结 Shizuku 应用是常见情形）时，watcher 会一轮轮失败。
    // 这里记录上次「无授权」告警时间，配合下面的指数退避，避免每 ~25s 刷一条 W 级日志
    // （实测 20:09:59 / 20:10:25 / 20:10:50，一天约 3400 条）。
    private volatile long lastNoShizukuLogAt = 0L;
    private Bitmap lastPreviewBitmap = null;
    private volatile int vdW = 0, vdH = 0;
    private volatile int vdDisplayId = -1;
    /** 已应用的宽高比，用于只在变屏/旋转时重算窗口高度，不干扰用户手动拖动/缩放。 */
    private volatile float lastAspect = 0f;
    /** v1.36：预览窗缩放倍数（1.0 = 基准 260dp 宽），持久化在 dsh_prefs。 */
    private volatile float previewScale = 1f;
    /** v1.36：预览窗处于「缩到一旁」的小标签态（虚拟屏继续跑）。 */
    private volatile boolean previewSideCollapsed = false;
    /** v1.36：画面区容器（里面有画面 + 浮在角落的按钮）。 */
    private FrameLayout previewImageArea = null;
    /** v1.39：外层卡片（要换圆角/圆形背景，所以留个引用）。 */
    private LinearLayout previewShell = null;
    /** v1.39：收成小球时显示的内容（画出来的手机轮廓，可点=展开）。 */
    private FrameLayout previewBallGlyph = null;
    /** v1.37：开屏占位（收到第一帧前替代黑屏）。 */
    private TextView previewPlaceholder = null;
    /** v1.37：刚建屏、还没画面 —— 先显示占位。 */
    private volatile boolean previewWaitingFirstApp = false;
    private volatile long previewWaitDeadline = 0L;
    /** v1.43：画面区长按（= 手动启动一个 App）的待触发任务。 */
    private Runnable longPressRunnable = null;
    /** v1.43：没法搬到虚拟屏的包 —— 桌面/系统界面挑不出一致的启动组件（实测桌面会 No activity found）。 */
    private static final String VSCREEN_FALLBACK_PKG = "com.android.settings";
    private volatile boolean lastVscreenRunning = false;
    /** 用户点了 ✕ 关掉的虚拟屏 displayId —— 轮询别再自动把它弹回来。 */
    private volatile int previewDismissedDisplayId = Integer.MIN_VALUE;
    /**
     * v1.13.11：预览窗被「收起到小鲸鱼」（▾）—— 轮询同样不要自动弹回来，
     * 但语义与 ✕ 不同：虚拟屏仍在跑，用户可从桌面小鲸鱼面板把预览窗叫回来。
     */
    private volatile boolean previewCollapsedToWhale = false;
    /** v1.13.11：服务实例（供小鲸鱼面板回调「重新打开预览窗」）。 */
    private static volatile VsreenBridgeService instance = null;
    /**
     * v1.13.12：虚拟屏当前是否在跑（预览轮询每 ~750ms 刷新）。
     * 小鲸鱼面板据此决定要不要显示「销毁屏」按钮。
     */
    public static volatile boolean sVscreenRunning = false;

    /** 小鲸鱼面板「虚拟屏」按钮：重新打开预览窗（配合「收起到小鲸鱼」）。 */
    public static void showPreviewFromWhale() {
        VsreenBridgeService s = instance;
        if (s != null) s.doShowPreviewFromWhale();
    }

    /** 小鲸鱼面板「销毁屏」按钮：销毁虚拟屏并收掉预览窗（替代旧预览窗上的 ✕）。 */
    public static void destroyVscreenFromWhale() {
        VsreenBridgeService s = instance;
        if (s != null) s.destroyVscreen();
    }

    /** 控制台「停止引擎」联动：引擎停了虚拟屏一起销毁（用户确认的行为）。 */
    public static void requestDestroyVscreen() {
        VsreenBridgeService s = instance;
        if (s != null) s.destroyVscreen();
    }

    /** v1.14.3：预览浮窗开关，默认 **关**。
     *  旧行为是「只要虚拟屏在跑就无条件显示预览窗」，而虚拟屏画面为空时，它在主屏上就是一块
     *  半透明黑长方形（2026-09-25 用户实测投诉："屏幕一直有一块半透明黑块挡着"）。
     *  改为必须显式打开：`GET http://127.0.0.1:8999/dsh/vscreen-preview?on=1`（`?on=0` 关；不带参数=只查询）。
     *  ⚠ 前缀必须避开 `/vscreen/*`：那是要转发给 core 的真实路由，其中 `/vscreen/preview`
     *  正是 OverlayService（悬浮窗）和本类轮询取帧用的，抢了它会直接把预览画面弄坏。 */
    private static final String PREF_PREVIEW = "vscreen_preview_on";

    private boolean previewWanted() {
        try {
            return getSharedPreferences("dsh_prefs", MODE_PRIVATE).getBoolean(PREF_PREVIEW, false);
        } catch (Throwable t) {
            return false;
        }
    }

    private void showPreviewWindow() {
        try {
            previewHandler.post(new Runnable() {
                @Override public void run() { doShowPreviewWindow(); }
            });
        } catch (Throwable ignored) {}
    }

    private void doShowPreviewWindow() {
        try {
            if (!Settings.canDrawOverlays(this)) {
                Log.w(TAG, "预览窗需要悬浮窗权限（设置→应用→显示在其他应用上层）");
                return;
            }
            if (previewRootView != null) return;
            previewWm = (WindowManager) getSystemService(WINDOW_SERVICE);
            // v1.36：宽度按用户上次的缩放倍数算（缩放按钮持久化）
            previewScale = loadPreviewScale();
            previewSideCollapsed = false;
            int w = Math.round(dp(260) * previewScale), h = dp(430);
            previewLp = new WindowManager.LayoutParams(
                    w, h,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    android.graphics.PixelFormat.TRANSLUCENT);
            // 用 LEFT 绝对坐标（不用 END：END 的 x 是"距右边缘"，左右拖动会异常）
            previewLp.gravity = Gravity.TOP | Gravity.START;
            // 初始位置：右上角（留边距，不贴边）；用户可自由拖动到任意位置
            previewLp.x = getResources().getDisplayMetrics().widthPixels - w - dp(24);
            previewLp.y = dp(120);

            // v1.39（按用户反馈重做）：删掉"黑底 + 中间一道蓝杠"的顶栏（用户：那是个什么东西），
            // 改成一张干净的圆角卡片；控制键做成小圆形浮在画面左上/右上；
            // 「缩到一旁」收成一颗**圆形小球**（跟悬浮球同一观感），点小球展开。
            LinearLayout shell = new LinearLayout(this);
            shell.setOrientation(LinearLayout.VERTICAL);
            previewShell = shell;
            applyShellShape(false);
            try { shell.setClipToOutline(true); } catch (Throwable ignored) {}

            // v1.39.1（用户反馈）：别用 emoji —— 上一版的 🖥 渲染成了"老式主机"，很丑。
            // 这里直接画一个**简单的手机轮廓**：描边圆角矩形 + 底部一小横线（Home 条），不依赖任何字体。
            previewBallGlyph = new FrameLayout(this);
            FrameLayout phoneBox = new FrameLayout(this);
            GradientDrawable phoneBg = new GradientDrawable();
            phoneBg.setShape(GradientDrawable.RECTANGLE);
            phoneBg.setCornerRadius(dp(4));
            phoneBg.setStroke(dp(2), 0xFFEAF2FF);
            phoneBg.setColor(0x00000000);
            phoneBox.setBackground(phoneBg);
            FrameLayout.LayoutParams phoneLp = new FrameLayout.LayoutParams(dp(16), dp(26));
            phoneLp.gravity = Gravity.CENTER;
            previewBallGlyph.addView(phoneBox, phoneLp);
            View phoneHome = new View(this);
            GradientDrawable homeBg = new GradientDrawable();
            homeBg.setCornerRadius(dp(1));
            homeBg.setColor(0xFFEAF2FF);
            phoneHome.setBackground(homeBg);
            FrameLayout.LayoutParams homeLp = new FrameLayout.LayoutParams(dp(6), dp(2));
            homeLp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
            homeLp.bottomMargin = dp(3);
            phoneBox.addView(phoneHome, homeLp);
            // 关键 bug 修复：上一版把带点击的顶栏删了，小球就没法点了 ⇒ 现在**整个球**都可点
            previewBallGlyph.setClickable(true);
            previewBallGlyph.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) {
                try { expandPreviewFromSide(); } catch (Throwable ignored) {}
            }});
            previewBallGlyph.setOnLongClickListener(new View.OnLongClickListener() { @Override public boolean onLongClick(View v) {
                try { collapsePreviewToWhale(); } catch (Throwable ignored) {}
                return true;
            }});
            previewBallGlyph.setVisibility(View.GONE);
            previewShell.addView(previewBallGlyph, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

            // --- 显示区域（虚拟屏画面）---
            // v1.36.1：按钮**浮在画面的左上角 / 右上角**，不再单独占一条底部栏 —— 画面更大、
            // 也不挡中间内容。按钮是半透明的（0x33FFFFFF），压在画面上仍能看清。
            previewImageArea = new FrameLayout(this);
            previewImageView = new ImageView(this);
            previewImageView.setScaleType(ImageView.ScaleType.FIT_CENTER);
            previewImageArea.addView(previewImageView, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

            // v1.37：开屏那几秒**不要黑屏** —— 先摆一块好看的占位，第一帧到了自动撤掉
            previewPlaceholder = new TextView(this);
            previewPlaceholder.setText(idleCardText(true));
            previewPlaceholder.setTextSize(13f);
            previewPlaceholder.setTextColor(getColor(R.color.accent_brand));
            previewPlaceholder.setGravity(Gravity.CENTER);
            previewPlaceholder.setLineSpacing(dp(4), 1f);
            try {
                previewPlaceholder.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                        new int[]{0xFF101A24, 0xFF1B2A3B}));
            } catch (Throwable ignored) {}
            previewPlaceholder.setVisibility(View.VISIBLE);
            // v1.43：卡片**不许吃触摸**。它以前挂了长按监听 → 变成 clickable →
            //   把落在画面区的 ACTION_DOWN 全部消费掉，父容器 previewRootView 的拖动
            //   再也收不到事件，表现就是"虚拟屏没法移动"（2026-10-03 用户报障的真凶）。
            //   长按改由 previewRootView 的触摸处理器统一处理（见下面的长按检测）。
            previewPlaceholder.setClickable(false);
            previewPlaceholder.setLongClickable(false);
            previewPlaceholder.setFocusable(false);
            previewImageArea.addView(previewPlaceholder, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

            LinearLayout zoomGroup = new LinearLayout(this);
            zoomGroup.setOrientation(LinearLayout.HORIZONTAL);
            zoomGroup.addView(makeIconBtn(IconView.MINUS, new View.OnClickListener() { @Override public void onClick(View v) { zoomPreview(1f / 1.12f); } }), circleLp());
            zoomGroup.addView(makeIconBtn(IconView.PLUS, new View.OnClickListener() { @Override public void onClick(View v) { zoomPreview(1.12f); } }), circleLp());
            FrameLayout.LayoutParams zoomLp = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            zoomLp.gravity = Gravity.TOP | Gravity.START;
            zoomLp.setMargins(dp(6), dp(6), 0, 0);
            previewImageArea.addView(zoomGroup, zoomLp);

            LinearLayout winGroup = new LinearLayout(this);
            winGroup.setOrientation(LinearLayout.HORIZONTAL);
            // v1.42：收进侧边 = 右向箭头（画出来的）；关闭 = 交叉线（画出来的）
            winGroup.addView(makeIconBtn(IconView.CHEVRON_RIGHT, new View.OnClickListener() { @Override public void onClick(View v) { collapsePreviewToSide(); } }), circleLp());
            View closeBtn = makeIconBtn(IconView.CROSS, new View.OnClickListener() { @Override public void onClick(View v) { closePreviewWindowOnly(); } });
            closeBtn.setOnLongClickListener(new View.OnLongClickListener() { @Override public boolean onLongClick(View v) { destroyVscreen(); return true; } });
            winGroup.addView(closeBtn, circleLp());
            FrameLayout.LayoutParams winLp = new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
            winLp.gravity = Gravity.TOP | Gravity.END;
            winLp.setMargins(0, dp(6), dp(6), 0);
            previewImageArea.addView(winGroup, winLp);

            shell.addView(previewImageArea, new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

            previewRootView = new FrameLayout(this);
            previewRootView.addView(shell, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT));


            // 建窗即按当前虚拟屏比例算尺寸（否则要等下一次比例"变化"才生效）
            lastAspect = 0f;
            previewLp.height = expandedHeightPx(previewLp.width);

            scaleDetector = new ScaleGestureDetector(this, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                @Override public boolean onScale(ScaleGestureDetector detector) {
                    // 最小化时不响应双指缩放；缩放后统一走 clampPreviewBounds()
                    //（旧实现只在一处夹边界，双指放大就能把窗口撑到屏幕外，
                    //  于是右上角的按钮条被推出屏幕 → 用户看到的就是“控制条没有出现”）
                    if (previewLp == null || previewCollapsedToWhale || previewSideCollapsed) return true;
                    float f = detector.getScaleFactor();
                    previewLp.width = Math.max(dp(120), Math.round(previewLp.width * f));
                    previewLp.height = Math.max(barHeightPx(), Math.round(previewLp.height * f));
                    // v1.36：双指缩放也要同步"倍数"，否则再按 ＋/－ 会跳回旧倍数
                    float s = previewLp.width / (float) Math.max(1, dp(260));
                    if (s < 0.6f) s = 0.6f;
                    if (s > 2.2f) s = 2.2f;
                    previewScale = s;
                    savePreviewScale(s);
                    clampPreviewBounds();
                    updatePreviewLayout();
                    return true;
                }
            });
            previewRootView.setOnTouchListener(new View.OnTouchListener() {
                @Override public boolean onTouch(View v, MotionEvent e) {
                    // 小条区域自己消费点击（收起）；拖动/缩放/长按在画面区域做
                    scaleDetector.onTouchEvent(e);
                    switch (e.getActionMasked()) {
                        case MotionEvent.ACTION_DOWN:
                            downX = e.getRawX();
                            downY = e.getRawY();
                            startLpX = previewLp.x;
                            startLpY = previewLp.y;
                            // v1.43：长按（按住不动 ~550ms）= 手动把「上次成功用过的 App（没有就 设置）」
                            //   启动到虚拟屏。以前这件事挂在占位卡片上，代价是拖动被吃掉。
                            cancelLongPressPending();
                            longPressRunnable = new Runnable() { @Override public void run() {
                                longPressRunnable = null;
                                try { launchOnVscreen(vscreenTargetOrDefault(lastVscreenPkg())); }
                                catch (Throwable ignored) {}
                            }};
                            previewHandler.postDelayed(longPressRunnable, 550);
                            return true;
                        case MotionEvent.ACTION_MOVE:
                            if (!scaleDetector.isInProgress()) {
                                float dx = e.getRawX() - downX;
                                float dy = e.getRawY() - downY;
                                // 手指一挪就撤掉长按（避免"拖动时顺手弹出一个 App"）
                                if (Math.abs(dx) > dp(10) || Math.abs(dy) > dp(10)) cancelLongPressPending();
                                previewLp.x = Math.round(startLpX + dx);
                                previewLp.y = Math.round(startLpY + dy);
                                // 统一夹边界（含状态栏让位后的可用高度），保证小条永远可点
                                clampPreviewBounds();
                                updatePreviewLayout();
                            }
                            return true;
                        case MotionEvent.ACTION_UP:
                        case MotionEvent.ACTION_CANCEL:
                            cancelLongPressPending();
                            return true;
                    }
                    return false;
                }
            });

            clampPreviewBounds();          // 建窗即夹，避免初始就超出屏幕
            previewWm.addView(previewRootView, previewLp);
            previewWindowVisible = true;
            // v1.39：按上次的选择决定初始形态（首次默认收成小球，不挡屏幕）
            if (startCollapsed()) collapsePreviewToSide();
            Log.i(TAG, "虚拟屏预览窗已显示（画面区拖动/缩放，顶部小条点击收起到小鲸鱼）");
        } catch (Throwable t) {
            Log.w(TAG, "showPreviewWindow failed: " + t.getMessage());
        }
    }

    // ==================== v1.37：开关虚拟屏（面板 / 通知栏共用入口） ====================

    /** 面板与通知栏的共用入口：开 ↔ 关 虚拟屏。 */
    public static void toggleFromUi() {
        VsreenBridgeService s = instance;
        if (s == null) return;
        s.doUiToggle();
    }

    /** 供面板刷新文字用。 */
    public static boolean isVscreenRunning() { return sVscreenRunning; }

    private void doUiToggle() {
        if (sVscreenRunning || vdDisplayId >= 0) { destroyVscreen(); return; }
        createFromUi();
    }

    /**
     * v1.37：从小鲸鱼面板 / 通知栏开虚拟屏 —— 建屏 + 打开预览窗 + **把当前主屏的 App 挪上去**，
     * 这样用户看到的不是一片黑，而是"刚才那块屏上的应用"。
     */
    private void createFromUi() {
        previewDismissedDisplayId = Integer.MIN_VALUE;
        previewCollapsedToWhale = false;
        previewWaitingFirstApp = true;
        previewWaitDeadline = System.currentTimeMillis() + 12000;
        try { getSharedPreferences("dsh_prefs", MODE_PRIVATE).edit().putBoolean(PREF_PREVIEW, true).apply(); }
        catch (Throwable ignored) {}
        final int w = getResources().getDisplayMetrics().widthPixels;
        final int h = getResources().getDisplayMetrics().heightPixels;
        final int dpi = getResources().getDisplayMetrics().densityDpi;
        new Thread(new Runnable() { @Override public void run() {
            final String r = coreGet("/vscreen/create?width=" + w + "&height=" + h + "&dpi=" + dpi, 15000);
            final boolean ok = r != null && r.indexOf("\"ok\":true") >= 0;
            previewHandler.post(new Runnable() { @Override public void run() {
                if (!ok) { toast("开虚拟屏失败（特权服务无响应 / 无 Shizuku）"); return; }
                showPreviewWindow();
                toast("虚拟屏已开");
            }});
            if (!ok) return;
            // 把当前主屏前台应用移到虚拟屏。
            // v1.43：桌面 / 系统界面 / 自己都**不能搬**（实测把桌面搬上去 → 核心回
            //   `无法解析启动组件：com.android.launcher（No activity found）` → 虚拟屏空着，
            //   而卡片会一直停在"正在把当前应用移过来…"，看着像卡死）。
            //   挑不出来就退回"上次成功搬过的 App"，再挑不出来才走空屏分支。
            String pkg = topPackageOnMainDisplay();
            if (!isVscreenTargetUsable(pkg)) pkg = vscreenTargetOrDefault(lastVscreenPkg());
            if (pkg != null && pkg.length() > 0) {
                launchOnVscreen(pkg);
            } else {
                previewHandler.post(new Runnable() { @Override public void run() {
                    if (previewPlaceholder != null) { previewPlaceholder.setText(idleCardText(false)); previewPlaceholder.setVisibility(View.VISIBLE); }
                    if (previewImageView != null) previewImageView.setVisibility(View.GONE);
                }});
                toast("虚拟屏是空的 · 长按预览窗可启动一个应用");
            }
        }}, "vscreen-ui-create").start();
    }

    /** v1.43：这个包能不能搬到虚拟屏 —— 桌面/系统界面/自己都不行。 */
    private boolean isVscreenTargetUsable(String p) {
        if (p == null || p.length() == 0) return false;
        if (p.equals(getPackageName())) return false;          // 自己（DSH）
        if (p.equals("com.android.systemui")) return false;    // 系统界面
        if (p.contains("launcher")) return false;              // 各家桌面：没有可解析的启动组件
        return true;
    }

    /** v1.43：挑一个能搬的目标；挑不出来返回 null。 */
    private String vscreenTargetOrDefault(String last) {
        if (isVscreenTargetUsable(last)) return last;
        return VSCREEN_FALLBACK_PKG;
    }

    /** v1.43：取消待触发的长按（手指挪动 / 抬起 / 窗口重建时调）。 */
    private void cancelLongPressPending() {
        if (longPressRunnable != null) {
            try { previewHandler.removeCallbacks(longPressRunnable); } catch (Throwable ignored) {}
            longPressRunnable = null;
        }
    }

    /** v1.38：空闲卡文字（launching=true 表示正在搬当前应用）。 */
    private String idleCardText(boolean launching) {
        String last = vscreenTargetOrDefault(lastVscreenPkg());
        String hint;
        if (launching) hint = "正在把当前应用移过来…";
        else if (last != null && last.length() > 0) hint = "长按这里：启动上次用过的 " + last;
        else hint = "长按这里：启动「设置」";
        return "🐋  虚拟屏已就绪\n" + hint;
    }

    /** v1.38：上次成功搬到虚拟屏的包名（没记录过返回 null）。 */
    private String lastVscreenPkg() {
        try { return getSharedPreferences("dsh_prefs", MODE_PRIVATE).getString("vscreen_last_pkg", null); }
        catch (Throwable t) { return null; }
    }

    /** v1.38：把某个包启动到虚拟屏；**成功之后**才记住它（下次空闲时优先用它）。 */
    private void launchOnVscreen(String pkg) {
        if (!isVscreenTargetUsable(pkg)) return;      // v1.43：桌面/自己一律不搬
        final String p = pkg;
        new Thread(new Runnable() { @Override public void run() {
            final String r = coreGet("/vscreen/launch?pkg=" + p, 15000);
            final boolean ok = r != null && r.indexOf("\"ok\":true") >= 0;
            if (ok) {
                // v1.43：**成功之后**才记「上次用过的 App」。以前是先写后试 →
                //   一次失败的尝试（桌面）就把这个值写坏了，之后长按只会反复失败。
                try {
                    getSharedPreferences("dsh_prefs", MODE_PRIVATE).edit()
                            .putString("vscreen_last_pkg", p).apply();
                } catch (Throwable ignored) {}
                previewWaitingFirstApp = false;      // 有应用了 → 卡片交给真实画面
                previewHandler.post(new Runnable() { @Override public void run() {
                    if (previewPlaceholder != null) previewPlaceholder.setVisibility(View.GONE);
                }});
            } else {
                // v1.43：失败就把卡片改回**可操作**文案。以前只弹个 toast，
                //   卡片会永远停在「正在把当前应用移过来…」→ 看着像卡死。
                Log.w(TAG, "vscreen launch failed: " + p + " → " + r);
                previewHandler.post(new Runnable() { @Override public void run() {
                    toast("搬不过去：" + p + "（长按画面可换一个 App）");
                    if (previewPlaceholder != null) {
                        previewPlaceholder.setText(idleCardText(false));
                        previewPlaceholder.setVisibility(View.VISIBLE);
                    }
                    if (previewImageView != null) previewImageView.setVisibility(View.GONE);
                }});
            }
        }}, "vscreen-launch-ui").start();
    }

    /** 主屏（display #0）当前前台包名；拿不到返回 null。 */
    private String topPackageOnMainDisplay() {
        String out = shizukuExec("dumpsys activity activities | grep -E 'Display #|topResumedActivity'", 8000);
        if (out == null) return null;
        String[] lines = out.split("\n");
        int cur = -1;
        for (int i = 0; i < lines.length; i++) {
            String ln = lines[i];
            int d = ln.indexOf("Display #");
            if (d >= 0) {
                int j = d + 9, n = 0;
                while (j < ln.length() && ln.charAt(j) >= '0' && ln.charAt(j) <= '9') { n = n * 10 + (ln.charAt(j) - '0'); j++; }
                cur = n;
                continue;
            }
            if (cur == 0 && ln.indexOf("topResumedActivity") >= 0) {
                int u = ln.indexOf(" u0 ");
                if (u < 0) continue;
                String rest = ln.substring(u + 4);
                int slash = rest.indexOf('/');
                if (slash <= 0) continue;
                return rest.substring(0, slash).trim();
            }
        }
        return null;
    }

    /** 用 Shizuku 跑一条 shell 命令并把 stdout 读回来（没权限/失败返回 null）。 */
    private String shizukuExec(String cmd, int timeoutMs) {
        try {
            if (!hasShizukuPermission()) return null;
            IShizukuService svc = IShizukuService.Stub.asInterface(Shizuku.getBinder());
            IRemoteProcess p = svc.newProcess(new String[]{"/system/bin/sh", "-c", cmd}, null, null);
            android.os.ParcelFileDescriptor pfd = p.getInputStream();
            InputStream in = new android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd);
            StringBuilder sb = new StringBuilder();
            byte[] buf = new byte[4096];
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (System.currentTimeMillis() < deadline) {
                int n = in.read(buf);
                if (n <= 0) break;
                sb.append(new String(buf, 0, n, "UTF-8"));
                if (sb.length() > 65536) break;
            }
            try { in.close(); } catch (Throwable ignored) {}
            return sb.toString();
        } catch (Throwable t) {
            Log.w(TAG, "shizukuExec failed: " + t.getMessage());
            return null;
        }
    }

    /** 采样判断"几乎是黑屏"（用于决定要不要继续用占位盖住）。 */
    private boolean isMostlyDark(Bitmap bmp) {
        try {
            int w = bmp.getWidth(), h = bmp.getHeight();
            if (w <= 0 || h <= 0) return false;
            long sum = 0; int n = 0;
            for (int i = 1; i <= 4; i++) {
                for (int j = 1; j <= 4; j++) {
                    int px = bmp.getPixel(w * i / 5, h * j / 5);
                    sum += ((px >> 16) & 0xFF) + ((px >> 8) & 0xFF) + (px & 0xFF);
                    n += 3;
                }
            }
            return n > 0 && (sum / n) < 12;
        } catch (Throwable t) {
            return false;
        }
    }

    // ==================== v1.36：预览窗控制（缩放 / 缩到一旁 / 关闭） ====================

    /** 控制条高度。 */
    private int ctlHeightPx() { return dp(34); }

    /** 读回持久化的缩放倍数（夹在 0.6~2.2）。 */
    private float loadPreviewScale() {
        try {
            float v = getSharedPreferences("dsh_prefs", MODE_PRIVATE).getFloat("vscreen_preview_scale", 1f);
            if (v < 0.6f) v = 0.6f;
            if (v > 2.2f) v = 2.2f;
            return v;
        } catch (Throwable t) { return 1f; }
    }

    private void savePreviewScale(float v) {
        try { getSharedPreferences("dsh_prefs", MODE_PRIVATE).edit().putFloat("vscreen_preview_scale", v).apply(); }
        catch (Throwable ignored) {}
    }

    /** v1.41：展开态基准宽度（dp）。原来 260dp 在 dpi 高的机器上乘 1.0 就撞到上限，
     *  于是"放大"按钮按了没反应 —— 用户报的正是这个。 */
    private int baseWidthDp() { return 230; }

    /** 展开态高度 = 画面（按虚拟屏比例）。 */
    private int expandedHeightPx(int w) {
        int maxH = Math.round(getResources().getDisplayMetrics().heightPixels * 0.8f);
        int imgH = (vdW > 0 && vdH > 0) ? Math.round(w * (vdH / (float) vdW)) : dp(400);
        int minImg = dp(110);
        int maxImg = Math.max(minImg, maxH - dp(24) - ctlHeightPx());
        if (imgH < minImg) imgH = minImg;
        if (imgH > maxImg) imgH = maxImg;
        return imgH;   // v1.39：没有顶栏了，窗口高度就是画面高度
    }

    /** 按 previewScale 重排展开态窗口（宽/高/夹边界）。 */
    private void applyExpandedSize() {
        if (previewLp == null) return;
        if (previewImageArea != null) previewImageArea.setVisibility(View.VISIBLE);
        previewLp.width = Math.round(dp(baseWidthDp()) * previewScale);
        previewLp.height = expandedHeightPx(previewLp.width);
        clampPreviewBounds();
        updatePreviewLayout();
    }

    /** ＋/－：缩放（1.15 倍一档，夹在 0.6~2.2 并持久化）。 */
    private void zoomPreview(final float factor) {
        previewHandler.post(new Runnable() { @Override public void run() {
            try {
                if (previewLp == null) return;
                float v = previewScale * factor;
                if (v < 0.6f) v = 0.6f;
                if (v > 2.2f) v = 2.2f;
                boolean capped = false;
                if (Math.abs(v - previewScale) < 0.005f) capped = true;
                previewScale = v;
                savePreviewScale(v);
                previewSideCollapsed = false;
                applyExpandedSize();
                // v1.41：给可见反馈 —— 尺寸已经顶到上限时，也要让用户知道"不是没反应"
                int pct = Math.round(previewScale * 100);
                if (previewLp.width >= Math.round(getResources().getDisplayMetrics().widthPixels * 0.85f) - 2) {
                    toast("缩放 " + pct + "%（已到最大）");
                } else {
                    toast("缩放 " + pct + "%");
                }
            } catch (Throwable ignored) {}
        }});
    }

    /**
     * v1.39：「缩到一旁」= 收成屏幕边缘一颗**圆形小球**（跟悬浮球同一观感），点小球展开。
     * 状态记在 prefs，下次开虚拟屏默认还是你上次选的样子（首次默认收成小球）。
     */
    private void collapsePreviewToSide() {
        previewHandler.post(new Runnable() { @Override public void run() {
            try {
                if (previewLp == null || previewSideCollapsed) return;
                previewSideCollapsed = true;
                saveCollapsed(true);
                if (previewImageArea != null) previewImageArea.setVisibility(View.GONE);
                if (previewBallGlyph != null) previewBallGlyph.setVisibility(View.VISIBLE);
                applyShellShape(true);
                previewLp.width = ballSizePx();
                previewLp.height = ballSizePx();
                previewLp.x = getResources().getDisplayMetrics().widthPixels - ballSizePx() - dp(8);
                clampPreviewBounds();
                updatePreviewLayout();
            } catch (Throwable ignored) {}
        }});
    }

    /** 从「缩到一旁」还原成展开态（球 → 卡片）。 */
    private void expandPreviewFromSide() {
        previewHandler.post(new Runnable() { @Override public void run() {
            try {
                if (previewLp == null) return;
                previewSideCollapsed = false;
                saveCollapsed(false);
                if (previewBallGlyph != null) previewBallGlyph.setVisibility(View.GONE);
                applyShellShape(false);
                applyExpandedSize();
            } catch (Throwable ignored) {}
        }});
    }

    /** v1.42：按钮图标 —— 全部用画布画，不用文字、不用 emoji（用户：要简单图形）。 */
    private static class IconView extends View {
        static final int MINUS = 1, PLUS = 2, CHEVRON_RIGHT = 3, CROSS = 4;
        private final int kind;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        IconView(Context c, int kind, float strokePx) {
            super(c);
            this.kind = kind;
            paint.setColor(0xFFFFFFFF);
            paint.setStrokeWidth(strokePx);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
        }
        @Override protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight();
            float cx = w / 2f, cy = h / 2f, r = Math.min(w, h) * 0.23f;
            switch (kind) {
                case MINUS:
                    canvas.drawLine(cx - r, cy, cx + r, cy, paint);
                    break;
                case PLUS:
                    canvas.drawLine(cx - r, cy, cx + r, cy, paint);
                    canvas.drawLine(cx, cy - r, cx, cy + r, paint);
                    break;
                case CHEVRON_RIGHT:   // 收进右侧（小球就停在屏幕右边）
                    canvas.drawLine(cx - r * 0.8f, cy - r, cx + r * 0.6f, cy, paint);
                    canvas.drawLine(cx - r * 0.8f, cy + r, cx + r * 0.6f, cy, paint);
                    break;
                case CROSS:
                    canvas.drawLine(cx - r, cy - r, cx + r, cy + r, paint);
                    canvas.drawLine(cx - r, cy + r, cx + r, cy - r, paint);
                    break;
            }
        }
    }

    /** v1.42：圆形底 + 画出来的图标。 */
    private View makeIconBtn(int kind, View.OnClickListener l) {
        FrameLayout box = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(0x59000000);
        box.setBackground(bg);
        box.setClickable(true);
        box.setFocusable(false);
        box.setOnClickListener(l);
        IconView icon = new IconView(this, kind, dp(2));
        FrameLayout.LayoutParams ilp = new FrameLayout.LayoutParams(dp(16), dp(16));
        ilp.gravity = Gravity.CENTER;
        box.addView(icon, ilp);
        return box;
    }

    /** v1.39：卡片=圆角矩形；小球=正圆。 */
    private void applyShellShape(boolean circle) {
        try {
            if (previewShell == null) return;
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(circle ? 0xF21B2A3B : 0xE60B1622);
            if (circle) bg.setShape(GradientDrawable.OVAL);
            else bg.setCornerRadius(dp(16));
            previewShell.setBackground(bg);
            try { previewShell.setClipToOutline(true); } catch (Throwable ignored) {}
        } catch (Throwable ignored) {}
    }

    /** v1.39：记住"收成小球 / 展开"。 */
    private void saveCollapsed(boolean collapsed) {
        try { getSharedPreferences("dsh_prefs", MODE_PRIVATE).edit().putBoolean("vscreen_preview_collapsed", collapsed).apply(); }
        catch (Throwable ignored) {}
    }

    /** v1.39：默认是否收起（**首次默认收起**：先给个小球，不挡你屏幕）。 */
    private boolean startCollapsed() {
        try { return getSharedPreferences("dsh_prefs", MODE_PRIVATE).getBoolean("vscreen_preview_collapsed", true); }
        catch (Throwable t) { return true; }
    }

    /** ✕ 短按：只关预览窗（虚拟屏继续跑；记下 displayId 免得轮询又弹回来）。 */
    private void closePreviewWindowOnly() {
        try {
            previewDismissedDisplayId = vdDisplayId;
            previewSideCollapsed = false;
            hidePreviewWindow();
            toast("预览窗已关（虚拟屏还在跑；长按 ✕ = 销毁虚拟屏）");
        } catch (Throwable ignored) {}
    }

    /** v1.39：小圆形按钮（代码生成；aapt 不可用 ⇒ 不能引用新增 XML 资源）。 */
    private TextView makeCircleBtn(String label, View.OnClickListener l) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextSize(13f);
        tv.setTextColor(0xFFFFFFFF);
        tv.setGravity(Gravity.CENTER);
        tv.setClickable(true);
        tv.setFocusable(false);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(0x59000000);
        tv.setBackground(bg);
        tv.setOnClickListener(l);
        return tv;
    }

    /** v1.39：圆形按钮 32dp，间距 5dp。 */
    private LinearLayout.LayoutParams circleLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(32), dp(32));
        lp.setMargins(dp(3), 0, dp(3), 0);
        return lp;
    }

    /** 安全更新预览窗布局：View 已 detach（窗口被移除）时静默跳过 —— 防止 updateViewLayout 崩溃。 */
    private void updatePreviewLayout() {
        try {
            if (previewRootView == null || previewWm == null) return;
            if (!previewRootView.isAttachedToWindow()) return;
            previewWm.updateViewLayout(previewRootView, previewLp);
        } catch (Throwable ignored) {
            // 生命周期竞态：窗口已移除时忽略（历史闪退根因）
        }
    }

    /**
     * 预览窗尺寸与位置的**统一**夹回可见范围。
     * 任何会改 previewLp 的路径（建窗 / 双指缩放 / 拖动 / 折叠）都必须调它，
     * 否则窗口能超出屏幕 —— 按钮条被推出屏幕，用户看到的就是「控制条没出现」。
     */
    private void clampPreviewBounds() {
        try {
            if (previewLp == null) return;
            final int screenW = getResources().getDisplayMetrics().widthPixels;
            final int usableH = usableHeight();
            // v1.36：「缩到一旁」的小标签很小，不能按展开态的最小宽高夹，只夹可见性
            if (previewSideCollapsed) {
                if (previewLp.x > screenW - previewLp.width) previewLp.x = screenW - previewLp.width;
                if (previewLp.x < 0) previewLp.x = 0;
                if (previewLp.y < 0) previewLp.y = 0;
                if (previewLp.y > usableH - previewLp.height) previewLp.y = usableH - previewLp.height;
                return;
            }
            // 最大只占屏幕 70%：留出位置让下面的聊天/主屏还能操作（旧实现能被撑到满屏）
            final int maxW = Math.max(dp(120), Math.round(screenW * 0.85f));   // v1.41：70% → 85%
            final int maxH = Math.max(barHeightPx(), Math.round(usableH * 0.7f));
            if (previewLp.width > maxW) previewLp.width = maxW;
            if (previewLp.width < dp(120)) previewLp.width = dp(120);
            int minH = dp(110);
            if (previewLp.height > maxH) previewLp.height = maxH;
            if (previewLp.height < minH) previewLp.height = minH;
            if (previewLp.x > screenW - previewLp.width) previewLp.x = screenW - previewLp.width;
            if (previewLp.y > usableH - previewLp.height) previewLp.y = usableH - previewLp.height;
            if (previewLp.x < 0) previewLp.x = 0;
            if (previewLp.y < 0) previewLp.y = 0;
        } catch (Throwable ignored) {}
    }

    /** 去掉状态栏占位后的可用高度：窗口坐标是从状态栏下方开始算的（真机实测偏移 133px）。 */
    private int usableHeight() {
        int h = getResources().getDisplayMetrics().heightPixels - statusBarInset();
        return h > 0 ? h : getResources().getDisplayMetrics().heightPixels;
    }

    private int statusBarInset() {
        try {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (id > 0) return getResources().getDimensionPixelSize(id);
        } catch (Throwable ignored) {}
        return 0;
    }

    /** 最小化时保留的高度：一条按钮栏 + 上下留白。 */
    private int barHeightPx() { return dp(40); }
    /** v1.39：小球直径（跟悬浮球观感对齐）。 */
    private int ballSizePx() { return dp(52); }

    /**
     * v1.13.11：预览窗 ✕ = **销毁/停止虚拟屏**。
     * 旧实现只是「关窗」—— 虚拟屏还继续跑着，想停只能让 AI 调 android_vscreen_close，
     * 与按钮语义不符（用户明确要求改成销毁/停止）。现在先请求特权服务端 /vscreen/close，
     * 再收掉预览窗；请求失败如实提示，不假装成功。
     */
    private void destroyVscreen() {
        // 没有虚拟屏在跑：静默收掉窗与钉住即可，不发请求也不弹"已关闭"（避免假反馈）
        if (!sVscreenRunning && vdDisplayId < 0) {
            previewHandler.post(new Runnable() { @Override public void run() {
                try {
                    hidePreviewWindow();
                    OverlayService.pinForVscreen(false);
                } catch (Throwable ignored) {}
            }});
            return;
        }
        final int closingId = vdDisplayId;
        sVscreenRunning = false;
        new Thread(new Runnable() { @Override public void run() {
            final String r = coreGet("/vscreen/close", 8000);
            previewHandler.post(new Runnable() { @Override public void run() {
                try {
                    // 记下「这块屏是用户主动销毁的」：轮询看到旧 id 时不要再弹回来
                    previewDismissedDisplayId = closingId;
                    previewCollapsedToWhale = false;
                    vdDisplayId = -1;
                    hidePreviewWindow();
                    OverlayService.pinForVscreen(false);
                    toast(r == null ? "关闭虚拟屏失败（特权服务无响应）" : "虚拟屏已关闭");
                } catch (Throwable ignored) {}
            }});
        }}, "vscreen-close").start();
    }

    /**
     * v1.13.11：预览窗 ▾ = **收起到小鲸鱼**。
     * 旧实现是缩成一条按钮栏（仍占着屏幕）；现在直接收掉预览悬浮窗，改由桌面小鲸鱼承载画面
     * （小鲸鱼面板里本来就有虚拟屏画面区），并把它**钉住可见** —— App 在前台时小鲸鱼默认隐藏
     * （MainActivity.onStart → setOverlayVisible(false)），不钉住的话「收起」之后什么都看不到。
     */
    private void collapsePreviewToWhale() {
        previewHandler.post(new Runnable() { @Override public void run() {
            try {
                previewCollapsedToWhale = true;
                previewDismissedDisplayId = vdDisplayId;   // 别让预览轮询又把它弹回来
                hidePreviewWindow();
                OverlayService.pinForVscreen(true);
                toast("预览已收到小鲸鱼，点小鲸鱼可再打开");
            } catch (Throwable ignored) {}
        }});
    }

    private void doShowPreviewFromWhale() {
        try {
            previewDismissedDisplayId = Integer.MIN_VALUE;
            previewCollapsedToWhale = false;
            OverlayService.pinForVscreen(false);
            showPreviewWindow();
        } catch (Throwable ignored) {}
    }

    /** 浮层上的短提示（预览窗是 FLAG_NOT_FOCUSABLE，弹不出对话框）。 */
    private void toast(String msg) {
        try {
            android.widget.Toast.makeText(getApplicationContext(), msg, android.widget.Toast.LENGTH_SHORT).show();
        } catch (Throwable ignored) {}
    }

    private void hidePreviewWindow() {
        try {
            previewHandler.post(new Runnable() {
                @Override public void run() {
                    if (previewRootView != null && previewWm != null) {
                        try { previewWm.removeView(previewRootView); } catch (Throwable ignored) {}
                    }
                    previewRootView = null;
                    previewImageView = null;
                    previewWm = null;
                    previewWindowVisible = false;
                    if (lastPreviewBitmap != null) {
                        lastPreviewBitmap.recycle();
                        lastPreviewBitmap = null;
                    }
                }
            });
        } catch (Throwable ignored) {}
    }

    // ==================== 预览轮询（从特权服务端拉 JPEG 帧） ====================

    private void startPreviewPolling() {
        if (previewPolling) return;
        previewPolling = true;
        previewPollThread = new Thread(new Runnable() {
            @Override public void run() {
                int sinceStatus = 0;
                while (previewPolling) {
                    try {
                        if (sinceStatus <= 0) {
                            String st = coreGet("/vscreen/status", 3000);
                            sinceStatus = 5;
                            int id = jsonInt(st, "displayId", -1);
                            vdDisplayId = id;
                            vdW = jsonInt(st, "width", 0);
                            vdH = jsonInt(st, "height", 0);
                            boolean running = id >= 0 && jsonBool(st, "running");
                            sVscreenRunning = running;   // 小鲸鱼面板「销毁屏」按钮的显示依据
                            // v1.37：虚拟屏"刚起来"那几秒不要给用户一片黑 —— 先显示占位
                            if (running && !lastVscreenRunning) {
                                previewWaitingFirstApp = true;
                                previewWaitDeadline = System.currentTimeMillis() + 12000;
                            }
                            lastVscreenRunning = running;
                            if (id >= 0 && vdW > 0 && vdH > 0) applyAspect(vdW, vdH);
                            // v1.14.3：预览窗受开关控制（默认关，见 PREF_PREVIEW 注释）；虚拟屏一停就收起。
                            // v1.16.1：用户手动 ✕ 关掉的那块屏不自动弹回（重建/换屏时清标记）。
                            boolean wantPreview = previewWanted();
                            if (running) {
                                if (wantPreview && !previewWindowVisible && id != previewDismissedDisplayId) showPreviewWindow();
                                else if (!wantPreview && previewWindowVisible) hidePreviewWindow();
                            } else {
                                if (id < 0) previewDismissedDisplayId = Integer.MIN_VALUE;   // 虚拟屏已销毁 → 下次重建照常弹预览
                                if (previewWindowVisible) hidePreviewWindow();
                            }
                        }
                        sinceStatus--;
                        if (previewWindowVisible && previewImageView != null) {
                            String pv = coreGet("/vscreen/preview", 5000);
                            String b64 = jsonStr(pv, "previewB64");
                            if (b64 != null && b64.length() > 0) {
                                byte[] jpg = Base64.decode(b64, Base64.DEFAULT);
                                final Bitmap bmp = BitmapFactory.decodeByteArray(jpg, 0, jpg.length);
                                if (bmp != null) {
                                    previewHandler.post(new Runnable() {
                                        @Override public void run() {
                                            if (previewImageView == null) { bmp.recycle(); return; }
                                            // v1.37：刚建屏那几秒画面是全黑的（App 还没移上来）→ 用占位盖住，
                                            // 12 秒后无论如何照实显示（真·深色 App 不会被永久挡住）。
                                            // v1.38：只要"还没有应用被搬上来"，就一直用卡片盖着黑帧（不再 12 秒后露黑屏）
                                            if (previewWaitingFirstApp && isMostlyDark(bmp)) {
                                                bmp.recycle();
                                                previewImageView.setVisibility(View.GONE);
                                                if (previewPlaceholder != null) previewPlaceholder.setVisibility(View.VISIBLE);
                                                return;
                                            }
                                            previewWaitingFirstApp = false;
                                            if (lastPreviewBitmap != null && lastPreviewBitmap != bmp) {
                                                lastPreviewBitmap.recycle();
                                            }
                                            lastPreviewBitmap = bmp;
                                            previewImageView.setImageBitmap(bmp);
                                            previewImageView.setVisibility(View.VISIBLE);
                                            if (previewPlaceholder != null) previewPlaceholder.setVisibility(View.GONE);
                                        }
                                    });
                                }
                            }
                        }
                    } catch (Throwable ignored) {
                        // 服务端未就绪/虚拟屏未创建：静默，下一轮再试
                    }
                    try { Thread.sleep(150); } catch (InterruptedException e) { break; }
                }
            }
        }, "vscreen-preview-poll");
        previewPollThread.setDaemon(true);
        previewPollThread.start();
    }

    private void stopPreviewPolling() {
        previewPolling = false;
        if (previewPollThread != null) {
            previewPollThread.interrupt();
            previewPollThread = null;
        }
    }

    /** 预览窗宽度不变，高度按虚拟屏宽高比自适应（竖屏高瘦 / 横屏矮宽），避免 FIT_CENTER 留黑边。 */
    private void applyAspect(final int vw, final int vh) {
        final float aspect = vh / (float) vw;
        if (Math.abs(aspect - lastAspect) < 0.02f) return;
        lastAspect = aspect;
        try {
            previewHandler.post(new Runnable() {
                @Override public void run() {
                    // 窗口还没创建：撤销标记，等建窗后按当前虚拟屏比例重新算
                    // （否则标记被提前消费，之后每轮都因差值<0.02 提前返回 → 形状永远不变）
                    if (previewLp == null) { lastAspect = 0f; return; }
                    if (previewSideCollapsed) return;   // v1.36：小标签态不要被比例回写撑开
                    // v1.36：高度统一走 expandedHeightPx（小条 + 画面 + 控制条）
                    int h = expandedHeightPx(previewLp.width);
                    if (previewLp.height != h) {
                        previewLp.height = h;
                        updatePreviewLayout();
                    }
                }
            });
        } catch (Throwable ignored) {
        }
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private String extRoot() {
        // 必须与 MainActivity.pkgRoot() 完全一致：桥接从这里取 jar 交给特权进程，
        // 用错目录会拿到另一个根目录下的旧 jar（8998 跑旧版服务端 → 缺新路由 → 工具报错）。
        String p = getPackageName();
        return p.contains("beta") ? "DeepSeekHarnessLite"
                : p.contains("compat") ? "DeepSeekHarnessCompat" : "DeepSeekHarness";
    }

    // ==================== 生命周期 ====================

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;   // v1.13.11：供小鲸鱼面板回调「重新打开预览窗」
        running = true;
        new Thread(new Runnable() {
            @Override public void run() { ensureCoreServer(); }
        }, "vscreen-core-start").start();
        startCoreWatcher();
        startProxyServer();
        // 预览轮询必须常驻启动：它负责「发现虚拟屏→拉起预览窗」，不能在窗口显示后才启动（会互等死锁）
        startPreviewPolling();
        Log.i(TAG, "VsreenBridgeService started (proxy 8999 -> core 8998)");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        running = false;
        instance = null;
        stopPreviewPolling();
        hidePreviewWindow();
        if (serverSocket != null) { try { serverSocket.close(); } catch (Throwable ignored) {} }
        super.onDestroy();
    }

    // ==================== 拉起特权服务端（Shizuku app_process） ====================

    private boolean coreAlive() {
        String st = coreGet("/vscreen/ping", 1200);
        // 必须判 "ok":true：旧版/异常响应是 {"ok":false,...}，用 contains("ok") 会把错误响应误判成健康，
        // 导致 App 不再拉起新 core（旧进程占着 8998，缺新路由）。
        if (st == null || !st.contains("\"ok\":true")) return false;
        // 构建指纹也必須一致，否则说明 8998 上跑的是旧版服务端
        return st.contains("\"build\":\"" + EXPECTED_CORE_BUILD + "\"");
    }

    private void ensureCoreServer() {
        if (coreAlive()) { Log.i(TAG, "core server already alive"); return; }
        if (sCoreStarting) return;
        sCoreStarting = true;
        try {
            // Shizuku binder 是异步到达的（App 冷启动时通常晚几秒），必须等，否则会误判成无授权。
            if (!waitShizuku(20000)) {
                // v1.14：退避后仍会周期性走到这里，日志按 10 分钟节流（原来每轮都打）
                long now = System.currentTimeMillis();
                if (now - lastNoShizukuLogAt > 600000L) {
                    lastNoShizukuLogAt = now;
                    Log.w(TAG, "无 Shizuku 授权（binder 未就绪），稍后自动重试——请确认 Shizuku 服务在运行且已授权本应用");
                }
                return;
            }
            String dir = new File(Environment.getExternalStorageDirectory(), extRoot() + "/vscreen").getAbsolutePath();
            String rootDir = new File(Environment.getExternalStorageDirectory(), extRoot()).getAbsolutePath();
            File jar = new File(dir, "vscreen_shizuku.jar");
            if (!jar.exists()) {
                Log.w(TAG, "vscreen jar 不存在: " + jar.getAbsolutePath() + "（需要存储权限后由 MainActivity 提取）");
                return;
            }
            // jar 先由 shell 拷到 /data/local/tmp 再加载：/storage 对 Shizuku shell 进程不一定可见，
            // 且 /data/local/tmp 下 app_process 加载 dex 最稳（Operit/旧插件同做法）。
            String remoteJar = "/data/local/tmp/vscreen_shizuku.jar";
            // 启动前清掉占着 CORE_PORT 的旧 core（旧版进程不会自行退出；卸载/重装也不杀它）。
            // 用正则（不能加 -F）+ [x] 括号技巧：既能匹配 Main，又不会匹配到这条命令自身
            String killOld = "PID=$(ps -A -o PID,ARGS | grep 'com.deepseek.harness.vscreen.Mai[n]' "
                    + "| grep -v grep | awk '{print $1}'); "
                    + "if [ -n \"$PID\" ]; then kill -9 $PID 2>/dev/null; sleep 1; fi; ";
            String cmd = "echo \"--- core start $(date)\" >> /data/local/tmp/vscreen.log 2>&1; "
                    + killOld
                    + "id >> /data/local/tmp/vscreen.log 2>&1; "
                    + "cp -f \"" + jar.getAbsolutePath() + "\" " + remoteJar + " >> /data/local/tmp/vscreen.log 2>&1; "
                    + "chmod 644 " + remoteJar + " 2>/dev/null; "
                    + "CLASSPATH=" + remoteJar
                    + " /system/bin/app_process /system/bin " + CORE_MAIN
                    + " --port " + CORE_PORT + " --dir \"" + rootDir + "\""
                    + " >> /data/local/tmp/vscreen.log 2>&1";
            Log.i(TAG, "starting core server: " + cmd);
            IShizukuService svc = IShizukuService.Stub.asInterface(Shizuku.getBinder());
            IRemoteProcess p = svc.newProcess(
                    new String[]{"/system/bin/sh", "-c", cmd},
                    // env 必须传 null（继承 shell 环境）：传 {"PATH=..."} 会把 ANDROID_ROOT/BOOTCLASSPATH
                    // 等一起覆盖掉，app_process 起不了 ART 虚拟机，表现为静默无输出。
                    null, null);
            sCoreProc = p;
            for (int i = 0; i < 40; i++) {
                Thread.sleep(250);
                if (coreAlive()) { Log.i(TAG, "core server ready after " + (i + 1) * 250 + "ms"); return; }
            }
            Log.w(TAG, "core server 启动超时");
        } catch (Throwable t) {
            Log.w(TAG, "ensureCoreServer failed: " + t.getMessage());
        } finally {
            sCoreStarting = false;
        }
    }

    /** 等 Shizuku binder 就绪（冷启动异步到达）。 */
    private boolean waitShizuku(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (hasShizukuPermission()) return true;
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                return false;
            }
        }
        return hasShizukuPermission();
    }

    /** 后台守护：core 未就绪就重试（Shizuku 授权/binder 晚到、core 进程被杀都能自愈）。
     *  v1.14：改为指数退避（5s → 10s → … → 封顶 300s）。原来固定 5s，而 ensureCoreServer() 里的
     *  waitShizuku() 最坏要等 20s，于是在「Shizuku 不可用」的设备上形成 ~25s 一轮的固定重试：
     *  每轮一次 20s 的 binder 阻塞等待 + 一条 W 级日志。Shizuku 长期不可用是正常情形（厂商冻结），
     *  没必要高频重试；core 一旦真的起来（coreAlive()==true）立刻回到 5s 快恢复节奏。 */
    private void startCoreWatcher() {
        if (coreWatcher != null) return;
        coreWatcher = new Thread(new Runnable() {
            @Override
            public void run() {
                long backoffMs = 5000L;
                while (running) {
                    boolean ok = false;
                    try {
                        if (coreAlive()) {
                            ok = true;
                        } else {
                            ensureCoreServer();
                            ok = coreAlive();
                        }
                    } catch (Throwable t) {
                        Log.w(TAG, "core watcher: " + t.getMessage());
                    }
                    backoffMs = ok ? 5000L : Math.min(backoffMs * 2, 300000L);
                    try {
                        Thread.sleep(backoffMs);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }
        }, "vscreen-core-watch");
        coreWatcher.setDaemon(true);
        coreWatcher.start();
    }

    private boolean hasShizukuPermission() {
        try {
            if (!Shizuku.pingBinder()) return false;
            return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    // ==================== HTTP 代理（插件 8999 → 服务端 8998，原样透传） ====================

    private void startProxyServer() {
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    serverSocket = new ServerSocket(PORT, 8, InetAddress.getByName("127.0.0.1"));
                    Log.i(TAG, "proxy listening 127.0.0.1:" + PORT);
                    while (running && !serverSocket.isClosed()) {
                        final Socket s = serverSocket.accept();
                        new Thread(new Runnable() {
                            @Override public void run() { proxy(s); }
                        }, "vscreen-proxy-conn").start();
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "proxy server exited: " + t.getMessage());
                }
            }
        }, "vscreen-proxy").start();
    }

    private void proxy(Socket s) {
        OutputStream out = null;
        try {
            s.setSoTimeout(20000);
            String header = com.deepseek.harness.vscreen.LocalHttpFence.readHeader(s.getInputStream());
            int ep = getPackageName().endsWith(".beta") ? 3082 : getPackageName().endsWith(".compat") ? 3084 : 3080;
            int rejection = com.deepseek.harness.vscreen.LocalHttpFence.rejection(header, s.getLocalPort(), ep);
            if (rejection != 0) {
                com.deepseek.harness.vscreen.LocalHttpFence.reject(s.getOutputStream(), rejection);
                return;
            }
            String requestLine = header.substring(0, header.indexOf("\r\n"));
            String path = "/vscreen/status";
            int sp = requestLine.indexOf(' ');
            if (sp > 0) {
                int sp2 = requestLine.indexOf(' ', sp + 1);
                path = sp2 > sp ? requestLine.substring(sp + 1, sp2) : requestLine.substring(sp + 1);
            }
            // v1.14.3：本机私有控制路由 —— **不转发给 core**，直接由 App 处理：虚拟屏预览窗开关。
            // 路径前缀刻意用 /dsh/ 避开 core 的 /vscreen/*（尤其 /vscreen/preview 是取帧用的）。
            // 插件/AI 需要看虚拟屏画面时自己开，用完关掉，避免长期在主屏上盖窗。
            if (path.startsWith("/dsh/vscreen-preview")) {
                out = s.getOutputStream();
                boolean changed = path.contains("on=");
                boolean on = path.contains("on=1");
                if (changed) {
                    try {
                        getSharedPreferences("dsh_prefs", MODE_PRIVATE).edit().putBoolean(PREF_PREVIEW, on).apply();
                    } catch (Throwable ignored) {}
                    if (!on) hidePreviewWindow();
                } else {
                    on = previewWanted();
                }
                byte[] pbody = ("{\"ok\":true,\"preview\":" + on + "}").getBytes("UTF-8");
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
                        + "Content-Length: " + pbody.length + "\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
                out.write(pbody);
                out.flush();
                return;
            }
            out = s.getOutputStream();
            Socket up = null;
            try {
                up = new Socket();
                up.connect(new java.net.InetSocketAddress("127.0.0.1", CORE_PORT), 5000);
                up.setSoTimeout(20000);
                OutputStream uo = up.getOutputStream();
                uo.write(("GET " + path + " HTTP/1.0\r\nHost: 127.0.0.1:" + CORE_PORT + "\r\n\r\n").getBytes("UTF-8"));
                uo.flush();
                InputStream is = up.getInputStream();
                byte[] buf = new byte[32768];
                int n;
                while ((n = is.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
                out.flush();
            } catch (Throwable t) {
                // 服务端没起来：拉一次，再明确报错（避免插件只看到"未知错误"）
                if (path.startsWith("/vscreen/create") || path.startsWith("/vscreen/status")) {
                    new Thread(new Runnable() {
                        @Override public void run() { ensureCoreServer(); }
                    }, "vscreen-core-retry").start();
                }
                byte[] body = ("{\"ok\":false,\"error\":\"虚拟屏服务未就绪（特权进程未启动）："
                        + safe(t.getMessage()) + "\"}").getBytes("UTF-8");
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
                        + "Content-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
                out.write(body);
                out.flush();
            } finally {
                if (up != null) { try { up.close(); } catch (Throwable ignored) {} }
            }
        } catch (Throwable ignored) {
        } finally {
            try { if (out != null) out.flush(); } catch (Throwable ignored) {}
            try { s.close(); } catch (Throwable ignored) {}
        }
    }

    // ==================== 与服务端交互的小工具 ====================

    /** 直接请求特权服务端（预览轮询用；插件请求走 proxy）。 */
    private String coreGet(String path, int timeoutMs) {
        InputStream is = null;
        try {
            URL u = new URL("http://127.0.0.1:" + CORE_PORT + path);
            URLConnection c = u.openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            is = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
            String all = new String(bos.toByteArray(), "UTF-8");
            int idx = all.indexOf("\r\n\r\n");
            return idx >= 0 ? all.substring(idx + 4) : all;
        } catch (Throwable t) {
            return null;
        } finally {
            if (is != null) { try { is.close(); } catch (Throwable ignored) {} }
        }
    }

    private static String jsonStr(String json, String key) {
        if (json == null) return null;
        String k = "\"" + key + "\"";
        int i = json.indexOf(k);
        if (i < 0) return null;
        i = json.indexOf(':', i + k.length());
        if (i < 0) return null;
        int q1 = json.indexOf('"', i + 1);
        if (q1 < 0) return null;
        int q2 = json.indexOf('"', q1 + 1);
        if (q2 < 0) return null;
        return json.substring(q1 + 1, q2);
    }

    private static int jsonInt(String json, String key, int def) {
        if (json == null) return def;
        String k = "\"" + key + "\"";
        int i = json.indexOf(k);
        if (i < 0) return def;
        i = json.indexOf(':', i + k.length());
        if (i < 0) return def;
        int j = i + 1;
        while (j < json.length() && (json.charAt(j) == ' ' || json.charAt(j) == '"')) j++;
        int e = j;
        while (e < json.length() && (Character.isDigit(json.charAt(e)) || json.charAt(e) == '-')) e++;
        try { return Integer.parseInt(json.substring(j, e)); } catch (Throwable t) { return def; }
    }

    private static boolean jsonBool(String json, String key) {
        if (json == null) return false;
        String k = "\"" + key + "\"";
        int i = json.indexOf(k);
        if (i < 0) return false;
        i = json.indexOf(':', i + k.length());
        return i > 0 && json.startsWith("true", i + 1 + (json.charAt(i + 1) == ' ' ? 1 : 0));
    }

    private static String safe(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ");
    }
}
