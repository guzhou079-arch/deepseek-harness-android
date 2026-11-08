package com.deepseek.harness;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * 内核包管理（v1.49 P0）：安装 / 切换 / 回退。
 *
 * 形态：一棵 dshroot 树打成一个 tar.gz（{@code make-kernel-bundle.sh} 产物），
 * 放在 /sdcard/DeepSeekHarness/kernels/ 投放；解压必须落 App 私有 ext4，
 * 切完改 active.json，重启引擎即生效。
 *
 * 边界：
 *  · 只动 files/kernels/**，不碰 payload/dshroot（内置树永远是兜底）。
 *  · 解压后的树永不参与 FORCE_OVERWRITE_PREFIXES 覆盖 —— 否则下次冷启就被
 *    内置树盖回 rc5，切了等于白切（这是本方案最容易翻车的点）。
 *  · 校验靠 manifest.sha256 + .kernel-ok 标记；启动时只信标记，不重算 46MB 哈希。
 */
public final class KernelStore {

    private static final String TAG = "dsh-kernel";

    /** 投放目录：下载/手工放入的包都在这（/sdcard，重装 App 不丢）。 */
    public static final String STORE = "/sdcard/DeepSeekHarness/kernels";
    /** 内核树入口（相对树根）。 */
    public static final String ENTRY = "lib/node_modules/@deepseek-ai/dsh/lib/bin.js";
    public static final String KPKG = "lib/node_modules/@deepseek-ai/dsh/package.json";

    private static final Object LOCK = new Object();

    public interface Cb {
        /** stage 给阶段文案；pct 0..100，-1 = 不定进度。 */
        void onStage(String stage, int pct);
        void onDone(boolean ok, String msg);
    }

    /** 一个可安装的内核包（store 里的 tar.gz + manifest.json）。 */
    public static final class Bundle {
        public String version = "";
        public String label = "";
        public File tar = null;
        public File manifest = null;
        public long sizeBytes = 0;
        public boolean installed = false;
        public boolean active = false;
        public String note = "";
        public String display() {
            String v = version.length() > 0 ? version : "未知版本";
            if (label.length() > 0 && !"v1".equals(label)) v += " (" + label + ")";
            if (sizeBytes > 0) v += " · " + (sizeBytes / 1048576) + "MB";
            return v;
        }
    }

    // ---------------------------------------------------------------- 路径

    public static File kernelsDir(Context c) {
        File f = new File(c.getFilesDir(), "kernels");
        if (!f.isDirectory()) f.mkdirs();
        return f;
    }

    public static File activeFile(Context c) {
        return new File(kernelsDir(c), "active.json");
    }

    private static boolean validVersion(String ver) {
        if (ver == null || ver.length() == 0 || ver.length() > 128 || ".".equals(ver) || "..".equals(ver)) return false;
        for (int i = 0; i < ver.length(); i++) {
            char ch = ver.charAt(i);
            if (Character.isLetterOrDigit(ch) || ch == '.' || ch == '-' || ch == '_' || ch == '+') continue;
            return false;
        }
        return true;
    }

    public static File versionDir(Context c, String ver) {
        if (!validVersion(ver)) throw new IllegalArgumentException("unsafe kernel version");
        return new File(kernelsDir(c), ver);
    }

    public static File treeDir(Context c, String ver) {
        return new File(versionDir(c, ver), "dshroot");
    }

    private static File markerFile(Context c, String ver) {
        return new File(versionDir(c, ver), ".kernel-ok");
    }

    // ---------------------------------------------------------------- revision 体检

