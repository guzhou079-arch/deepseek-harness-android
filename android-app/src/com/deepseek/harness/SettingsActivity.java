package com.deepseek.harness;

import android.app.Activity;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CompoundButton;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 原生设置页（外观 / 引擎 / 关于）。
 *
 * 为什么这一页不用网页实现：设置页的排版问题（组间距、描边粗细、圆角档位）在网页里
 * 受制于 dist 的 CSS 与内核哈希类名，改一次要跟第三方样式特异性打架。原生 View 的
 * 尺寸单位是 dp、背景由自己画，一套标度从头到尾一致，不会再出现「同一张卡三种描边」
 * 这种观感断裂。
 *
 * 配置落点仍是 payload/dshhome/appearance.json：网页侧插件读它、映射成 CSS 变量。
 * 这样「在哪里改」和「怎么生效」是两条独立的线，任何一边换实现都不牵连另一边。
 */
public class SettingsActivity extends Activity {

    // ==================== 标度（全部 dp，唯一真值）====================
    /** 可点行最小高度。48dp 是无障碍可聚焦下限，这里留一档余量。 */
    private static final int ROW_MIN_H = 52;
    /** 卡片左右内边距；分隔线缩进到同一位置，视觉上对齐文字左沿。 */
    private static final int ROW_PAD_X = 16;
    /** 页面左右留白。 */
    private static final int PAGE_PAD_X = 12;
    /** 卡片圆角基准；档位切换时按 sm/md/lg 缩放。 */
    private static final int RADIUS_MD = 20;

    // 深色：与内核深色主题同族（中性灰，不带蓝）。跳进/跳出这一页时不能有色相跳变。
    private static final int D_BG = 0xFF151517;
    private static final int D_CARD = 0xFF232324;
    private static final int D_TEXT = 0xFFE6EDF3;
    private static final int D_DIM = 0xFF8B98A9;
    private static final int D_LINE = 0x1FFFFFFF;
    // 浅色：同一套结构，只换明度。
    private static final int L_BG = 0xFFF5F6F8;
    private static final int L_CARD = 0xFFFFFFFF;
    private static final int L_TEXT = 0xFF1F2328;
    private static final int L_DIM = 0xFF6B7280;
    private static final int L_LINE = 0x14000000;

    private static final int ACCENT = 0xFF4D6BFE;

    /** 主题色档位：名字 → 色值。写进 appearance.json 的 themeColor。 */
    private static final String[] THEME_KEYS = {"blue", "purple", "cyan", "amber", "green"};
    private static final int[] THEME_COLORS = {
            0xFF4D6BFE, 0xFF8B5CF6, 0xFF22D3EE, 0xFFF59E0B, 0xFF10B981
    };
    private static final String[] THEME_NAMES = {"蓝", "紫", "青", "琥珀", "绿"};

    private boolean dark;
    private int BG, CARD, TEXT, DIM, LINE;

    private final Handler ui = new Handler(Looper.getMainLooper());

    /** 内存里的外观配置；每次改动都整体回写，避免局部写坏 JSON。 */
    private JSONObject appearance;
    /** 本次会话是否真的改过东西 —— 决定返回时要不要通知主界面重载。 */
    private boolean dirty;

