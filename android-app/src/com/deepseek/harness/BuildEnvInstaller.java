package com.deepseek.harness;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * BuildEnvInstaller —— 「自建环境」按需安装（方案 B）
 * ============================================================================
 * 为什么要有它：这个项目的核心价值**不在功能，在可维护性** ——
 * 「能在手机上自己编译、自己打包、自己签名、自己发布」。
 * 但完整构建环境（proot + Alpine + OpenJDK 17 + android.jar/d8/apksigner/apktool）
 * 有 342MB，塞进主包对只想用 AI 的人是纯负担。所以**按需下载**。
 *
 * ⚠️ 三条踩出来的硬约束（改这个类之前先读）：
 *
 * ① **rootfs 只能解压到 App 私有目录（ext4），绝不能放 /sdcard**
 *    /sdcard 是 FUSE，**存不了符号链接**；而 Alpine rootfs 里符号链接比普通文件还多
 *    （918 个 vs 778 个）。放上去就是一堆坏链接、环境直接废。
 *    tarball 本身是纯文件，所以**放在 /sdcard 没问题** —— 于是"下载一次"能成立：
 *    重装 App 丢了私有目录，但 tarball 还在，**只需重新解压、不用重新下载**。
 *
 * ② **解压必须用 payload 里的 python3，且 filter='fully_trusted'**
 *    Python 3.14 起 tarfile.extractall 默认 filter='data'，**会剥掉符号链接和权限位**
 *    → 解出来是个废 rootfs。必须显式传 fully_trusted。
 *    （Android 自带的 toybox tar 同样会丢符号链接，别用。）
 *
 * ③ **分卷是逼出来的**：实测 Gitee 附件上限 **100MB**（HTTP 400 明说），
 *    而环境包 193MB。为了两个平台**对等**（谁也不是谁的附庸），两边都用同样的分卷，
 *    下载后按顺序拼起来再校验整包 sha256。
 *
 * 安装流程：
 *   查 release → 下清单 → 逐卷下载（已下且校验过就跳过＝断点续传）
 *   → 合并 → 校整包 sha256 → python3 解压到 staging → 搬进私有目录 → 写就绪标记
 */
public final class BuildEnvInstaller {

    /** 进度回调。**可能在任意线程被调**，调用方自己 post 到主线程。 */
    public interface Cb {
        /** @param pct 0~100；<0 表示进度未知（例如解压中） */
        void onStage(String stage, int pct);
        void onDone(boolean ok, String msg);
    }

    /** 一个下载来源。GitHub 与 Gitee **对等**，谁也不特殊。 */
    public static final class Source {
        public final String label;          // "GitHub" / "Gitee"
        public final String tag;            // buildenv-v1
        public final Map<String, String> assets = new LinkedHashMap<String, String>();  // 文件名 → 直链
        Source(String label, String tag) { this.label = label; this.tag = tag; }

        /** 分卷文件名，按名字排序（part01 < part02 …，所以字典序就是顺序） */
        public List<String> parts() {
            List<String> l = new ArrayList<String>();
            for (String k : assets.keySet()) if (k.matches(".*\\.part\\d+$")) l.add(k);
            Collections.sort(l);
            return l;
        }
        /** 清单文件名（……parts.json） */
        public String manifestName() {
            for (String k : assets.keySet()) if (k.endsWith(".parts.json")) return k;
            return null;
        }
        public String describe() { return label + "（" + tag + "，共 " + assets.size() + " 个文件）"; }
    }

    // ── 两个仓库的 release 列表接口（对等：各查各的）────────────────────
    private static final String GH_LIST =
            "https://api.github.com/repos/guzhou079-arch/deepseek-harness-android/releases?per_page=30";
    private static final String GI_LIST =
            "https://gitee.com/api/v5/repos/zhou-gu24/deepseek-harness-android/releases";

    /** 环境包/分卷落在 /sdcard（纯文件，重装不丢；符号链接不在这里） */
    public static final String STORE = "/sdcard/DeepSeekHarness/buildenv";

