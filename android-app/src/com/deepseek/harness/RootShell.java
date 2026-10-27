package com.deepseek.harness;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;

/** Locates su once and probes it without blocking on unread process output. */
public final class RootShell {
    private static final int TIMEOUT_MS = 5000;
    private static final String[] FALLBACKS = {
            "/system/bin/su", "/system/xbin/su", "/sbin/su",
            "/vendor/bin/su", "/vendor/xbin/su", "/su/bin/su"
    };

    public static final class Probe {
        public final boolean ok;
        public final boolean detected;
        public final String suPath;
        public final String detail;

        private Probe(boolean ok, boolean detected, String suPath, String detail) {
            this.ok = ok;
            this.detected = detected;
            this.suPath = suPath;
            this.detail = detail;
        }
    }

    private RootShell() {}

    public static Probe probe() {
        StringBuilder failures = new StringBuilder();
        boolean detected = false;
        Probe missing = new Probe(false, false, "su", "su not found");
        String[] candidates = new String[FALLBACKS.length + 1];
        candidates[0] = "su";
        System.arraycopy(FALLBACKS, 0, candidates, 1, FALLBACKS.length);
        for (String candidate : candidates) {
            String executable = resolve(candidate);
            if (executable == null) continue;
            Probe result = probeOne(executable);
            if (result.ok) return result;
            detected = detected || result.detected;
            if (result.detail.startsWith("start failed:")) {
                missing = result;
                if (failures.length() > 0) failures.append("; ");
                failures.append(result.detail);
                continue;
            }
            // su ran and returned a definitive denial/error: do not prompt again through aliases.
            return result;
        }
        return failures.length() == 0 ? missing
                : new Probe(false, detected, missing.suPath, failures.toString());
    }

    private static String resolve(String candidate) {
        if (!"su".equals(candidate)) {
            File file = new File(candidate);
            return file.isFile() ? file.getAbsolutePath() : null;
        }
        String path = System.getenv("PATH");
        if (path != null) {
            for (String dir : path.split(File.pathSeparator)) {
                if (dir.length() == 0) continue;
                File file = new File(dir, "su");
                if (file.isFile()) return file.getAbsolutePath();
            }
        }
        return candidate;
    }

    private static Probe probeOne(String executable) {
        Process process = null;
        try {
            process = new ProcessBuilder(executable, "-c", "id")
                    .redirectErrorStream(true).start();
            Integer exitCode = null;
            long deadline = System.currentTimeMillis() + TIMEOUT_MS;
            while (System.currentTimeMillis() < deadline) {
                try {
                    exitCode = process.exitValue();
                    break;
                } catch (IllegalThreadStateException stillRunning) {
                    Thread.sleep(50);
                }
            }
            if (exitCode == null) {
                process.destroy();
                return new Probe(false, true, executable, "timeout after " + TIMEOUT_MS + "ms: " + executable);
            }
            String output = readLimited(process.getInputStream()).trim();
            String compact = output.replaceAll("\\s+", " ");
            if (compact.length() > 500) compact = compact.substring(0, 500);
            boolean ok = exitCode == 0 && compact.contains("uid=0");
            return new Probe(ok, true, executable,
                    "exit=" + exitCode + ", su=" + executable + (compact.length() > 0 ? ", output=" + compact : ""));
        } catch (Throwable t) {
            String message = t.getMessage();
            return new Probe(false, !"su".equals(executable), executable, "start failed: " + executable
                    + (message == null ? "" : " (" + message + ")"));
        } finally {
            if (process != null) {
                try { process.destroy(); } catch (Throwable ignored) {}
            }
        }
    }

    private static String readLimited(InputStream input) throws Exception {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[1024];
            int total = 0;
            while (total < 4096) {
                int n = input.read(buffer, 0, Math.min(buffer.length, 4096 - total));
                if (n < 0) break;
                out.write(buffer, 0, n);
                total += n;
            }
            return new String(out.toByteArray(), "UTF-8");
        } finally {
            try { input.close(); } catch (Throwable ignored) {}
        }
    }
}
