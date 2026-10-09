package com.deepseek.harness;

import java.io.File;
import java.io.IOException;

/** Delegate deletion to the platform tool; never traverse symbolic links in Java. */
final class SafeFiles {
    private SafeFiles() {}

    static void deleteTree(File file) throws IOException {
        if (file == null) throw new IOException("Missing deletion target");
        File absolute = file.getAbsoluteFile();
        String name = absolute.getName();
        if (absolute.getParentFile() == null || name.length() == 0 || ".".equals(name) || "..".equals(name)) {
            throw new IOException("Refusing ambiguous deletion target");
        }
        // Resolve only the parent. Canonicalizing the final component would follow
        // a directory symlink and turn a request to unlink it into deleting its target.
        String target = new File(absolute.getParentFile().getCanonicalFile(), name).getAbsolutePath();
        String[] tools = {"/system/bin/rm", "/bin/rm", "/usr/bin/rm"};
        IOException failure = null;
        for (String tool : tools) {
            if (!new File(tool).isFile()) continue;
            try {
                Process process = new ProcessBuilder(tool, "-rf", "--", target).redirectErrorStream(true).start();
                java.io.InputStream output = process.getInputStream();
                try { byte[] buffer = new byte[4096]; while (output.read(buffer) != -1) {} }
                finally { output.close(); }
                int status = process.waitFor();
                if (status != 0) throw new IOException("Deletion tool exited " + status);
                return;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IOException("Deletion interrupted", interrupted);
            } catch (IOException failed) { failure = failed; }
        }
        throw failure == null ? new IOException("Deletion tool unavailable") : failure;
    }
}
