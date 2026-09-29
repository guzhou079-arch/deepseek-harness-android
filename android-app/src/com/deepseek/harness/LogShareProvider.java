package com.deepseek.harness;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.UriMatcher;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.util.Base64;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * v1.13：把日志/诊断文件以**文件形式**分享出去（而不是塞一段纯文字）。
 *
 * 为什么要自己写：本项目没有 androidx（libs 下只有 Shizuku 三个 AAR），拿不到
 * androidx.core.content.FileProvider；而 targetSdk 28 又不允许直接分享 file:// URI
 * （FileUriExposedException）。所以实现一个最小 ContentProvider，只读地暴露
 * {@link #shareDir} 下的文件，配合 FLAG_GRANT_READ_URI_PERMISSION 临时授权给接收方。
 *
 * 安全边界：只在 share 目录下按**纯文件名**取文件（拒绝 / .. \ 等路径穿越），
 * provider 本身 exported=false，只有持有人显式授权的 URI 才能读。
 */
public class LogShareProvider extends ContentProvider {

    /** 权限名：<包名>.logshare（三版本共存时各自独立）。 */
    public static String authorityOf(Context ctx) {
        return ctx.getPackageName() + ".logshare";
    }

    /** 待分享文件统一放这里（App 私有缓存，随系统清理，不污染用户目录）。 */
    public static File shareDir(Context ctx) {
        File d = new File(ctx.getCacheDir(), "share");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** 拼出可分享的 content:// URI（文件名必须是 shareDir 的直接子文件）。 */
    public static Uri uriFor(Context ctx, String fileName) {
        return Uri.parse("content://" + authorityOf(ctx) + "/" + fileName);
    }

    /** 按扩展名给 MIME（v1.15：交付文件「打开」要交给对的 App）。 */
    public static String mimeOfName(String name) {
        String n = name == null ? "" : name.toLowerCase();
        int dot = n.lastIndexOf('.');
        String ext = dot >= 0 ? n.substring(dot + 1) : "";
        if (ext.equals("docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (ext.equals("doc")) return "application/msword";
        if (ext.equals("xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (ext.equals("xls")) return "application/vnd.ms-excel";
        if (ext.equals("pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        if (ext.equals("ppt")) return "application/vnd.ms-powerpoint";
        if (ext.equals("pdf")) return "application/pdf";
        if (ext.equals("txt") || ext.equals("md") || ext.equals("log") || ext.equals("json")
                || ext.equals("js") || ext.equals("java") || ext.equals("py") || ext.equals("sh")
                || ext.equals("xml") || ext.equals("yml") || ext.equals("yaml") || ext.equals("csv")) return "text/plain";
        if (ext.equals("png")) return "image/png";
        if (ext.equals("jpg") || ext.equals("jpeg")) return "image/jpeg";
        if (ext.equals("gif")) return "image/gif";
        if (ext.equals("webp")) return "image/webp";
        if (ext.equals("mp4")) return "video/mp4";
        if (ext.equals("mp3")) return "audio/mpeg";
        if (ext.equals("zip")) return "application/zip";
        // v1.16：APK 安装包 —— 有了它，交付文件「打开」就能直接唤起系统安装界面
        if (ext.equals("apk")) return "application/vnd.android.package-archive";
        if (ext.equals("html") || ext.equals("htm")) return "text/html";
        return "*/*";
    }

    /** base64url → 绝对路径（v1.15）。 */
    private static String decodeAbs(String b64) {
        try {
            return new String(Base64.decode(b64, Base64.URL_SAFE | Base64.NO_WRAP));
        } catch (Throwable t) {
            return null;
        }
    }

    /** 是否为允许对外只读暴露的路径：App 自己的目录 + 共享存储。 */
    private boolean allowedPath(File f) {
        try {
            Context ctx = getContext();
            if (ctx == null) return false;
            String p = f.getCanonicalPath();
            String[] roots = new String[]{
                    "/storage/emulated/0",
                    ctx.getFilesDir().getCanonicalPath(),
                    ctx.getCacheDir().getCanonicalPath()
            };
            for (int i = 0; i < roots.length; i++) {
                String r = roots[i];
                if (r != null && (p.equals(r) || p.startsWith(r + "/"))) return true;
            }
            return false;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * v1.15：拼出可交给**别的 App 打开**的 content:// URI，路径经 base64url 编码。
     * 形如 content://<包名>.logshare/abs/<base64url(绝对路径)>，只读、仍需逐 URI 授权。
     */
    public static Uri uriForAbs(Context ctx, String absolutePath) {
        try {
            if (absolutePath == null || absolutePath.isEmpty()) return null;
            String b64 = Base64.encodeToString(absolutePath.getBytes(), Base64.URL_SAFE | Base64.NO_WRAP);
            return Uri.parse("content://" + authorityOf(ctx) + "/abs/" + b64);
        } catch (Throwable t) {
            return null;
        }
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private File resolve(Uri uri) {
        try {
            // v1.15：/abs/<base64url> —— 只读暴露白名单内的任意路径（交付文件「打开」用）
            java.util.List<String> segs = uri.getPathSegments();
            if (segs.size() == 2 && "abs".equals(segs.get(0))) {
                String abs = decodeAbs(segs.get(1));
                if (abs == null || abs.isEmpty()) return null;
                File af = new File(abs);
                return allowedPath(af) ? af : null;
            }
            String name = uri.getLastPathSegment();
            if (name == null || name.length() == 0) return null;
            // 防路径穿越：只认纯文件名
            if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf("..") >= 0) return null;
            Context ctx = getContext();
            if (ctx == null) return null;
            return new File(shareDir(ctx), name);
        } catch (Throwable t) {
            return null;
        }
    }

    @Override
    public String getType(Uri uri) {
        // v1.15：abs 路由按扩展名给真实 MIME，其余沿用纯文本
        java.util.List<String> segs = uri.getPathSegments();
        if (segs.size() == 2 && "abs".equals(segs.get(0))) {
            String abs = decodeAbs(segs.get(1));
            if (abs != null) return mimeOfName(abs);
        }
        return "text/plain";
    }

    /** 多数分享目标（邮件/网盘/IM）会查 DISPLAY_NAME 与 SIZE 来显示文件名和大小。 */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f = resolve(uri);
        if (f == null || !f.exists()) return null;
        String[] cols = (projection != null && projection.length > 0)
                ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = Long.valueOf(f.length());
            else row[i] = null;
        }
        c.addRow(row);
        return c;
    }

    /** 接收方读文件走这里（只读）。 */
    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = resolve(uri);
        if (f == null || !f.exists()) throw new FileNotFoundException(String.valueOf(uri));
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only provider");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only provider");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("read-only provider");
    }
}
