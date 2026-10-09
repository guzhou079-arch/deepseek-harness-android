package com.deepseek.harness;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * 把一份**已通过 BackupValidator 预检**的备份写回磁盘，并尽量可回滚。
 *
 * 能力边界（别当数据库事务看，别写成“已实现事务”）：
 *   · 覆盖一个已存在的文件前，先把原件挪进私有回滚目录；失败时挪回来。
 *   · 新建的文件失败时删掉。
 *   · 成功提交 = 删掉回滚目录（丢弃原件副本）。
 *   · **进程被杀 / 断电** 这类中途崩溃没有日志：回滚目录会留在原地，
 *     下一次导入会重建它（所以它不是崩溃一致性，只是“出错能退回去”）。
 *   · 只负责文件；SharedPreferences 的先后顺序由调用方保证（先文件、后偏好）。
 */
public final class BackupRestore {
    private final File root;
    private final File rollbackDir;
    private final List<File> created = new ArrayList<File>();
    private final List<File[]> displaced = new ArrayList<File[]>();
    private boolean finished = false;

    /**
     * @param root        还原根目录（例如 payload/dshhome）。
     * @param rollbackDir 私有回滚目录（调用方应放在 App 私有空间，别放共享存储）。
     */
    public BackupRestore(File root, File rollbackDir) throws IOException {
        this.root = root;
        this.rollbackDir = rollbackDir;
        if (rollbackDir.exists()) SafeFiles.deleteTree(rollbackDir);
        if (!rollbackDir.mkdirs() && !rollbackDir.isDirectory()) {
            throw new IOException("无法创建回滚目录: " + rollbackDir);
        }
    }

    /**
     * 校验条目边界、登记回滚、建好父目录，返回调用方要写入的目标文件。
     * 调用方随后自己写（可以流式写大文件）；写失败就调 {@link #rollback()}。
     */
    public File prepare(String relative) throws IOException {
        if (finished) throw new IOException("restore already finished");
        File out = BackupValidator.target(root, relative);
        File parent = out.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("mkdir failed: " + parent);
        if (out.exists()) {
            // 先登记：目标已存在 → 原件挪进回滚目录，失败时挪回来
            File keep = new File(rollbackDir, "d" + displaced.size());
            if (!out.renameTo(keep)) {
                copyFile(out, keep);
                if (!out.delete()) throw new IOException("无法移走原文件: " + out);
            }
            displaced.add(new File[] { keep, out });
        } else {
            created.add(out);
        }
        return out;
    }

    /** 全部写完后调用：丢弃回滚副本。返回是否清理成功。 */
    public boolean commit() {
        finished = true;
        try { SafeFiles.deleteTree(rollbackDir); return true; }
        catch (Throwable ignored) { return false; }
    }

    /**
     * 失败时调用：还原被覆盖的原件、删掉新建的文件。
     * @return 处理成功的条目数（尽力而为，个别失败不抛出）。
     */
    public int rollback() {
        finished = true;
        int n = 0;
        for (File[] pair : displaced) {
            try {
                if (pair[1].exists()) SafeFiles.deleteTree(pair[1]);
                if (!pair[0].renameTo(pair[1])) {
                    copyFile(pair[0], pair[1]);
                    SafeFiles.deleteTree(pair[0]);
                }
                n++;
            } catch (Throwable ignored) {}
        }
        for (File f : created) {
            try { if (f.exists()) { SafeFiles.deleteTree(f); n++; } } catch (Throwable ignored) {}
        }
        try { SafeFiles.deleteTree(rollbackDir); } catch (Throwable ignored) {}
        return n;
    }

    private static void copyFile(File src, File dst) throws IOException {
        File parent = dst.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("mkdir failed: " + parent);
        FileInputStream in = new FileInputStream(src);
        try {
            FileOutputStream out = new FileOutputStream(dst);
            try {
                byte[] b = new byte[64 * 1024];
                int r;
                while ((r = in.read(b)) > 0) out.write(b, 0, r);
            } finally { out.close(); }
        } finally { in.close(); }
    }
}
