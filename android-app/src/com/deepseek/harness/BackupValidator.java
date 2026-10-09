package com.deepseek.harness;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Validate backup entries before stopping the engine or writing user data. */
final class BackupValidator {
    private static final long MAX_BYTES = 2L * 1024L * 1024L * 1024L;
    private static final long MAX_ENTRY_BYTES = 256L * 1024L * 1024L;
    private static final int MAX_ENTRIES = 100000;
    private BackupValidator() {}

    static File target(File home, String relative) throws IOException {
        if (relative == null || relative.length() == 0 || relative.startsWith("/") || relative.indexOf('\\') >= 0) {
            throw new IOException("Invalid backup path");
        }
        for (String part : relative.split("/", -1)) {
            if ("..".equals(part) || ".".equals(part) || part.length() == 0) throw new IOException("Invalid backup path");
        }
        String root = home.getCanonicalPath();
        File file = new File(home, relative);
        if (!file.getCanonicalPath().startsWith(root + File.separator)) throw new IOException("Backup path escapes user-data directory");
        return file;
    }

    static void validate(InputStream input, File home) throws IOException {
        if (input == null) throw new IOException("Cannot read selected backup");
        ZipInputStream zip = new ZipInputStream(input);
        HashSet<String> names = new HashSet<String>();
        boolean manifest = false;
        boolean userData = false;
        long total = 0;
        byte[] buffer = new byte[65536];
        try {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                if (names.size() >= MAX_ENTRIES || !names.add(name)) throw new IOException("Too many or duplicate backup entries");
                if (name.startsWith("dshhome/")) {
                    String relative = name.substring("dshhome/".length());
                    if (entry.isDirectory()) {
                        if (relative.length() > 0) target(home, relative.substring(0, relative.length() - 1));
                    } else {
                        target(home, relative);
                        userData = true;
                    }
                } else if (!"manifest.json".equals(name) && !"prefs.txt".equals(name)) {
                    throw new IOException("Unexpected backup entry");
                }
                long bytes = 0;
                java.io.ByteArrayOutputStream manifestBody = "manifest.json".equals(name) ? new java.io.ByteArrayOutputStream() : null;
                int n;
                while ((n = zip.read(buffer)) != -1) {
                    bytes += n;
                    total += n;
                    if (bytes > MAX_ENTRY_BYTES || total > MAX_BYTES || ("prefs.txt".equals(name) && bytes > 1024 * 1024L)
                            || (manifestBody != null && bytes > 65536)) {
                        throw new IOException("Backup exceeds size limits");
                    }
                    if (manifestBody != null) manifestBody.write(buffer, 0, n);
                }
                if (manifestBody != null) {
                    try {
                        org.json.JSONObject metadata = new org.json.JSONObject(new String(manifestBody.toByteArray(), "UTF-8"));
                        if (!"dsh-android-backup".equals(metadata.optString("kind")) || metadata.optInt("format") != 1) {
                            throw new IOException("Unsupported backup format");
                        }
                    } catch (org.json.JSONException invalid) { throw new IOException("Invalid backup manifest", invalid); }
                    manifest = true;
                }
                zip.closeEntry();
            }
            if (!manifest || !userData) throw new IOException("Backup lacks manifest or user-data files");
        } finally { zip.close(); }
    }
}
