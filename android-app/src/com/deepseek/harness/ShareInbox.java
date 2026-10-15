package com.deepseek.harness;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.text.format.DateFormat;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.util.*;

/** Copies temporary share grants into a bounded, app-private inbox before returning to chat. */
final class ShareInbox {
    private static final Object LOCK = new Object();
    private static final int MAX_FILES = 16, MAX_TEXT = 262144;
    private static final long MAX_FILE = 16L * 1024 * 1024, MAX_BATCH = 32L * 1024 * 1024;
    private final Context ctx;
    private final File root;
    ShareInbox(Context ctx) { this.ctx = ctx.getApplicationContext(); root = new File(ctx.getCacheDir(), "incoming-shares"); }
    private File batchDir(String id) throws IOException {
        if (id == null || !id.matches("[a-f0-9-]{36}")) throw new IOException("无效分享标识");
        File dir = new File(root, id);
        if (!dir.getCanonicalFile().getParentFile().equals(root.getCanonicalFile())) throw new IOException("无效分享目录");
        return dir;
    }
    private JSONObject read(File f) throws Exception {
        if (f.length() > 1048576) throw new IOException("分享记录过大");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        InputStream in = new FileInputStream(f);
        try { byte[] b = new byte[8192]; int n; while ((n = in.read(b)) != -1) bytes.write(b, 0, n); }
        finally { in.close(); }
        return new JSONObject(bytes.toString("UTF-8"));
    }
    private List<JSONObject> pending() throws Exception {
        List<JSONObject> list = new ArrayList<JSONObject>();
        File[] dirs = root.listFiles();
        if (dirs != null) for (File dir : dirs) {
            if (!dir.getName().matches("[a-f0-9-]{36}")) continue;
            File manifest = new File(batchDir(dir.getName()), "manifest.json");
            if (manifest.isFile()) list.add(read(manifest));
            else acknowledge(dir.getName()); // Recover only uncommitted imports, never queued shares.
        }
        Collections.sort(list, new Comparator<JSONObject>() {
            public int compare(JSONObject a, JSONObject b) { return Long.compare(a.optLong("createdAt"), b.optLong("createdAt")); }
        });
        return list;
    }
    JSONObject snapshot() throws Exception {
        synchronized (LOCK) {
            List<JSONObject> list = pending(); JSONObject out = new JSONObject(); out.put("ok", true);
            out.put("count", list.size()); out.put("batch", list.isEmpty() ? JSONObject.NULL : list.get(0));
            // 卡片按顺序处理**最旧**的一条，而"刚收到"的提示要报**最新**的一条：各取一头。
            out.put("latest", list.isEmpty() ? JSONObject.NULL : list.get(list.size() - 1));
            return out;
        }
    }
    /**
     * 另存一份到 /sdcard/DeepSeekHarness/shares/&lt;日期&gt;/，返回落点目录；什么都没写成功返回 null。
     *
     * 为什么要有这一份：分享卡片只挂在聊天输入框里，用户若停在控制台/设置页就**完全看不到**，
     * 内容会烂在 cache 里（2026-10-15 分享的 pptx 与 PDF 就这样躺了 20 分钟没人处理）。
     * 落在 /sdcard 上既不随应用数据一起丢，AI 也能直接读。失败只是少一份副本，
     * 不能让整次分享失败（所以整体 try/catch 成尽力而为）。
     */
    private String archive(File dir, JSONArray files, String text) {
        try {
            File shares = new File(Environment.getExternalStorageDirectory(), "DeepSeekHarness/shares");
            File day = new File(shares, DateFormat.format("yyyy-MM-dd", System.currentTimeMillis()).toString());
            if (!day.isDirectory() && !day.mkdirs()) return null;            String stamp = DateFormat.format("HHmmss", System.currentTimeMillis()).toString();
            boolean wrote = false;
            for (int i = 0; i < files.length(); i++) {
                JSONObject file = files.getJSONObject(i);
                String name = file.optString("name", "附件-" + (i + 1));
                File source = new File(dir, "file-" + file.optInt("index", i));
                if (!source.isFile()) continue;
                File out = new File(day, stamp + "-" + name);
                for (int n = 2; out.exists() && n < 1000; n++) out = new File(day, stamp + "-" + n + "-" + name);
                InputStream in = new FileInputStream(source); OutputStream os = new FileOutputStream(out);
                try { byte[] buffer = new byte[32768]; int n; while ((n = in.read(buffer)) != -1) os.write(buffer, 0, n); }
                finally { in.close(); os.close(); }
                wrote = true;
            }
            // 纯文本分享（浏览器分享链接、选中文字）没有附件，也留一份，免得只有聊天框能看到。
            if (text != null && !text.isEmpty()) {
                OutputStream os = new FileOutputStream(new File(day, stamp + "-分享文本.txt"));
                try { os.write(text.getBytes("UTF-8")); } finally { os.close(); }
                wrote = true;
            }
            // 对外一律报 /sdcard/... 这种写法：Environment 给的是 /storage/emulated/0/...，
            // 对用户和 AI 都更认前者（两者本来就是同一个目录）。
            return wrote ? "/sdcard/DeepSeekHarness/shares/" + day.getName() : null;
        } catch (Exception e) {
            return null;
        }
    }
    JSONObject enqueue(Intent intent) throws Exception {
        synchronized (LOCK) {
            if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法准备分享收件箱");
            if (pending().size() >= 8) throw new IOException("分享收件箱已满，请先处理聊天框中的待收内容");
            String id = UUID.randomUUID().toString(); File dir = batchDir(id);
            if (!dir.mkdir()) throw new IOException("无法保存分享内容");
            boolean committed = false;
            try {
            JSONObject item = new JSONObject(); JSONArray files = new JSONArray(), errors = new JSONArray();
            item.put("id", id); item.put("createdAt", System.currentTimeMillis());
            String text = "";
            CharSequence body = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (body != null) text = body.toString();
            String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
            if (subject != null && !subject.isEmpty() && !subject.equals(text)) text = subject + "\n" + text;
            LinkedHashSet<Uri> uris = new LinkedHashSet<Uri>();
            if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
                ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (list != null) uris.addAll(list);
            } else {
                Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM); if (uri != null) uris.add(uri);
            }
            ClipData clip = intent.getClipData();
            if (clip != null) for (int i = 0; i < Math.min(clip.getItemCount(), 64); i++) {
                ClipData.Item c = clip.getItemAt(i);
                if (c.getUri() != null) uris.add(c.getUri());
                else if (body == null && c.getText() != null) text += (text.isEmpty() ? "" : "\n") + c.getText();
            }
            if (text.length() > MAX_TEXT) { text = text.substring(0, MAX_TEXT); errors.put("文本超过 256K 字符，已截取前段"); }
            item.put("text", text);
            long total = 0; int index = 0;
            ContentResolver resolver = ctx.getContentResolver();
            for (Uri uri : uris) {
                if (uri == null) continue;
                if (index >= MAX_FILES) { errors.put("最多接收 16 个附件，其余未导入"); break; }
                if (!"content".equals(uri.getScheme()) || (ctx.getPackageName() + ".logshare").equals(uri.getAuthority())) {
                    errors.put("附件需要发送方提供可读取的内容 URI"); continue;
                }
                File target = new File(dir, "file-" + index); String name = "附件-" + (index + 1);
                try {
                    Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
                    if (cursor != null) try {
                        if (cursor.moveToFirst() && !cursor.isNull(0)) name = cursor.getString(0);
                    } finally { cursor.close(); }
                    name = name.replaceAll("[\\\\/\\p{Cntrl}]", "_");
                    if (name.length() > 160) name = name.substring(0, 160);
                    if (name.isEmpty()) name = "附件-" + (index + 1);
                    String mime = resolver.getType(uri);
                    if (mime == null || !mime.matches("[A-Za-z0-9.+_-]+/[A-Za-z0-9.+_-]+")) mime = "application/octet-stream";
                    long count = 0;
                    try (InputStream in = resolver.openInputStream(uri); FileOutputStream out = new FileOutputStream(target)) {
                        if (in == null) throw new IOException("无法打开附件");
                        byte[] buffer = new byte[32768]; int n;
                        while ((n = in.read(buffer)) != -1) {
                            count += n;
                            if (count > MAX_FILE || total + count > MAX_BATCH) throw new IOException("附件超过单文件 16MB 或本次 32MB 限制");
                            out.write(buffer, 0, n);
                        }
                    }
                    JSONObject file = new JSONObject(); file.put("index", index); file.put("name", name);
                    file.put("mime", mime); file.put("bytes", count); files.put(file); total += count; index++;
                } catch (Exception e) {
                    if (!target.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile())) throw new IOException("无效附件路径");
                    if (target.exists() && !target.delete()) throw new IOException("无法清理未完成附件");
                    errors.put(name + ": " + (e.getMessage() == null ? "附件读取失败" : e.getMessage()));
                }
            }
            item.put("files", files); item.put("errors", errors);
            String landed = archive(dir, files, text);
            if (landed != null) item.put("archive", landed);
            File temporary = new File(dir, "manifest.partial");
            try (FileOutputStream out = new FileOutputStream(temporary)) {
                out.write(item.toString().getBytes("UTF-8")); out.getFD().sync();
            }
            if (!temporary.renameTo(new File(dir, "manifest.json"))) throw new IOException("无法提交分享记录");
            committed = true;
            return item;
            } finally {
                if (!committed) acknowledge(id);
            }
        }
    }
    JSONObject chunk(String id, int index, long offset) throws Exception {
        synchronized (LOCK) {
            File dir = batchDir(id); JSONObject item = read(new File(dir, "manifest.json"));
            JSONArray files = item.getJSONArray("files");
            if (index < 0 || index >= files.length()) throw new IOException("无效附件编号");
            File f = new File(dir, "file-" + index);
            if (!f.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile()) || offset < 0 || offset > f.length())
                throw new IOException("无效附件读取范围");
            byte[] buffer = new byte[(int) Math.min(65536, f.length() - offset)];
            try (RandomAccessFile in = new RandomAccessFile(f, "r")) { in.seek(offset); in.readFully(buffer); }
            JSONObject out = new JSONObject(); out.put("ok", true);
            out.put("data", Base64.encodeToString(buffer, Base64.NO_WRAP)); out.put("eof", offset + buffer.length == f.length()); return out;
        }
    }
    void acknowledge(String id) throws Exception {
        synchronized (LOCK) {
            File dir = batchDir(id); if (!dir.isDirectory()) return;
            File[] files = dir.listFiles();
            if (files != null) for (File f : files) {
                if (!f.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile()) || !f.isFile()) throw new IOException("无效分享文件");
                if (!f.delete()) throw new IOException("无法清理已接收附件");
            }
            if (!dir.delete()) throw new IOException("无法清理分享目录");
        }
    }
}
