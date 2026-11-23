package com.deepseek.harness;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextPaint;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.View.OnTouchListener;
import android.view.WindowManager;

/**
 * 主屏操作指示条。
 *
 * 背景：AI 用无障碍手势在别的 App 里点按/滑动时，屏幕上没有任何迹象说明「谁在动」——
 * 用户只看到界面自己跳。这个条在屏幕底部常驻一小条，写清当前这一步在做什么，
 * 并给出一个「停止」入口；操作结束就淡出，不常驻、不挡内容。
 *
 * 设计约束（都是踩过的坑）：
 *  1) 条本身会消费触摸事件。AI 正好要点头条覆盖的那片区域时会被它吃掉，
 *     所以 begin 时按需把窗口切成 FLAG_NOT_TOUCHABLE（见 passThrough），
 *     操作结束后再恢复可点，避免自动化被自己的提示条挡住。
 *  2) 窗口操作必须在主线程；begin/end 从 a11y 的 socket 线程调用，统一转投 Handler。
 *  3) 任何异常都不能影响屏幕操作的执行 —— 指示条是旁路，失败就静默降级。
 */
final class OpsBar {

    private static final String TAG = "OpsBar";

    /** 指示条高度。低到不压内容，又够放一行 13sp 文字。 */
    private static final int BAR_H_DP = 44;
    /** 条距屏幕底边的距离：让开手势导航区。 */
    private static final int BAR_BOTTOM_DP = 84;
    /** 条宽固定，文字超长省略 —— 宽度随文字跳动反而显得廉价。 */
    private static final int BAR_W_DP = 236;

    /** 一次操作结束后条的停留时间，够看清「刚才那步做了什么」。 */
    private static final long LINGER_MS = 800L;
    /** 停止后拒绝后续操作的冷却时长。 */
    private static final long STOP_COOLDOWN_MS = 5000L;
    /** 超过这个间隔没有新操作，就认为上一段操作已经结束，步数重新计。 */
    private static final long BURST_GAP_MS = 12000L;

    private static final int C_ACCENT = 0xFF7CC4FF;
    private static final int C_TEXT = 0xFFE9EEF6;
    private static final int C_DIM = 0xFF7E8899;
    private static final int C_WARN = 0xFFFFB86B;

    private static OpsBar sInst;

    private final Context app;
    private final Handler main;
    private final float density;

    private WindowManager wm;
    private BarView view;
    private WindowManager.LayoutParams lp;
    private boolean attached;
    private boolean blocked;

    // 主线程读写
    private String label = "";
    private int step;
    private boolean busy;
    private boolean stopped;
    private long burstAt;
    private long rippleAt;
    private long shownAt;
    private long hideAt;

    private volatile long stopUntil;

    private OpsBar(Context ctx) {
        app = ctx.getApplicationContext();
        main = new Handler(Looper.getMainLooper());
        density = app.getResources().getDisplayMetrics().density;
    }

    private static OpsBar get(Context ctx) {
        if (sInst == null) {
            synchronized (OpsBar.class) {
                if (sInst == null) sInst = new OpsBar(ctx);
            }
        }
        return sInst;
    }

    // ===================== 对外接口（可在任意线程调用） =====================