    private static volatile boolean cancelFlag = false;

    // ══════════════════════════ 对外状态查询 ══════════════════════════

    /** App 私有目录：/data/user/0/<pkg>/files —— rootfs 只能住这里（ext4） */
    public static File filesDir(Context c) {
        // ⚠️ getFilesDir() 返回的**就是** /data/user/<id>/<pkg>/files。
        //    2026-10-01 装机实测踩到：这里多取了一层 parent → 变成包目录，
        //    少一个 files/，于是 python3 被找成
        //    /data/user/0/com.deepseek.harness/payload/bin/python3（不存在）。
        return c.getFilesDir();
    }

    public static File markerFile(Context c) {
        File base = filesDir(c);
        return base == null ? null : new File(base, "buildenv.json");
    }

    /** 装好了没：三样关键东西都在才算（run.sh / android.jar / alpine 的 sh） */
    public static boolean isInstalled(Context c) {
        File base = filesDir(c);
        if (base == null) return false;
        return new File(base, "work/linux/run.sh").isFile()
                && new File(base, "work/linux/alpine/bin/busybox").exists()
                && new File(base, "toolchain/android.jar").isFile();
    }

    /** 一句话状态，给控制台显示 */
    public static String statusText(Context c) {
        if (!isInstalled(c)) {
            File store = new File(STORE);
            String extra = "";
            if (store.isDirectory() && store.list() != null && store.list().length > 0) {
                extra = "\n（/sdcard 上已有下载好的分卷，重装后不用重新下载，解压即可）";
            }
            return "未安装 —— 装上之后你可以在这台手机上自己编译、打包、签名、安装这个 App。" + extra;
        }
        String ver = "";
        try {
            JSONObject j = new JSONObject(readText(markerFile(c)));
            ver = "v" + j.optInt("version", 1) + "（" + j.optInt("parts", 0) + " 卷，"
                    + (j.optLong("bytes", 0) / 1048576) + "MB）";
        } catch (Throwable ignored) {}
        return "已就绪 " + ver + " —— 在项目目录里跑 selfbuild 脚本即可自己出包。";
    }

    /** 取消当前任务 */
    public static void cancel() { cancelFlag = true; }

    // ══════════════════════════ 查发布源 ══════════════════════════

    /**
     * 查两个平台上的 buildenv release。**对等**：各查各的，
     * 一个挂了不影响另一个；谁先答不重要，两个都会被返回。
     */
    public static List<Source> resolveSources() {
        List<Source> out = new ArrayList<Source>();
        try {
            Source s = parseReleaseList(httpGet(GH_LIST, "application/vnd.github+json"), "GitHub");
            if (s != null) out.add(s);
        } catch (Throwable ignored) {}
        try {
            Source s = parseReleaseList(httpGet(GI_LIST, "application/json"), "Gitee");
            if (s != null) out.add(s);
        } catch (Throwable ignored) {}
        return out;
    }