    /** 内置树的 revision（assets/dshroot_revision.txt，每次出包都会变）；读不到返回空串。 */
    public static String builtinRevision(Context c) {
        InputStream in = null;
        try {
            in = c.getAssets().open("dshroot_revision.txt");
            byte[] buf = new byte[64];
            int n = in.read(buf);
            return n <= 0 ? "" : new String(buf, 0, n, "UTF-8").trim();
        } catch (Throwable t) {
            return "";
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignored) {}
        }
    }

    /** 内核树自己的 revision（&lt;tree&gt;/REVISION）；读不到返回空串。 */
    private static String treeRevision(File tree) {
        try {
            File f = new File(tree, "REVISION");
            return f.isFile() ? readText(f).trim() : "";
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 指针是不是「比内置树旧」。
     *
     * REVISION 是出包时间戳（yyyyMMddHHmmss），等长时字典序即时间序，长度不同也能判出谁旧。
     * 任一方读不到就让判旧不成立 —— 读不到文件不能成为顶掉别人内核的理由。
     */
    private static boolean isOlder(String activeRev, String builtinRev) {
        if (activeRev == null || builtinRev == null) return false;
        if (activeRev.length() == 0 || builtinRev.length() == 0) return false;
        return activeRev.compareTo(builtinRev) < 0;
    }

    // ---------------------------------------------------------------- active 指针

    /** 当前激活版本；没激活（= 用内置树）返回 null。 */
    public static String activeVersion(Context c) {
        try {
            File f = activeFile(c);
            if (!f.isFile()) return null;
            JSONObject o = new JSONObject(readText(f));
            String v = o.optString("version", "");
            if (!validVersion(v)) {
                Log.w(TAG, "active kernel has unsafe version");
                return null;
            }
            return v;
        } catch (Throwable t) {
            Log.w(TAG, "read active failed", t);
            return null;
        }
    }

    /**
     * 激活时**逐项复核**（不重算哈希，只查标记与入口）：
     * 目录在、.kernel-ok 在、bin.js 在、版本与标记一致。
     * 任何一项不满足都当「未激活」，引擎回落内置树 —— 宁可慢一步，不能起不来。
     */
    public static File activeTree(Context c) {
        String ver = activeVersion(c);
        if (ver == null) return null;
        try {
            File tree = treeDir(c, ver);
            if (!new File(tree, ENTRY).isFile()) {
                Log.w(TAG, "active kernel " + ver + " 缺入口，回落内置树");
                return null;
            }
            if (!markerFile(c, ver).isFile()) {
                Log.w(TAG, "active kernel " + ver + " 缺 .kernel-ok 标记，回落内置树");
                return null;
            }
            // 指针指向的内核比内置树旧 → 当未激活。目录与指针都留着，装包时 parkIfStale 负责挪走
            // 指针，这里兜住「没走装包这条路」的情况（改外部模式、手工改 active.json 等）。
            String activeRev = treeRevision(tree);
            String builtinRev = builtinRevision(c);
            if (isOlder(activeRev, builtinRev)) {
                Log.w(TAG, "active kernel " + ver + " (" + activeRev + ") 比内置树 (" + builtinRev + ") 旧，回落内置树");
                return null;
            }
            return tree;
        } catch (Throwable t) {
            Log.w(TAG, "resolve active failed", t);
            return null;
        }
    }

    /** 切到某个已安装内核；失败返回原因。 */
    public static String activate(Context c, String ver) {
        if (!validVersion(ver)) return "内核版本号不合法";
        synchronized (LOCK) {
            if (!new File(treeDir(c, ver), ENTRY).isFile()) return "这个内核没装完整（缺入口文件）";
            if (!markerFile(c, ver).isFile()) return "这个内核没装完整（缺 .kernel-ok 标记）";
            try {
                JSONObject o = new JSONObject();
                o.put("version", ver);
                o.put("activatedAt", System.currentTimeMillis());
                writeText(activeFile(c), o.toString());
                return null;
            } catch (Throwable t) {
                return "写激活指针失败：" + t;
            }
        }
    }

    /** 回退到内置树。 */
    public static void deactivate(Context c) {
        synchronized (LOCK) {
            try {
                File f = activeFile(c);
                if (f.exists()) f.delete();
            } catch (Throwable t) {
                Log.w(TAG, "deactivate failed", t);
            }
        }
    }

    /**
     * 升级后指针体检：active.json 指向的内核比内置树旧，就把指针改名挪开（不删，可回滚）。
     *
     * 为什么必须在装包这条路上做：热切过内核的机器升级 App 只换内置树，active.json 照样把引擎
     * 指回旧内核，前端于是永远停在旧版本，新包怎么发都到不了这台机器。改名保留原指针，
     * 真要回旧内核时把 active.json.stale-* 改回 active.json 即可。只判「更旧」，
     * 比内置树新的内核（例如自己装的更新版）不受影响。
     *
     * @return 挪走后的文件名；没有挪动返回 null。
     */
    public static String parkIfStale(Context c) {
        synchronized (LOCK) {
            try {
                File f = activeFile(c);
                if (!f.isFile()) return null;
                String ver = activeVersion(c);
                if (ver == null) return null;
                String activeRev = treeRevision(treeDir(c, ver));
                String builtinRev = builtinRevision(c);
                if (!isOlder(activeRev, builtinRev)) return null;
                File stale = new File(f.getParentFile(), "active.json.stale-" + builtinRev);
                if (stale.exists()) stale.delete();
                if (!f.renameTo(stale)) {
                    Log.w(TAG, "旧内核指针挪不开，保留原样：" + f);
                    return null;
                }
                Log.w(TAG, "active kernel " + ver + " (" + activeRev + ") 比内置树 (" + builtinRev
                        + ") 旧，指针已挪到 " + stale.getName() + "，本次改用内置树");
                return stale.getName();
            } catch (Throwable t) {
                Log.w(TAG, "park stale pointer failed", t);
                return null;
            }
        }
    }

    // ---------------------------------------------------------------- 已装列表

    /** 已装内核（files/kernels/<ver>/dshroot）。 */
    public static List<Bundle> installed(Context c) {
        List<Bundle> out = new ArrayList<Bundle>();
        File base = kernelsDir(c);
        File[] kids = base.listFiles();
        if (kids == null) return out;
        String active = activeVersion(c);
        for (File d : kids) {
            if (!d.isDirectory() || d.getName().startsWith(".") || !validVersion(d.getName())) continue;
            if (!new File(d, "dshroot/" + ENTRY).isFile()) continue;
            Bundle b = new Bundle();
            b.version = d.getName();
            b.installed = true;
            b.active = b.version.equals(active);
            File mf = new File(d, "manifest.json");
            if (mf.isFile()) {
                try {
                    JSONObject o = new JSONObject(readText(mf));
                    b.label = o.optString("label", "");
                    b.sizeBytes = o.optLong("sizeBytes", 0);
                } catch (Throwable ignored) {}
            }
            if (!b.active && !markerFile(c, b.version).isFile()) b.note = "不完整";
            out.add(b);
        }
        sort(out);
        return out;
    }

    // ---------------------------------------------------------------- 投放目录扫描

    /** store 里能装的包（*.tar.gz），安装状态按版本对齐。 */
    public static List<Bundle> scanStore(Context c) {
        List<Bundle> out = new ArrayList<Bundle>();
        File store = new File(STORE);
        if (!store.isDirectory()) return out;
        File[] root = store.listFiles();
        if (root == null) return out;
        // 两种布局都认：包直接放 kernels/（早期单包），或放 kernels/<包名>/ 子目录（多内核共存）。
        // 每个目录只认自己那份 manifest.json，所以两个内核必须各占一个子目录。
        List<File> tars = new ArrayList<File>();
        for (File f : root) {
            if (f.isFile()) {
                if (f.getName().endsWith(".tar.gz")) tars.add(f);
                continue;
            }
            if (!f.isDirectory()) continue;
            File[] inner = f.listFiles();
            if (inner == null) continue;
            for (File g : inner) if (g.isFile() && g.getName().endsWith(".tar.gz")) tars.add(g);
        }
        List<Bundle> installed = installed(c);
        for (File f : tars) {
            Bundle b = new Bundle();
            b.tar = f;
            b.sizeBytes = f.length();
            // manifest.json 与包同目录（make-kernel-bundle.sh 的输出布局）
            File mf = new File(f.getParentFile(), "manifest.json");
            if (mf.isFile()) {
                b.manifest = mf;
                try {
                    JSONObject o = new JSONObject(readText(mf));
                    b.version = o.optString("version", "");
                    b.label = o.optString("label", "");
                    String file = o.optString("file", "");
                    // 同目录可能有多份包共用一个 manifest（不同 label），以 manifest 里的 file 为准
                    if (file.length() > 0 && !file.equals(f.getName())) {
                        Log.i(TAG, "skip " + f.getName() + "（manifest 指向 " + file + "）");
                        continue;
                    }
                    b.sizeBytes = o.optLong("sizeBytes", b.sizeBytes);
                } catch (Throwable t) {
                    b.note = "manifest 解析失败";
                }
            } else {
                b.note = "缺 manifest.json";
            }
            for (Bundle i : installed) {
                if (!i.version.isEmpty() && i.version.equals(b.version)) { b.installed = true; b.active = i.active; break; }
            }
            out.add(b);
        }
        sort(out);
        return out;
    }

    private static void sort(List<Bundle> list) {
        java.util.Collections.sort(list, new Comparator<Bundle>() {
            @Override public int compare(Bundle a, Bundle b) {
                return b.version.compareTo(a.version);
            }
        });
    }

    // ---------------------------------------------------------------- 安装

    public static void install(final Context ctx, final Bundle b, final Cb cb) {
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    doInstall(ctx, b, cb);
                } catch (Throwable t) {
                    String m = t.getMessage() == null ? t.toString() : t.getMessage();
                    cb.onDone(false, "安装失败：" + m);
                }
            }
        }, "kernel-install").start();
    }

    private static void doInstall(Context ctx, Bundle b, Cb cb) throws Exception {
        if (b.tar == null || !b.tar.isFile()) throw new IOException("找不到包文件");
        if (b.manifest == null || !b.manifest.isFile()) throw new IOException("找不到 manifest.json");
        JSONObject mf = new JSONObject(readText(b.manifest));
        final String ver = mf.optString("version", "");
        if (!validVersion(ver)) throw new IOException("manifest 里的 version 为空、过长或含路径字符");
        String wantSha = mf.optString("sha256", "").toLowerCase();
        if (wantSha.length() == 0) throw new IOException("manifest 里没有 sha256（拒绝安装无法校验的包）");

        synchronized (LOCK) {
            File store = new File(STORE);
            if (!store.isDirectory() && !store.mkdirs()) throw new IOException("建不了目录 " + STORE);
            File staging = new File(kernelsDir(ctx), ".staging-" + ver);
            File old = new File(kernelsDir(ctx), ver + ".old");

            // ── ① 校验包（46~85MB，约 1~2 秒）
            cb.onStage("校验内核包…", 4);
            String got = sha256(b.tar);
            if (!got.equalsIgnoreCase(wantSha)) throw new IOException("sha256 不一致（包损坏或 manifest 不匹配）");

            // ── ② 解压到 staging（先删旧 staging，避免半成品叠加）
            cb.onStage("解压内核树…（约 2 万文件，需一两分钟）", -1);
            deleteTree(staging);
            if (!staging.mkdirs()) throw new IOException("建不了 staging 目录");
            extractTree(ctx, b.tar, staging);

            // ── ③ 自检：入口在、package.json 版本对得上
            if (!new File(staging, ENTRY).isFile()) throw new IOException("解压结果不对：缺 " + ENTRY);
            String treeVer = "";
            try { treeVer = new JSONObject(readText(new File(staging, KPKG))).optString("version", ""); } catch (Throwable ignored) {}
            if (!treeVer.equals(ver)) throw new IOException("版本对不上：manifest=" + ver + "，树=" + (treeVer.length() > 0 ? treeVer : "?"));
            if (!new File(staging, "REVISION").isFile()) throw new IOException("解压结果缺 REVISION");

            // ── ④ 就位：旧版本目录先挪开再删（rename 同分区，秒级）
            File target = versionDir(ctx, ver);
            File tree = treeDir(ctx, ver);
            deleteTree(old);
            if (tree.exists() && !tree.renameTo(old)) throw new IOException("旧内核目录挪不开：" + tree);
            File parent = target;
            if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("建不了目录 " + parent);
            if (!staging.renameTo(tree)) throw new IOException("staging 挪不进正式目录");
            deleteTree(old);

            // ── ⑤ 写标记 + 留一份 manifest（启动只信标记，不重算哈希）
            JSONObject ok = new JSONObject();
            ok.put("version", ver);
            ok.put("sha256", wantSha);
            ok.put("installedAt", System.currentTimeMillis());
            ok.put("fileCount", mf.optInt("fileCount", 0));
            writeText(markerFile(ctx, ver), ok.toString());
            copyFile(b.manifest, new File(target, "manifest.json"));

            cb.onDone(true, "内核 " + ver + " 已装好" + (activeVersion(ctx) == null ? "（当前仍用内置树）" : ""));
        }
    }

    /** 解压 tar.gz：调 payload 里的 python3（与自建环境安装同一套，保留权限位）。 */
    private static void extractTree(Context ctx, File tar, File dest) throws IOException {
        File py = new File(new File(ctx.getFilesDir(), "payload"), "bin/python3");
        if (!py.isFile()) throw new IOException("找不到内置 python3：" + py.getPath());
        String script =
                "import tarfile,sys\n" +
                "tf=tarfile.open(sys.argv[1], 'r:gz')\n" +
                "tf.extractall(sys.argv[2], filter='data')\n" +
                "tf.close()\n";
        ProcessBuilder pb = new ProcessBuilder(py.getAbsolutePath(), "-c", script,
                tar.getAbsolutePath(), dest.getAbsolutePath());
        pb.redirectErrorStream(true);
        Process p = pb.start();
        String out = drain(p);
        try { p.waitFor(); } catch (InterruptedException ignored) {}
        if (p.exitValue() != 0) throw new IOException("解压失败（python3 退出码 " + p.exitValue() + "）：" + tail(out));
    }

    // ---------------------------------------------------------------- 删除

    public static boolean remove(Context c, String ver) {
        if (!validVersion(ver)) return false;
        synchronized (LOCK) {
            if (ver.equals(activeVersion(c))) return false;   // 先切走再删
            deleteTree(versionDir(c, ver));
            return !versionDir(c, ver).exists();
        }
    }

    /** 本次启动是不是该回退：active 内核与内置内核版本不同且已连续失败。 */
    public static String kernelVersionAt(File tree) {
        try {
            return new JSONObject(readText(new File(tree, KPKG))).optString("version", "");
        } catch (Throwable t) { return ""; }
    }

    // ---------------------------------------------------------------- 小工具

    public static String sha256(File f) throws IOException {
        MessageDigest md;
        try { md = MessageDigest.getInstance("SHA-256"); } catch (Exception e) { throw new IOException("no sha256"); }
        InputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[1 << 20];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        } finally { try { in.close(); } catch (Throwable ignored) {} }
        StringBuilder sb = new StringBuilder();
        for (byte x : md.digest()) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static String readText(File f) throws IOException {
        InputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[(int) Math.min(f.length() + 16, 1 << 20)];
            int n = in.read(buf);
            if (n <= 0) return "";
            return new String(buf, 0, n, "UTF-8");
        } finally { try { in.close(); } catch (Throwable ignored) {} }
    }

    private static void writeText(File f, String s) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.isDirectory()) parent.mkdirs();
        OutputStream out = new FileOutputStream(f);
        try { out.write(s.getBytes("UTF-8")); } finally { try { out.close(); } catch (Throwable ignored) {} }
    }

    private static void copyFile(File from, File to) throws IOException {
        InputStream in = new FileInputStream(from);
        OutputStream out = new FileOutputStream(to);
        try {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            try { in.close(); } catch (Throwable ignored) {}
            try { out.close(); } catch (Throwable ignored) {}
        }
    }

    public static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    private static String drain(Process p) {
        StringBuilder sb = new StringBuilder();
        try {
            InputStream in = p.getInputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) {
                if (sb.length() < 60000) sb.append(new String(buf, 0, n));
            }
        } catch (Throwable ignored) {}
        return sb.toString();
    }

    private static String tail(String s) {
        if (s == null) return "";
        s = s.trim();
        return s.length() <= 400 ? s : s.substring(s.length() - 400);
    }

    private KernelStore() {}
}