    /**
     * 报告一步即将执行的操作。返回 false 表示用户刚按过停止，调用方应当放弃这次操作。
     * label 是给人看的一句话，例如「点击『设置』」「向上滑动」「输入文字」。
     */
    static boolean begin(Context ctx, String kind, String label) {
        try {
            OpsBar b = get(ctx);
            long now = SystemClock.uptimeMillis();
            if (now < b.stopUntil) {
                b.postStoppedState();
                return false;
            }
            b.postBegin(label, now);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "begin failed", t);
            return true;
        }
    }

    /** 报告一步操作已收尾。ok=false 时条上显示为未完成态。 */
    static void end(Context ctx, boolean ok) {
        try {
            get(ctx).postEnd(ok);
        } catch (Throwable t) {
            Log.w(TAG, "end failed", t);
        }
    }

    /** 临时把指示条切成不可触摸，让紧接着的点击穿透到下面的 App。 */
    static void passThrough(Context ctx, long ms) {
        try {
            get(ctx).doPassThrough(ms);
        } catch (Throwable t) {
            Log.w(TAG, "passThrough failed", t);
        }
    }

    /** 判断某个屏幕坐标是否落在指示条上（供点击前做避让）。 */
    static boolean collidesWith(Context ctx, int x, int y) {
        try {
            return get(ctx).hitTest(x, y);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 立刻收起（例如退出屏幕助手时）。 */
    static void hide(Context ctx) {
        try {
            get(ctx).postHide();
        } catch (Throwable t) {
            Log.w(TAG, "hide failed", t);
        }
    }

    // ===================== 线程转投 =====================

    private void postBegin(final String text, final long now) {
        main.post(new Runnable() {
            @Override public void run() {
                try {
                    onBegin(text, now);
                } catch (Throwable t) {
                    Log.w(TAG, "onBegin failed", t);
                }
            }
        });
    }

    private void postEnd(final boolean ok) {
        main.post(new Runnable() {
            @Override public void run() {
                try {
                    onEnd(ok);
                } catch (Throwable t) {
                    Log.w(TAG, "onEnd failed", t);
                }
            }
        });
    }

    private void postStoppedState() {
        main.post(new Runnable() {
            @Override public void run() {
                try {
                    onStopped();
                } catch (Throwable t) {
                    Log.w(TAG, "onStopped failed", t);
                }
            }
        });
    }

    private void postHide() {
        main.post(new Runnable() {
            @Override public void run() {
                try {
                    animateOut();
                } catch (Throwable t) {
                    Log.w(TAG, "postHide failed", t);
                }
            }
        });
    }

    // ===================== 主线程状态机 =====================

    private void onBegin(String text, long now) {
        // 用户正看着 DSH 自己的界面时不必提示：聊天页本身就看得到工具在跑，
        // 条反而会压住输入框。只在操作别的 App 时出现。
        if (MainActivity.overlayForeground) {
            animateOut();
            return;
        }
        if (!ensureAttached()) return;
        if (now - burstAt > BURST_GAP_MS) step = 0;
        burstAt = now;
        step++;
        label = text == null ? "" : text;
        busy = true;
        stopped = false;
        rippleAt = now;
        hideAt = 0L;
        view.stepText = step > 1 ? String.valueOf(step) : "";
        // 正在淡出的条被新动作唤醒：要把动画方向掰回来，否则它会继续淡到 0 再被拆掉。
        if (view.animTarget <= 0.01f) {
            shownAt = now;
            animateIn();
        } else {
            view.invalidate();
            view.kick();
        }
    }

    private void onEnd(boolean ok) {
        busy = false;
        if (!attached) return;
        view.invalidate();
        view.kick();
        hideAt = SystemClock.uptimeMillis() + LINGER_MS;
        main.removeCallbacks(hideRunnable);
        main.postDelayed(hideRunnable, LINGER_MS + 60L);
    }

    private void onStopped() {
        if (!ensureAttached()) return;
        busy = false;
        stopped = true;
        label = "已停止 · 5 秒后可继续";
        step = 0;
        view.stepText = "";
        view.invalidate();
        view.kick();
        main.removeCallbacks(hideRunnable);
        main.postDelayed(hideRunnable, STOP_COOLDOWN_MS);
    }

    private final Runnable hideRunnable = new Runnable() {
        @Override public void run() {
            if (busy) return;
            if (stopped) stopped = false;
            animateOut();
        }
    };

    // ===================== 窗口 =====================

    private boolean ensureAttached() {
        if (attached) return true;
        if (blocked) return false;
        if (!Settings.canDrawOverlays(app)) {
            // 没有悬浮窗权限就彻底不出现；不能因为提示条把屏幕操作拦下来。
            blocked = true;
            return false;
        }
        try {
            if (wm == null) wm = (WindowManager) app.getSystemService(Context.WINDOW_SERVICE);
            if (view == null) {
                view = new BarView(app);
                view.setAlpha(0f);
            }
            if (lp == null) {
                DisplayMetrics dm = app.getResources().getDisplayMetrics();
                lp = new WindowManager.LayoutParams();
                lp.width = dp(BAR_W_DP);
                lp.height = dp(BAR_H_DP);
                lp.type = Build.VERSION.SDK_INT >= 26
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE;
                lp.format = PixelFormat.TRANSLUCENT;
                lp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
                lp.y = dp(BAR_BOTTOM_DP);
                lp.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED;
                // 太暗/太亮的背景上都要看得清字，条自己带底，不做系统级变暗。
                lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                if (dm.widthPixels > 0 && dp(BAR_W_DP) > dm.widthPixels - dp(24)) {
                    lp.width = dm.widthPixels - dp(24);
                }
            }
            wm.addView(view, lp);
            attached = true;
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "attach overlay failed", t);
            blocked = true;
            attached = false;
            return false;
        }
    }

    private void detach() {
        if (!attached) return;
        try {
            if (wm != null && view != null) wm.removeView(view);
        } catch (Throwable t) {
            Log.w(TAG, "detach overlay failed", t);
        }
        attached = false;
        view = null;
    }

    private void animateIn() {
        if (view == null) return;
        view.anim = 0f;
        view.animTarget = 1f;
        view.kick();
    }

    private void animateOut() {
        if (view == null || !attached) {
            detach();
            return;
        }
        view.animTarget = 0f;
        view.kick();
        main.postDelayed(new Runnable() {
            @Override public void run() {
                if (view != null && view.anim <= 0.01f) detach();
            }
        }, 320L);
    }

    private void doPassThrough(long ms) {
        main.post(new Runnable() {
            @Override public void run() {
                try {
                    if (!attached || lp == null || wm == null) return;
                    lp.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                    wm.updateViewLayout(view, lp);
                    main.postDelayed(new Runnable() {
                        @Override public void run() {
                            try {
                                if (attached && lp != null && wm != null) {
                                    lp.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                                    wm.updateViewLayout(view, lp);
                                }
                            } catch (Throwable ignored) {}
                        }
                    }, Math.max(120L, ms));
                } catch (Throwable t) {
                    Log.w(TAG, "passThrough apply failed", t);
                }
            }
        });
    }

    private boolean hitTest(int x, int y) {
        if (!attached || lp == null || view == null) return false;
        DisplayMetrics dm = app.getResources().getDisplayMetrics();
        int w = lp.width;
        int h = lp.height;
        int left = (dm.widthPixels - w) / 2;
        int top = dm.heightPixels - lp.y - h;
        // 命中区略放大，边缘点按也算「点到条了」，宁可多让一次也不要点空。
        int pad = dp(6);
        return x >= left - pad && x <= left + w + pad && y >= top - pad && y <= top + h + pad;
    }

    private int dp(float v) {
        return (int) (v * density + 0.5f);
    }

    // ===================== 绘制 =====================

    private final class BarView extends View {

        final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        final TextPaint tp = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        final RectF r = new RectF();
        final Path clip = new Path();

        String stepText = "";
        float anim;
        float animTarget;

        BarView(Context c) {
            super(c);
            p.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
            setLayerType(View.LAYER_TYPE_HARDWARE, null);
            setClickable(true);
            // 条上只有「停止」是有意义的点击目标，其余区域点了也不做事，
            // 但仍要吃掉事件 —— 否则手指按在条上会穿透到下面的 App，反而不自然。
            setOnTouchListener(new OnTouchListener() {
                @Override public boolean onTouch(View v, MotionEvent e) {
                    if (e.getAction() == MotionEvent.ACTION_UP) {
                        RectF sr = stopRect();
                        if (sr.contains(e.getX(), e.getY())) handleStopTap();
                    }
                    return true;
                }
            });
        }

        /** 停止按钮的绘制矩形；命中判断也用同一份，避免画面和热区错位。 */
        RectF stopRect() {
            float w = getWidth();
            float h = getHeight();
            float stopW = dp(30);
            float stopRight = w - dp(8);
            return new RectF(stopRight - stopW, h / 2f - dp(15), stopRight, h / 2f + dp(15));
        }

        void kick() {
            postOnAnimation(ticker);
        }

        private final Runnable ticker = new Runnable() {
            @Override public void run() {
                boolean more = false;
                if (anim != animTarget) {
                    float d = animTarget - anim;
                    float stepv = Math.max(0.06f, 0.22f);
                    anim += Math.abs(d) <= stepv ? d : (d > 0 ? stepv : -stepv);
                    setAlpha(Math.max(0f, Math.min(1f, anim)));
                    more = true;
                }
                if (anim <= 0.001f && animTarget <= 0f) {
                    detach();
                    return;
                }
                // 忙的时候要跑呼吸/涟漪/流光，空转时只画静态帧。
                if (busy || SystemClock.uptimeMillis() - rippleAt < 700L) more = true;
                invalidate();
                if (more) postOnAnimation(this);
            }
        };

        @Override protected void onDraw(Canvas cv) {
            long now = SystemClock.uptimeMillis();
            float w = getWidth();
            float h = getHeight();
            if (w <= 0 || h <= 0) return;

            float radius = h / 2f;
            r.set(0, 0, w, h);

            // 1) 软投影：三层由内到外递减的描边，代替 blur（硬件层上 blur 太贵）。
            p.setStyle(Paint.Style.STROKE);
            for (int i = 3; i >= 1; i--) {
                float g = dp(1.6f) * i;
                p.setStrokeWidth(dp(1.4f));
                p.setShader(null);
                p.setColor(Color.argb((int) (10 - i * 2), 0, 0, 0));
                r.inset(-g, -g);
                cv.drawRoundRect(r, radius + g, radius + g, p);
                r.set(0, 0, w, h);
            }

            // 2) 底：竖向微渐变，上略亮下略沉，像一块玻璃而不是纯色块。
            p.setStyle(Paint.Style.FILL);
            p.setShader(new LinearGradient(0, 0, 0, h,
                    new int[]{0xF21B202B, 0xF211151C}, null, Shader.TileMode.CLAMP));
            cv.drawRoundRect(r, radius, radius, p);
            p.setShader(null);

            // 3) 发丝描边：上缘亮、下缘几乎消失，制造薄薄的边缘高光。
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(dp(1f));
            p.setShader(new LinearGradient(0, 0, 0, h,
                    new int[]{0x33FFFFFF, 0x0DFFFFFF}, null, Shader.TileMode.CLAMP));
            RectF b = new RectF(r);
            b.inset(dp(0.5f), dp(0.5f));
            cv.drawRoundRect(b, radius, radius, p);
            p.setShader(null);
            p.setStyle(Paint.Style.FILL);

            // 4) 忙碌时的流光：沿底缘走的一小段高光，表示「正在动」。
            if (busy) {
                clip.reset();
                clip.addRoundRect(r, radius, radius, Path.Direction.CW);
                cv.save();
                cv.clipPath(clip);
                float band = w * 0.42f;
                float t = (now % 1500L) / 1500f;
                float x = -band + (w + band) * t;
                p.setShader(new LinearGradient(x, 0, x + band, 0,
                        new int[]{0x007CC4FF, 0x557CC4FF, 0x007CC4FF}, null, Shader.TileMode.CLAMP));
                cv.drawRect(0, h - dp(1.6f), w, h, p);
                p.setShader(null);
                cv.restore();
            }

            // 5) 左侧状态点：忙碌时呼吸，停止时琥珀色。
            float cx = dp(19);
            float cy = h / 2f;
            float baseR = dp(3.4f);
            float pulse = 0f;
            if (busy) {
                float ph = (now % 1200L) / 1200f;
                pulse = ph;
            }
            if (pulse > 0f) {
                p.setColor(Color.argb((int) (70 * (1 - pulse)), Color.red(C_ACCENT),
                        Color.green(C_ACCENT), Color.blue(C_ACCENT)));
                cv.drawCircle(cx, cy, baseR + dp(7) * pulse, p);
            }
            // 每来一步：从点位置散开一圈涟漪，收尾就没了。
            long sinceRipple = now - rippleAt;
            if (sinceRipple < 620L) {
                float t = sinceRipple / 620f;
                p.setStyle(Paint.Style.STROKE);
                p.setStrokeWidth(dp(1.2f));
                p.setColor(Color.argb((int) (110 * (1 - t)), Color.red(C_ACCENT),
                        Color.green(C_ACCENT), Color.blue(C_ACCENT)));
                cv.drawCircle(cx, cy, baseR + dp(16) * t, p);
                p.setStyle(Paint.Style.FILL);
            }
            p.setColor(stopped ? C_WARN : C_ACCENT);
            cv.drawCircle(cx, cy, baseR, p);

            // 6) 文案
            float textLeft = dp(32);
            RectF sb = stopRect();
            float stepW = stepText.isEmpty() ? 0f : dp(16);
            float textRight = sb.left - dp(6) - stepW;
            p.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
            p.setTextSize(dp(12.6f));
            p.setColor(stopped ? C_WARN : C_TEXT);
            tp.set(p);
            CharSequence el = TextUtils.ellipsize(label == null ? "" : label,
                    tp, Math.max(0f, textRight - textLeft), TextUtils.TruncateAt.END);
            // 竖直居中：用字体度量算基线，避免不同字号下沉。
            Paint.FontMetrics fm = p.getFontMetrics();
            float baseline = cy - (fm.ascent + fm.descent) / 2f;
            cv.drawText(el.toString(), textLeft, baseline, p);

            // 7) 步数：小、暗、靠右，不抢主文案。
            if (!stepText.isEmpty()) {
                p.setTextSize(dp(10.5f));
                p.setColor(C_DIM);
                p.setTextAlign(Paint.Align.RIGHT);
                cv.drawText(stepText, sb.left - dp(7), baseline, p);
                p.setTextAlign(Paint.Align.LEFT);
            }

            // 8) 停止按钮：圆角方块 + 里面的小方块图标。
            p.setColor(0x14FFFFFF);
            cv.drawRoundRect(sb, dp(9), dp(9), p);
            p.setColor(0x3DFFFFFF);
            p.setStyle(Paint.Style.STROKE);
            p.setStrokeWidth(dp(1f));
            cv.drawRoundRect(sb, dp(9), dp(9), p);
            p.setStyle(Paint.Style.FILL);
            float icon = dp(9);
            p.setColor(0xFFE9EEF6);
            cv.drawRoundRect(new RectF(sb.centerX() - icon / 2f, sb.centerY() - icon / 2f,
                    sb.centerX() + icon / 2f, sb.centerY() + icon / 2f), dp(2), dp(2), p);
        }
    }

    /** 停止按钮的命中测试与回调：View 自己拿到触摸事件后按矩形判断。 */
    private void handleStopTap() {
        stopUntil = SystemClock.uptimeMillis() + STOP_COOLDOWN_MS;
        postStoppedState();
        Log.i(TAG, "user requested stop");
    }
}
