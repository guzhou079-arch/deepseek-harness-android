package com.deepseek.harness;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Private notification history; never sends notification content to a model. */
final class NotificationArchive {
    private static final int MAX_ITEMS = 100;
    private static final int MAX_TEXT = 65536;
    private NotificationArchive() {}

    static synchronized String save(File filesDir, String title, String text) throws Exception {
        File dir = new File(filesDir, "notification-history");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("Cannot create notification archive");
        String id = UUID.randomUUID().toString();
        JSONObject record = new JSONObject().put("id", id).put("time", System.currentTimeMillis())
                .put("title", title == null ? "" : title.substring(0, Math.min(title.length(), 1024))).put("text", text == null ? "" : text.substring(0, Math.min(text.length(), MAX_TEXT)));
        File tmp = new File(dir, id + ".tmp");
        File dest = new File(dir, id + ".json");
        FileOutputStream stream = new FileOutputStream(tmp);
        try { stream.write(record.toString().getBytes("UTF-8")); stream.getFD().sync(); }
        finally { stream.close(); }
        if (!tmp.renameTo(dest)) throw new java.io.IOException("Cannot commit notification archive");
        File[] items = entries(dir);
        for (int i = MAX_ITEMS; i < items.length; i++) items[i].delete();
        return id;
    }

    static synchronized JSONArray list(File filesDir) throws Exception {
        JSONArray records = new JSONArray();
        File[] files = entries(new File(filesDir, "notification-history"));
        for (int i = 0; i < Math.min(files.length, MAX_ITEMS); i++) {
            try { records.put(read(files[i])); } catch (Exception ignored) {}
        }
        return records;
    }

    private static File[] entries(File dir) {
        File[] files = dir.listFiles(new java.io.FilenameFilter() {
            @Override public boolean accept(File parent, String name) { return name.matches("[a-f0-9-]{36}\\.json"); }
        });
        if (files == null) return new File[0];
        Arrays.sort(files, new Comparator<File>() {
            @Override public int compare(File a, File b) { return Long.compare(b.lastModified(), a.lastModified()); }
        });
        return files;
    }

    private static JSONObject read(File file) throws Exception {
        if (file.length() > MAX_TEXT * 8L) throw new java.io.IOException("Notification record too large");
        FileInputStream stream = new FileInputStream(file);
        try {
            java.io.ByteArrayOutputStream body = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int n;
            while ((n = stream.read(buffer)) != -1) {
                if (body.size() + n > MAX_TEXT * 8) throw new java.io.IOException("Notification record too large");
                body.write(buffer, 0, n);
            }
            return new JSONObject(new String(body.toByteArray(), "UTF-8"));
        } finally { stream.close(); }
    }
}
