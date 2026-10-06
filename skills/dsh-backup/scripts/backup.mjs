#!/usr/bin/env node
/**
 * DSH 时光机全站一键备份与迁移工具 (DSH Snapshot & Migration)
 * 
 * 零第三方依赖：纯 Node.js 内置模块（fs/zlib/crypto/path），在手机端秒级执行。
 * 
 * 功能：
 *   node backup.mjs create [--name 标签]    一键打包全站资产（记忆库+会话+配置+技能）
 *   node backup.mjs list                   列出所有可用备份快照
 *   node backup.mjs verify <文件>           校验快照完整性与元数据摘要
 *   node backup.mjs restore <文件> [--yes]  一键完整还原全站资产
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const DSH_HOME = process.env.DSH_HOME || '/data/user/0/com.deepseek.harness/files/payload/dshhome';
const MEM_DIR = '/sdcard/DeepSeekHarness/memory';
const TOOLS_DIR = '/sdcard/DeepSeekHarness/tools';
const BACKUP_DIR = '/sdcard/Download/DSH_Backups';

// 确保备份目录存在
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// 收集目录下的所有文件
function walk(dir, base = '') {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  for (const item of list) {
    // 忽略锁文件、临时目录与临时缓存
    if (item === '.DS_Store' || item.endsWith('.lock') || item.endsWith('.tmp') || item === 'cache') continue;
    const full = path.join(dir, item);
    const rel = base ? `${base}/${item}` : item;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...walk(full, rel));
    } else if (stat.isFile()) {
      results.push({ fullPath: full, relPath: rel, size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return results;
}

// 格式化字节数
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// 生成快照
function createBackup(customTag = '') {
  console.log('📦 正在生成 DSH 全站时光机备份快照...');
  const startTime = Date.now();

  const manifest = {
    version: 1,
    app: 'DeepSeek Harness Android',
    createdAt: new Date().toISOString(),
    tag: customTag || 'manual',
    stats: {
      sessionsCount: 0,
      memoryDbSize: 0,
      filesCount: 0,
      totalUncompressedBytes: 0,
    },
    entries: []
  };

  const filesToPack = [];

  // 1. 记忆系统资产
  if (fs.existsSync(MEM_DIR)) {
    const memFiles = walk(MEM_DIR, 'memory');
    for (const f of memFiles) {
      filesToPack.push(f);
      if (f.relPath.endsWith('mem.db')) {
        manifest.stats.memoryDbSize = f.size;
      }
    }
  }

  // 2. 会话记录（sessions）
  const sessionsDir = path.join(DSH_HOME, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const sessFiles = walk(sessionsDir, 'sessions');
    for (const f of sessFiles) {
      filesToPack.push(f);
      if (f.relPath.endsWith('.jsonl.zstd') || f.relPath.endsWith('.jsonl')) {
        manifest.stats.sessionsCount++;
      }
    }
  }

  // 3. 用户配置与设置（profiles）
  const profilesDir = path.join(DSH_HOME, 'profiles');
  if (fs.existsSync(profilesDir)) {
    filesToPack.push(...walk(profilesDir, 'profiles'));
  }

  // 4. 技能集（skills）
  const skillsDir = path.join(DSH_HOME, 'skills');
  if (fs.existsSync(skillsDir)) {
    filesToPack.push(...walk(skillsDir, 'skills'));
  }

  manifest.stats.filesCount = filesToPack.length;
  manifest.stats.totalUncompressedBytes = filesToPack.reduce((acc, f) => acc + f.size, 0);

  // 打包结构：使用标准轻量级 archive 容器
  // [4B 魔数 DSHB][4B manifest 长度][manifest JSON 数据 UTF-8][压缩的文件内容块...]
  const payloadBuffers = [];
  for (const f of filesToPack) {
    const content = fs.readFileSync(f.fullPath);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    manifest.entries.push({
      path: f.relPath,
      size: f.size,
      sha256: hash,
      mtime: f.mtime
    });
    payloadBuffers.push(content);
  }

  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestBuf = Buffer.from(manifestJson, 'utf-8');

  // 对所有内容整体执行 zlib 压缩
  const allContentsBuf = Buffer.concat(payloadBuffers);
  const compressedPayload = zlib.gzipSync(allContentsBuf, { level: 9 });

  // 组装最终 .dshbackup 文件
  const magic = Buffer.from('DSHB', 'utf-8'); // Magic: DeepSeek Harness Backup
  const manifestLenBuf = Buffer.alloc(4);
  manifestLenBuf.writeUInt32BE(manifestBuf.length, 0);

  const finalBuffer = Buffer.concat([
    magic,
    manifestLenBuf,
    manifestBuf,
    compressedPayload
  ]);

  const now = new Date();
  const dateStr = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');

  const filename = `DSH_Backup_${dateStr}${customTag ? '_' + customTag : ''}.dshbackup`;
  const outPath = path.join(BACKUP_DIR, filename);

  fs.writeFileSync(outPath, finalBuffer);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('✅ 全站快照备份创建成功！');
  console.log(`  📂 备份文件: ${outPath}`);
  console.log(`  📊 快照大小: ${formatSize(finalBuffer.length)}（未压缩原始大小: ${formatSize(manifest.stats.totalUncompressedBytes)}）`);
  console.log(`  💬 会话数量: ${manifest.stats.sessionsCount} 个`);
  console.log(`  🧠 记忆资产: ${formatSize(manifest.stats.memoryDbSize)} (mem.db)`);
  console.log(`  📄 资产文件: 共 ${manifest.stats.filesCount} 个文件`);
  console.log(`  ⏱️ 耗时: ${duration}s`);
  return outPath;
}

// 解析快照
function parseBackupFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到备份文件: ${filePath}`);
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length < 8) {
    throw new Error('文件已损坏：长度过短');
  }
  const magic = buf.subarray(0, 4).toString('utf-8');
  if (magic !== 'DSHB') {
    throw new Error(`未知备份格式，魔数期望 DSHB，实际: ${magic}`);
  }
  const manifestLen = buf.readUInt32BE(4);
  if (buf.length < 8 + manifestLen) {
    throw new Error('文件已损坏：元数据截断');
  }
  const manifestJson = buf.subarray(8, 8 + manifestLen).toString('utf-8');
  const manifest = JSON.parse(manifestJson);
  const compressedPayload = buf.subarray(8 + manifestLen);

  return { manifest, compressedPayload };
}

// 校验快照
function verifyBackup(filePath) {
  console.log(`🔍 正在校验备份快照: ${filePath}...`);
  const { manifest, compressedPayload } = parseBackupFile(filePath);
  const decompressed = zlib.gunzipSync(compressedPayload);

  let offset = 0;
  for (const entry of manifest.entries) {
    if (offset + entry.size > decompressed.length) {
      throw new Error(`校验失败：条目 ${entry.path} 超过解压缓冲界限`);
    }
    const chunk = decompressed.subarray(offset, offset + entry.size);
    const hash = crypto.createHash('sha256').update(chunk).digest('hex');
    if (hash !== entry.sha256) {
      throw new Error(`校验失败：文件 ${entry.path} 哈希校验不匹配`);
    }
    offset += entry.size;
  }

  console.log('✅ 校验通过，快照完整无损！');
  console.log(`  🕒 创建时间: ${manifest.createdAt}`);
  console.log(`  🏷️ 标签备注: ${manifest.tag}`);
  console.log(`  💬 包含会话: ${manifest.stats.sessionsCount} 个`);
  console.log(`  🧠 记忆数据: ${formatSize(manifest.stats.memoryDbSize)}`);
  console.log(`  📄 包含文件: ${manifest.stats.filesCount} 个（总计 ${formatSize(manifest.stats.totalUncompressedBytes)}）`);
}

// 还原快照
function restoreBackup(filePath, force = false) {
  console.log(`⚠️ 准备还原快照: ${filePath}`);
  const { manifest, compressedPayload } = parseBackupFile(filePath);
  const decompressed = zlib.gunzipSync(compressedPayload);

  console.log(`🚀 开始解包还原 ${manifest.entries.length} 个资产文件...`);
  let offset = 0;
  let restoredCount = 0;

  for (const entry of manifest.entries) {
    const chunk = decompressed.subarray(offset, offset + entry.size);
    offset += entry.size;

    let targetBase = DSH_HOME;
    let subPath = entry.path;

    if (entry.path.startsWith('memory/')) {
      targetBase = path.dirname(MEM_DIR); // 即 /sdcard/DeepSeekHarness
      subPath = entry.path;
    } else {
      targetBase = DSH_HOME;
      subPath = entry.path;
    }

    const targetFile = path.join(targetBase, subPath);
    const targetDir = path.dirname(targetFile);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(targetFile, chunk);
    restoredCount++;
  }

  console.log(`✅ 成功还原 ${restoredCount} 个文件！`);

  // 触发记忆系统投影同步
  try {
    const memJs = path.join(TOOLS_DIR, 'mem.js');
    if (fs.existsSync(memJs)) {
      console.log('🔄 正在同步记忆库投影（AGENTS.md / hot.md）...');
      execSync(`node ${memJs} sync`, { stdio: 'inherit' });
    }
  } catch (err) {
    console.warn('⚠️ 记忆库同步提示:', err.message);
  }

  console.log('🎉 时光机全站还原完成！刷新页面或重启 App 即可无缝回到备份时刻。');
}

// 列出所有快照
function listBackups() {
  console.log(`📋 备份仓库目录: ${BACKUP_DIR}\n`);
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.dshbackup'));
  if (files.length === 0) {
    console.log('（暂无备份快照，执行 node backup.mjs create 立即创建第一个备份）');
    return;
  }

  files.sort().reverse();
  console.log('序号 | 文件名 | 大小 | 创建时间 | 会话数 | 记忆');
  console.log('---|---|---|---|---|---');
  files.forEach((file, index) => {
    const full = path.join(BACKUP_DIR, file);
    try {
      const { manifest } = parseBackupFile(full);
      const stat = fs.statSync(full);
      const timeStr = manifest.createdAt.replace('T', ' ').substring(0, 19);
      console.log(`${String(index + 1).padStart(2, ' ')} | ${file} | ${formatSize(stat.size)} | ${timeStr} | ${manifest.stats.sessionsCount}个 | ${formatSize(manifest.stats.memoryDbSize)}`);
    } catch (e) {
      console.log(`${String(index + 1).padStart(2, ' ')} | ${file} | (损坏或格式不匹配)`);
    }
  });
}

// 主命令行分发
const args = process.argv.slice(2);
const cmd = args[0] || 'create';

switch (cmd) {
  case 'create':
  case 'backup':
  case 'snap': {
    const nameIdx = args.indexOf('--name');
    const tag = nameIdx !== -1 ? args[nameIdx + 1] : '';
    createBackup(tag);
    break;
  }
  case 'list':
  case 'ls': {
    listBackups();
    break;
  }
  case 'verify':
  case 'check': {
    const target = args[1];
    if (!target) {
      console.error('用法: node backup.mjs verify <备份文件路径>');
      process.exit(1);
    }
    verifyBackup(target);
    break;
  }
  case 'restore': {
    const target = args[1];
    if (!target) {
      console.error('用法: node backup.mjs restore <备份文件路径>');
      process.exit(1);
    }
    restoreBackup(target, args.includes('--yes') || args.includes('-y'));
    break;
  }
  default:
    console.log(`DSH 时光机全站备份工具

用法：
  node backup.mjs create [--name 标签]    创建新备份
  node backup.mjs list                   列出已有备份
  node backup.mjs verify <文件>           校验快照完整性
  node backup.mjs restore <文件>          从快照还原
`);
    break;
}