    private static Source parseReleaseList(String json, String label) throws Exception {
        JSONArray arr = new JSONArray(json);
        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.getJSONObject(i);
            String tag = r.optString("tag_name", "");
            if (!tag.startsWith("buildenv-")) continue;          // 只认构建环境的 release
            Source s = new Source(label, tag);
            JSONArray assets = r.optJSONArray("assets");
            if (assets == null) continue;
            for (int k = 0; k < assets.length(); k++) {
                JSONObject a = assets.getJSONObject(k);
                String name = a.optString("name", "");
                String url = a.optString("browser_download_url", "");
                if (name.length() > 0 && url.length() > 0) s.assets.put(name, url);
            }
            if (s.assets.size() > 0) return s;
        }
        return null;
    }

    // ══════════════════════════ 安装 ══════════════════════════

    /** 后台跑整个安装。cb 在**后台线程**被调。 */
    public static void install(final Context ctx, final Source src, final Cb cb) {
        cancelFlag = false;
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    doInstall(ctx, src, cb);
                } catch (Throwable t) {
                    cb.onDone(false, "安装失败：" + (t.getMessage() == null ? t.toString() : t.getMessage()));
                }
            }
        }, "buildenv-install").start();
    }

    private static void doInstall(Context ctx, Source src, Cb cb) throws Exception {
        final File base = filesDir(ctx);
        if (base == null) throw new IOException("拿不到 App 私有目录");

        // ── ① 清单
        String mfName = src.manifestName();
        if (mfName == null) throw new IOException("这个来源里没有清单文件（*.parts.json）");
        File store = new File(STORE);
        if (!store.isDirectory() && !store.mkdirs()) throw new IOException("建不了目录 " + STORE);
        File mfFile = new File(store, mfName);
        cb.onStage("取清单", 2);
        downloadTo(src.assets.get(mfName), mfFile, null, 0, 100);
        JSONObject man = new JSONObject(readText(mfFile));
        JSONObject whole = man.getJSONObject("whole");
        JSONArray parts = man.getJSONArray("parts");
        if (parts.length() == 0) throw new IOException("清单里没有分卷");

        // ── ② 逐卷下载（已下且完好 → 跳过＝断点续传）
        for (int i = 0; i < parts.length(); i++) {
            checkCancel();
            JSONObject p = parts.getJSONObject(i);
            String name = p.getString("name");
            long bytes = p.getLong("bytes");
            String want = p.getString("sha256");
            File f = new File(store, name);
            if (f.isFile() && f.length() == bytes && want.equalsIgnoreCase(sha256(f))) {
                cb.onStage("第 " + (i + 1) + "/" + parts.length() + " 卷已就绪（跳过）", pct(i, parts.length()));
                continue;
            }
            String url = src.assets.get(name);
            if (url == null) throw new IOException("来源里没有这一卷：" + name);
            cb.onStage("下载第 " + (i + 1) + "/" + parts.length() + " 卷…", pct(i, parts.length()));
            downloadTo(url, f, cb, pct(i, parts.length()), pct(i + 1, parts.length()));
            if (!want.equalsIgnoreCase(sha256(f))) {
                f.delete();
                throw new IOException(name + " 校验不通过（下载损坏），可重试");
            }
        }

        // ── ③ 合并 + 校整包
        checkCancel();
        cb.onStage("合并分卷并校验…", -1);
        File tmp = new File(base, "tmp");
        if (!tmp.isDirectory()) tmp.mkdirs();
        File joined = new File(tmp, "buildenv-join.tar.gz");
        joinParts(store, parts, joined);
        String wantWhole = whole.optString("sha256", "");
        if (wantWhole.length() > 0 && !wantWhole.equalsIgnoreCase(sha256(joined))) {
            joined.delete();
            throw new IOException("合并后整包校验不通过（分卷可能缺了或坏了）");
        }

        // ── ④ 解压到 staging（用 python3，保符号链接）
        checkCancel();
        cb.onStage("解压中（几百 MB，要几分钟）…", -1);
        File stage = new File(tmp, "buildenv-stage");
        deleteTree(stage);
        if (!stage.isDirectory() && !stage.mkdirs()) {
            // 上次失败可能留下残骸；rm 已经删过了，还建不了就是别的原因（权限/空间）
            throw new IOException("建不了 staging 目录：" + stage.getPath()
                    + "（存在=" + stage.exists() + "，可用空间见控制台）");
        }
        extract(joined, stage);
        joined.delete();   // 解压完就删，分卷还留着，够重装用

        // ── ⑤ 搬进私有目录
        cb.onStage("安装到内部存储…", -1);
        File srcLinux = new File(stage, "env/work/linux");
        File srcTc = new File(stage, "env/toolchain");
        if (!srcLinux.isDirectory()) throw new IOException("包结构不对：找不到 env/work/linux");

        File dstLinux = new File(base, "work/linux");
        deleteTree(dstLinux);
        File dstWork = new File(base, "work");
        if (!dstWork.isDirectory()) dstWork.mkdirs();
        if (!srcLinux.renameTo(dstLinux)) {
            copyTree(srcLinux, dstLinux);
            deleteTree(srcLinux);
        }

        // ⚠️ 包里**没有** work/linux/tmp，但 run.sh 里写着 PROOT_TMP_DIR="$D/tmp"，
        //    而 proot 在 tmp 不存在时是**直接报错退出**的：
        //      proot error: can't create temporary directory: No such file or directory
        //      proot error: can't create glue rootfs
        //    不补这一下，用户装完拿到的就是一套跑不起来的环境。
        //    （2026-10-01 装机后实测才发现 —— 我先前用自写的测试 run 脚本验证，
        //      它指向解压目录、没走包里 run.sh 的 tmp 设置，所以漏了。）
        File tmpDir = new File(dstLinux, "tmp");
        if (!tmpDir.isDirectory()) tmpDir.mkdirs();

        if (srcTc.isDirectory()) {
            File dstTc = new File(base, "toolchain");
            if (!dstTc.isDirectory()) dstTc.mkdirs();
            File[] jars = srcTc.listFiles();
            if (jars != null) for (File j : jars) {
                File to = new File(dstTc, j.getName());
                if (to.exists()) to.delete();
                if (!j.renameTo(to)) { copyFile(j, to); j.delete(); }
            }
        }
        deleteTree(stage);

        // ── ⑤.5 修 run.sh 里的写死路径
        // 包里的 run.sh 写死了 D=/data/user/0/<pkg>/files/work/linux。
        // 单用户下这个路径正好对；但**多用户**（工作资料 / 访客）是 /data/user/<id>/…，
        // 写死就跑不起来。所以解压完按**实际**路径改一次 —— 比让用户自己猜强，
        // 也比为了这一行重打重传 193MB 划算。
        fixupRunSh(base);

        // ── ⑥ 就绪标记
        JSONObject mk = new JSONObject();
        mk.put("version", man.optInt("version", 1));
        mk.put("tag", src.tag);
        mk.put("source", src.label);
        mk.put("parts", parts.length());
        mk.put("bytes", whole.optLong("bytes", 0));
        mk.put("sha256", wantWhole);
        mk.put("installedAt", System.currentTimeMillis());
        writeText(markerFile(ctx), mk.toString(2));

        if (!isInstalled(ctx)) throw new IOException("装完了但自检没通过，可能解压不完整");
        cb.onStage("完成", 100);
        cb.onDone(true, "自建环境已就绪（" + src.label + " / " + src.tag + "）");
    }

    private static int pct(int done, int total) { return total <= 0 ? 0 : (int) (done * 100L / total); }

    private static void checkCancel() throws IOException {
        if (cancelFlag) throw new IOException("已取消");
    }

    // ══════════════════════════ 下载 ══════════════════════════

    private static List<String> buildCandidates(String url) {
        List<String> list = new ArrayList<String>();
        if (url == null || url.isEmpty()) return list;
        // GitHub 直链自动补充常用国内高速镜像
        if (url.startsWith("https://github.com/") || url.startsWith("http://github.com/")) {
            // 优先放主流加速镜像，然后再放原站与其他镜像，防国内直连 15s 超时
            list.add("https://ghproxy.net/" + url);
            list.add("https://mirror.ghproxy.com/" + url);
            list.add("https://gh-proxy.com/" + url);
            list.add("https://ghfast.top/" + url);
            list.add(url);
        } else {
            list.add(url);
        }
        return list;
    }

    /** 下载到文件，带进度、多源智能重试与断点续传。pctFrom/pctTo 把这段映射到总进度区间。 */
    private static void downloadTo(String primaryUrl, File dst, Cb cb, int pctFrom, int pctTo) throws IOException {
        File tmp = new File(dst.getAbsolutePath() + ".tmp");
        List<String> candidates = buildCandidates(primaryUrl);
        IOException lastErr = null;

        for (int i = 0; i < candidates.size(); i++) {
            checkCancel();
            String tryUrl = candidates.get(i);
            HttpURLConnection c = null;
            InputStream in = null;
            OutputStream out = null;
            try {
                long existing = tmp.exists() ? tmp.length() : 0;
                c = (HttpURLConnection) new URL(tryUrl).openConnection();
                c.setConnectTimeout(8000);   // 8s 连不上快速切下一源，避免死等 15s 超时
                c.setReadTimeout(45000);
                c.setRequestProperty("User-Agent", "dsh-android");
                c.setInstanceFollowRedirects(true);
                if (existing > 0) {
                    c.setRequestProperty("Range", "bytes=" + existing + "-");
                }
                int code = c.getResponseCode();
                long total = -1;
                if (code == 206) {
                    out = new FileOutputStream(tmp, true);
                    long remaining = c.getContentLength();
                    total = remaining > 0 ? (existing + remaining) : -1;
                } else if (code == 200) {
                    existing = 0;
                    out = new FileOutputStream(tmp, false);
                    total = c.getContentLength();
                } else if (code == 416) {
                    // Range 不对，重置从头下
                    tmp.delete();
                    existing = 0;
                    c.disconnect();
                    c = (HttpURLConnection) new URL(tryUrl).openConnection();
                    c.setConnectTimeout(8000);
                    c.setReadTimeout(45000);
                    c.setRequestProperty("User-Agent", "dsh-android");
                    c.setInstanceFollowRedirects(true);
                    code = c.getResponseCode();
                    if (code != 200) throw new IOException("HTTP " + code + " (" + tryUrl + ")");
                    out = new FileOutputStream(tmp, false);
                    total = c.getContentLength();
                } else {
                    throw new IOException("HTTP " + code + " (" + tryUrl + ")");
                }

                in = c.getInputStream();
                byte[] buf = new byte[65536];
                long got = existing;
                int n, lastPct = -1;
                while ((n = in.read(buf)) > 0) {
                    checkCancel();
                    out.write(buf, 0, n);
                    got += n;
                    if (cb != null && total > 0) {
                        int p = pctFrom + (int) ((pctTo - pctFrom) * (got / (double) total));
                        if (p != lastPct) {
                            lastPct = p;
                            cb.onStage(dst.getName() + "  " + mb(got) + " / " + mb(total), p);
                        }
                    }
                }
                out.flush();
                out.close(); out = null;
                in.close(); in = null;
                if (dst.exists()) dst.delete();
                if (!tmp.renameTo(dst)) throw new IOException("改名失败：" + dst.getName());
                // 下载成功，退出循环
                return;
            } catch (IOException e) {
                if (cancelFlag) throw e;
                lastErr = e;
                // 继续尝试下一个候选源
            } finally {
                closeQuietly(out); closeQuietly(in);
                if (c != null) try { c.disconnect(); } catch (Throwable ignored) {}
            }
        }

        if (tmp.exists() && tmp.length() == 0) tmp.delete();
        throw (lastErr != null ? lastErr : new IOException("下载全部来源失败：" + dst.getName()));
    }

    /** 把分卷按清单顺序拼成整包（流式，不把 193MB 读进内存） */
    // ⚠️ 声明 Exception 而不是 IOException：里面要读 JSONArray（getJSONObject/getString 抛 JSONException）
    private static void joinParts(File store, JSONArray parts, File out) throws Exception {
        FileOutputStream fo = null;
        try {
            fo = new FileOutputStream(out);
            byte[] buf = new byte[1 << 20];
            for (int i = 0; i < parts.length(); i++) {
                File f = new File(store, parts.getJSONObject(i).getString("name"));
                if (!f.isFile()) throw new IOException("缺分卷：" + f.getName());
                FileInputStream fi = null;
                try {
                    fi = new FileInputStream(f);
                    int n;
                    while ((n = fi.read(buf)) > 0) { checkCancel(); fo.write(buf, 0, n); }
                } finally { closeQuietly(fi); }
            }
            fo.flush();
        } finally { closeQuietly(fo); }
    }

    /**
     * 调 payload 里的 python3 解压。
     * ⚠️ filter='fully_trusted' 必须显式给 —— Python 3.14 默认 'data' 会把符号链接和权限位剥掉。
     */
    private static void extract(File tar, File stage) throws IOException {
        File base = stage.getParentFile().getParentFile();   // …/files
        File py = new File(base, "payload/bin/python3");
        if (!py.isFile()) {
            // 把 base 一起报出来：上次就是 base 算错（少了 files/），
            // 但报错只给最终路径，得回头翻代码才知道。多给一个线索省一轮。
            throw new IOException("找不到内置 python3：" + py.getPath() + "（base=" + base.getPath() + "）");
        }
        String script =
                "import tarfile,sys\n" +
                "tf=tarfile.open(sys.argv[1])\n" +
                "tf.extractall(sys.argv[2], filter='fully_trusted')\n" +   // 关键
                "tf.close()\n";
        ProcessBuilder pb = new ProcessBuilder(py.getAbsolutePath(), "-c", script,
                tar.getAbsolutePath(), stage.getAbsolutePath());
        pb.redirectErrorStream(true);
        Process p = pb.start();
        String out = drain(p);
        try { p.waitFor(); } catch (InterruptedException ignored) {}
        if (p.exitValue() != 0) throw new IOException("解压失败（python3 退出码 " + p.exitValue() + "）：" + tail(out));
        if (!new File(stage, "env/work/linux").isDirectory()) throw new IOException("解压结果不对：没看到 env/work/linux");
    }

    /**
     * 把 run.sh 里写死的 D/F 改成**这台机器上的实际路径**。
     * 多用户（工作资料）下 App 私有目录是 /data/user/&lt;id&gt;/…，包里那份写在 /data/user/0/…，
     * 不改就跑不起来。改的是解压出来的那份，可重复执行。
     */
    private static void fixupRunSh(File base) {
        try {
            File sh = new File(base, "work/linux/run.sh");
            if (!sh.isFile()) return;
            String t = readText(sh);
            String d = new File(base, "work/linux").getAbsolutePath();
            String f = base.getAbsolutePath();
            // 只替换"赋值那一行"，避免误伤注释里提到的路径
            String out = t.replaceAll("(?m)^D=.*$", "D=\"" + d + "\"")
                          .replaceAll("(?m)^F=.*$", "F=\"" + f + "\"");
            if (!out.equals(t)) writeText(sh, out);
        } catch (Throwable ignored) {
            // 改不动也不该让整个安装失败：单用户下那份原样也能跑
        }
    }

    // ══════════════════════════ 小工具 ══════════════════════════

    private static String httpGet(String url, String accept) throws IOException {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(20000);
            c.setRequestProperty("User-Agent", "dsh-android");
            c.setRequestProperty("Accept", accept);
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            in.close();
            return new String(bo.toByteArray(), "UTF-8");
        } finally { if (c != null) try { c.disconnect(); } catch (Throwable ignored) {} }
    }

    private static String drain(Process p) {
        try {
            InputStream in = p.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[4096];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            return new String(bo.toByteArray(), "UTF-8");
        } catch (Throwable t) { return ""; }
    }

    private static String tail(String s) {
        if (s == null) return "";
        s = s.trim();
        return s.length() <= 300 ? s : s.substring(s.length() - 300);
    }

    static String sha256(File f) throws IOException {
        FileInputStream in = null;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            in = new FileInputStream(f);
            byte[] buf = new byte[1 << 20];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) {
            throw new IOException("算 sha256 失败：" + e.getMessage());
        } finally { closeQuietly(in); }
    }

    private static String readText(File f) throws IOException {
        FileInputStream in = null;
        try {
            in = new FileInputStream(f);
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) > 0) bo.write(b, 0, n);
            return new String(bo.toByteArray(), "UTF-8");
        } finally { closeQuietly(in); }
    }

    private static void writeText(File f, String s) throws IOException {
        FileOutputStream o = null;
        try {
            o = new FileOutputStream(f);
            o.write(s.getBytes("UTF-8"));
        } finally { closeQuietly(o); }
    }

    private static void closeQuietly(Object o) {
        if (o == null) return;
        try {
            if (o instanceof InputStream) ((InputStream) o).close();
            else if (o instanceof OutputStream) ((OutputStream) o).close();
        } catch (Throwable ignored) {}
    }

    private static void copyFile(File from, File to) throws IOException {
        FileInputStream in = null;
        FileOutputStream out = null;
        try {
            in = new FileInputStream(from);
            out = new FileOutputStream(to);
            byte[] b = new byte[1 << 16];
            int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
            out.flush();
        } finally { closeQuietly(in); closeQuietly(out); }
    }

    private static void copyTree(File from, File to) throws IOException {
        // ⚠️ 兜底路径（主路径是同文件系统的 renameTo，几乎不会走到这）。
        //    符号链接一律跳过：rootfs 里的链接（含 jre -> . 自环）在这里无法安全重建，
        //    硬跟进去就会重演"钻进自环"的事故。
        if (isSymlink(from)) return;
        if (from.isDirectory()) {
            if (!to.isDirectory() && !to.mkdirs()) throw new IOException("建不了 " + to.getPath());
            File[] kids = from.listFiles();
            if (kids != null) for (File k : kids) copyTree(k, new File(to, k.getName()));
        } else {
            copyFile(from, to);
        }
    }

    /**
     * 删目录树。
     *
     * ⚠️ 用系统的 `rm -rf`，**不要自己写递归** —— rootfs 里有 `jre -> .` 这种**自环**符号链接。
     *    2026-10-01 装机实测的教训：原来用 `isDirectory()` 递归（它会**跟随**链接），
     *    顺着 jre/jre/jre/… 钻下去，**把用户已经装好的 work/linux 删到一半就崩**，
     *    环境当场不可用（页面从"已就绪"变回"未安装"）。
     *
     * ⚠️ 也别用"getCanonicalPath() != getAbsolutePath()"这个常见技巧判断链接：
     *    **自环上 getCanonicalPath() 自己就会抛 ELOOP**，被 catch 吞掉后误判成"不是链接"，
     *    等于没修。这条路我试过，不通（见 DeleteTreeTest）。
     *
     * rm 按设计就不跟随符号链接，且久经考验。实测：含自环的 7 项树，一条 rm -rf 干净删完。
     */
    private static void deleteTree(File f) {
        if (f == null) return;
        String path = f.getAbsolutePath();
        String[] cmds = {"/system/bin/rm", "rm", "/bin/rm"};
        for (String c : cmds) {
            try {
                Process p = new ProcessBuilder(c, "-rf", path).redirectErrorStream(true).start();
                drain(p);
                if (p.waitFor() == 0) return;
            } catch (Throwable ignored) {}
        }
        // 兜底：连 rm 都调不起来时，**只删这一层**（绝不递归跟进链接）
        try { f.delete(); } catch (Throwable ignored) {}
    }

    /**
     * 不跟随符号链接的"是不是链接"判断。
     * 用 android.system.Os.lstat（API 21+）—— 它按定义就不跟随；
     * 绝不能用 getCanonicalPath() 比较（自环上会抛 ELOOP）。
     */
    private static boolean isSymlink(File f) {
        try {
            android.system.StructStat st = android.system.Os.lstat(f.getAbsolutePath());
            return (st.st_mode & android.system.OsConstants.S_IFMT)
                    == android.system.OsConstants.S_IFLNK;
        } catch (Throwable t) {
            return false;
        }
    }

    private static String mb(long n) { return (n / 1048576) + "MB"; }

    private BuildEnvInstaller() {}
}