    // ==================== 生命周期 ====================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        if (dark) { BG = D_BG; CARD = D_CARD; TEXT = D_TEXT; DIM = D_DIM; LINE = D_LINE; }
        else      { BG = L_BG; CARD = L_CARD; TEXT = L_TEXT; DIM = L_DIM; LINE = L_LINE; }

        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(BG));
        applySystemBarColors();

        appearance = readAppearance();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setFitsSystemWindows(true);

        root.addView(buildTopBar(),
                new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52)));

        ScrollView scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setFillViewport(true);

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(PAGE_PAD_X), dp(2), dp(PAGE_PAD_X), dp(28));
        scroll.addView(content, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        buildAppearanceSection(content);
        buildEngineSection(content);
        buildAboutSection(content);

        root.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    @Override
    public void onBackPressed() {
        backOut();
    }

    /** Activity.finish() 是 final，改不了；退出动作统一走这里，保证带结果回去。 */
    private void backOut() {
        if (dirty) setResult(RESULT_OK);
        finish();
    }

    /** 状态栏/导航栏跟着这一页的底色，否则会露出系统默认黑条。 */
    private void applySystemBarColors() {
        try {
            android.view.Window w = getWindow();
            w.setStatusBarColor(BG);
            w.setNavigationBarColor(BG);
            if (android.os.Build.VERSION.SDK_INT >= 23) {
                int flags = w.getDecorView().getSystemUiVisibility();
                if (!dark) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                w.getDecorView().setSystemUiVisibility(flags);
            }
        } catch (Throwable ignored) {}
    }

    // ==================== 骨架 ====================

    private View buildTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(BG);
        bar.setPadding(dp(6), 0, dp(16), 0);

        // 箭头直接画：R.java 是出包时 aapt 生成的产物，为一个图标去动资源 ID 链
        // 不划算，而这条折线本来就只是两笔。
        View back = new View(this) {
            private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
            @Override protected void onDraw(Canvas canvas) {
                p.setColor(TEXT);
                p.setStrokeWidth(Math.max(2, dp(2)));
                p.setStyle(Paint.Style.STROKE);
                p.setStrokeCap(Paint.Cap.ROUND);
                p.setStrokeJoin(Paint.Join.ROUND);
                float cx = getWidth() / 2f, cy = getHeight() / 2f, s = dp(8);
                Path path = new Path();
                path.moveTo(cx + s * 0.55f, cy - s);
                path.lineTo(cx - s * 0.55f, cy);
                path.lineTo(cx + s * 0.55f, cy + s);
                canvas.drawPath(path, p);
            }
        };
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { backOut(); }
        });
        bar.addView(back, new LinearLayout.LayoutParams(dp(44), dp(44)));

        TextView title = new TextView(this);
        title.setText("设置");
        title.setTextSize(18);
        title.setTextColor(TEXT);
        title.setPadding(dp(6), 0, 0, 0);
        bar.addView(title, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        return bar;
    }

    /** 组名。上边距 18 + 自身高度 ≈ 组间 24–34 的视觉区间。 */
    private void section(LinearLayout parent, String title) {
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextSize(13);
        t.setTextColor(DIM);
        t.setPadding(dp(6), dp(18), dp(6), dp(6));
        parent.addView(t);
    }

    /** 一张卡：组内行贴紧、圆角统一、超界裁掉（子 View 溢出圆角时会露直角）。 */
    private LinearLayout group(LinearLayout parent) {
        LinearLayout g = new LinearLayout(this);
        g.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = roundRect(CARD, RADIUS_MD, 1, LINE);
        g.setBackground(bg);
        g.setClipToOutline(true);
        parent.addView(g, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        addSpacer(parent, 0); // 占位保持调用点对齐（组间间距由下一组的 section 提供）
        return g;
    }

    private void addSpacer(LinearLayout parent, int h) {
        if (h <= 0) return;
        View v = new View(this);
        parent.addView(v, new LinearLayout.LayoutParams(1, dp(h)));
    }

    private GradientDrawable roundRect(int fill, int radiusDp, int strokeDp, int strokeColor) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) d.setStroke(Math.max(1, dp(strokeDp)), strokeColor);
        return d;
    }

    /** 行容器：左文右值/右控件。高度取内容与下限的较大者。 */
    private LinearLayout rowBase() {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setMinimumHeight(dp(ROW_MIN_H));
        r.setPadding(dp(ROW_PAD_X), dp(11), dp(ROW_PAD_X), dp(11));
        return r;
    }

    /**
     * 行间分隔线：用 1px 的 View 而不是 border-bottom —— border 永远贴盒边，
     * 缩进不进去；而视觉上分隔线要停在内边距处才跟文字左沿对齐。
     */
    private void divider(LinearLayout group) {
        View line = new View(this);
        line.setBackgroundColor(LINE);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(0.5f)));
        lp.leftMargin = dp(ROW_PAD_X);
        group.addView(line, lp);
    }

    private LinearLayout textBlock(String title, String sub) {
        LinearLayout c = new LinearLayout(this);
        c.setOrientation(LinearLayout.VERTICAL);
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextSize(16);
        t.setTextColor(TEXT);
        c.addView(t, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        if (sub != null && sub.length() > 0) {
            TextView s = new TextView(this);
            s.setText(sub);
            s.setTextSize(13);
            s.setTextColor(DIM);
            s.setPadding(0, dp(3), 0, 0);
            c.addView(s, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }
        return c;
    }

    private TextView valueText(String v) {
        TextView tv = new TextView(this);
        tv.setText(v == null ? "" : v);
        tv.setTextSize(13);
        tv.setTextColor(DIM);
        tv.setPadding(dp(10), 0, 0, 0);
        return tv;
    }

    /** 可点行：右侧带一句当前值/说明。 */
    private void tapRow(LinearLayout group, String title, String sub, String value,
                        View.OnClickListener onClick) {
        if (group.getChildCount() > 0) divider(group);
        LinearLayout r = rowBase();
        r.addView(textBlock(title, sub), new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        if (value != null && value.length() > 0) r.addView(valueText(value));
        if (onClick != null) r.setOnClickListener(onClick);
        group.addView(r, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    /** 开关行。 */
    private void switchRow(LinearLayout group, String title, String sub,
                           boolean checked, CompoundButton.OnCheckedChangeListener onChange) {
        if (group.getChildCount() > 0) divider(group);
        LinearLayout r = rowBase();
        r.addView(textBlock(title, sub), new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Switch sw = new Switch(this);
        sw.setChecked(checked);
        sw.setPadding(0, 0, 0, 0);
        try {
            int[][] states = new int[][]{{android.R.attr.state_checked}, {-android.R.attr.state_checked}};
            sw.setThumbTintList(new android.content.res.ColorStateList(
                    states, new int[]{ACCENT, dark ? 0xFF6B7280 : 0xFF9CA3AF}));
            sw.setTrackTintList(new android.content.res.ColorStateList(
                    states, new int[]{0x804D6BFE, dark ? 0xFF353638 : 0xFFD9DDE3}));
        } catch (Throwable ignored) {}
        sw.setOnCheckedChangeListener(onChange);
        r.addView(sw, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        group.addView(r, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    /**
     * 分段选择行：3–5 档的文字按钮，选中档反色。
     * 用文字而不是 SeekBar —— 档位是离散语义（紧凑/标准/宽松），拖动的连续值会让人以为可以微调。
     */
    private void segRow(LinearLayout group, String title, String sub,
                        String[] options, final int selected, final OnSegPick pick) {
        if (group.getChildCount() > 0) divider(group);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(ROW_PAD_X), dp(12), dp(ROW_PAD_X), dp(12));
        col.addView(textBlock(title, sub), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final LinearLayout seg = new LinearLayout(this);
        seg.setOrientation(LinearLayout.HORIZONTAL);
        seg.setPadding(0, dp(10), 0, 0);
        for (int i = 0; i < options.length; i++) {
            final int idx = i;
            TextView chip = new TextView(this);
            chip.setText(options[i]);
            chip.setTextSize(13);
            chip.setGravity(Gravity.CENTER);
            chip.setPadding(dp(14), dp(8), dp(14), dp(8));
            paintChip(chip, i == selected);
            chip.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    pick.onPick(idx);
                    for (int k = 0; k < seg.getChildCount(); k++) {
                        View child = seg.getChildAt(k);
                        if (child instanceof TextView) paintChip((TextView) child, k == idx);
                    }
                }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
            if (i > 0) lp.leftMargin = dp(8);
            seg.addView(chip, lp);
        }
        col.addView(seg, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        group.addView(col, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    private void paintChip(TextView chip, boolean on) {
        if (on) {
            chip.setTextColor(0xFFFFFFFF);
            chip.setBackground(roundRect(ACCENT, 10, 0, 0));
        } else {
            chip.setTextColor(TEXT);
            chip.setBackground(roundRect(dark ? 0xFF2C2C2E : 0xFFEDEFF2, 10, 0, 0));
        }
    }

    private interface OnSegPick { void onPick(int index); }

    // ==================== 外观 ====================

    private void buildAppearanceSection(LinearLayout content) {
        section(content, "外观");
        LinearLayout g = group(content);

        // 主题色：一排色点。选中态用一圈描边，而不是再变大 —— 尺寸变化会让整行跳动。
        if (g.getChildCount() > 0) divider(g);
        LinearLayout colorCol = new LinearLayout(this);
        colorCol.setOrientation(LinearLayout.VERTICAL);
        colorCol.setPadding(dp(ROW_PAD_X), dp(12), dp(ROW_PAD_X), dp(14));
        colorCol.addView(textBlock("主题色", "强调色跟随这条线"), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final LinearLayout dots = new LinearLayout(this);
        dots.setOrientation(LinearLayout.HORIZONTAL);
        dots.setPadding(0, dp(12), 0, 0);
        final String[] cur = {appearance.optString("themeColor", "blue")};
        for (int i = 0; i < THEME_KEYS.length; i++) {
            final String key = THEME_KEYS[i];
            final int color = THEME_COLORS[i];
            final TextView dot = new TextView(this);
            dot.setText("");
            dot.setBackground(colorDot(color, key.equals(cur[0])));
            dot.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    cur[0] = key;
                    for (int k = 0; k < dots.getChildCount(); k++) {
                        View c = dots.getChildAt(k);
                        // 子序号与 THEME_KEYS 一一对应
                        c.setBackground(colorDot(THEME_COLORS[k], THEME_KEYS[k].equals(cur[0])));
                    }
                    writeAppearance();
                }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(34), dp(34));
            if (i > 0) lp.leftMargin = dp(12);
            dots.addView(dot, lp);
        }
        colorCol.addView(dots, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        g.addView(colorCol, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final String[] radiusOpts = {"小", "中", "大"};
        final String[] radiusKeys = {"sm", "md", "lg"};
        segRow(g, "圆角", "卡片与输入框的统一档位", radiusOpts,
                indexOf(radiusKeys, appearance.optString("radius", "md")),
                new OnSegPick() {
                    @Override public void onPick(int i) {
                        put("radius", radiusKeys[i]);
                        writeAppearance();
                    }
                });

        final String[] densityOpts = {"紧凑", "标准", "宽松"};
        final String[] densityKeys = {"compact", "normal", "roomy"};
        segRow(g, "密度", "列表行间距与留白", densityOpts,
                indexOf(densityKeys, appearance.optString("density", "normal")),
                new OnSegPick() {
                    @Override public void onPick(int i) {
                        put("density", densityKeys[i]);
                        writeAppearance();
                    }
                });

        JSONObject bg = appearance.optJSONObject("background");
        boolean bgOn = bg != null && "image".equals(bg.optString("mode", "none"));
        switchRow(g, "背景图", "关闭则使用纯色底", bgOn,
                new CompoundButton.OnCheckedChangeListener() {
                    @Override public void onCheckedChanged(CompoundButton b, boolean checked) {
                        setBgMode(checked ? "image" : "none");
                        writeAppearance();
                    }
                });
    }

    private GradientDrawable colorDot(int color, boolean selected) {
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(color);
        if (selected) d.setStroke(Math.max(2, dp(2.5f)), dark ? 0xFFFFFFFF : 0xFF151517);
        else d.setStroke(0, 0);
        return d;
    }

    // ==================== 引擎 ====================

    private void buildEngineSection(LinearLayout content) {
        section(content, "引擎");
        LinearLayout g = group(content);

        final int port = defaultEnginePort();
        final TextView stateValue = valueText("检测中…");
        if (g.getChildCount() > 0) divider(g);
        LinearLayout r = rowBase();
        r.addView(textBlock("运行状态", "127.0.0.1:" + port), new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        r.addView(stateValue);
        g.addView(r, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        tapRow(g, "重新检测", null, null, new View.OnClickListener() {
            @Override public void onClick(View v) {
                probeEngine(port, stateValue);
            }
        });
        tapRow(g, "引擎数据目录", "会话与凭证不在这里清", null, null);
        probeEngine(port, stateValue);
    }

    /** 探一下首页是否应答。只判断「有没有人听」，不解析内容 —— 版本/健康语义归网页控制台。 */
    private void probeEngine(final int port, final TextView out) {
        out.setText("检测中…");
        new Thread(new Runnable() {
            @Override public void run() {
                String result;
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/").openConnection();
                    c.setConnectTimeout(1200);
                    c.setReadTimeout(1200);
                    c.setRequestMethod("GET");
                    c.setInstanceFollowRedirects(false);
                    int code = c.getResponseCode();
                    // 401 也说明引擎在听：只是这一跳没带令牌。
                    result = (code >= 200 && code < 500) ? "运行中" : ("异常 " + code);
                } catch (Throwable e) {
                    result = "未运行";
                } finally {
                    try { if (c != null) c.disconnect(); } catch (Throwable ignored) {}
                }
                final String label = result;
                ui.post(new Runnable() {
                    @Override public void run() { out.setText(label); }
                });
            }
        }).start();
    }

    private int defaultEnginePort() {
        String p = getPackageName();
        if (p.contains("beta")) return 3082;
        if (p.contains("compat")) return 3084;
        return 3080;
    }

    // ==================== 关于 ====================

    private void buildAboutSection(LinearLayout content) {
        section(content, "关于");
        LinearLayout g = group(content);
        tapRow(g, "App 版本", null, appVersion(), null);
        tapRow(g, "内核 revision", null, kernelRevision(), null);
    }

    private String appVersion() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName + " (" + pi.versionCode + ")";
        } catch (Throwable e) {
            return "—";
        }
    }

    private String kernelRevision() {
        File f = new File(new File(getFilesDir(), "payload/dshroot"), "REVISION");
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            byte[] b = new byte[(int) Math.min(f.length(), 128)];
            int n = in.read(b);
            if (n <= 0) return "—";
            return new String(b, 0, n, "UTF-8").trim();
        } catch (Throwable e) {
            return "—";
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) {}
        }
    }

    // ==================== 配置读写 ====================

    private File appearanceFile() {
        return new File(new File(getFilesDir(), "payload/dshhome"), "appearance.json");
    }

    private JSONObject readAppearance() {
        File f = appearanceFile();
        if (f.exists()) {
            FileInputStream in = null;
            try {
                in = new FileInputStream(f);
                byte[] b = new byte[(int) f.length()];
                int n = in.read(b);
                return new JSONObject(new String(b, 0, Math.max(0, n), "UTF-8"));
            } catch (Throwable ignored) {
                // 坏文件不该让设置页打不开：落到默认值，下次写入时自然修好。
            } finally {
                try { if (in != null) in.close(); } catch (Throwable ignored) {}
            }
        }
        try {
            JSONObject o = new JSONObject();
            o.put("themeColor", "blue");
            o.put("radius", "md");
            o.put("density", "normal");
            JSONObject bg = new JSONObject();
            bg.put("mode", "none");
            bg.put("image", JSONObject.NULL);
            bg.put("scrim", 0.55);
            bg.put("motion", false);
            o.put("background", bg);
            return o;
        } catch (Throwable e) {
            return new JSONObject();
        }
    }

    private void put(String key, String value) {
        try { appearance.put(key, value); } catch (Throwable ignored) {}
    }

    private void setBgMode(String mode) {
        try {
            JSONObject bg = appearance.optJSONObject("background");
            if (bg == null) {
                bg = new JSONObject();
                appearance.put("background", bg);
            }
            bg.put("mode", mode);
        } catch (Throwable ignored) {}
    }

    private void writeAppearance() {
        File f = appearanceFile();
        File dir = f.getParentFile();
        if (dir != null && !dir.exists()) dir.mkdirs();
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(f);
            out.write(appearance.toString(2).getBytes("UTF-8"));
            dirty = true;
        } catch (Throwable ignored) {
        } finally {
            try { if (out != null) out.close(); } catch (Throwable ignored) {}
        }
    }

    private int indexOf(String[] keys, String v) {
        for (int i = 0; i < keys.length; i++) if (keys[i].equals(v)) return i;
        return 1; // 未知值落到中档，不显示成「什么都没选中」
    }

    // ==================== 工具 ====================

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
