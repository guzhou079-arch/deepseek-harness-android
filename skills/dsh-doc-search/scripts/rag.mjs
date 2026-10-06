#!/usr/bin/env node
/**
 * DSH 本地文档与代码库轻量级检索/问答引擎 (DSH Local Code & Doc Search Engine)
 * 
 * 零第三方依赖：纯 Node.js 内置模块，专为手机端资源优化。
 * 支持代码仓库、技术文档、配置文件、日志等秒级分块与精准匹配。
 * 
 * 用法：
 *   node rag.mjs index <目录路径> [--name 知识库名]   构建/更新本地知识库索引
 *   node rag.mjs list                               列出所有已建知识库
 *   node rag.mjs search "<关键词/问题>" [--kb 库名]   跨文件多维检索最相关段落
 *   node rag.mjs context "<问题>" [--kb 库名]        输出供 AI 问答的结构化参考上下文
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KB_DIR = '/sdcard/Download/DSH_Knowledge';
if (!fs.existsSync(KB_DIR)) {
  fs.mkdirSync(KB_DIR, { recursive: true });
}

// 支持索引的文件后缀
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.xml', '.html', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.py', '.c', '.cpp',
  '.h', '.hpp', '.go', '.rs', '.sh', '.bash', '.properties', '.gradle', '.toml', '.sql'
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.gradle', 'build', 'dist', 'out', 'cache', '.cache',
  'd8', 'classes', 'tmp', '.idea', '.vscode'
]);

// 递归遍历可读文本文件
function scanFiles(dir, base = '') {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  const list = fs.readdirSync(dir);
  for (const item of list) {
    if (IGNORE_DIRS.has(item) || item.startsWith('.')) continue;
    const full = path.join(dir, item);
    const rel = base ? `${base}/${item}` : item;
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        files.push(...scanFiles(full, rel));
      } else if (stat.isFile()) {
        const ext = path.extname(item).toLowerCase();
        // 限制单文件不超过 1.5MB（避免超大日志或二进制误读）
        if (TEXT_EXTS.has(ext) && stat.size > 0 && stat.size < 1.5 * 1024 * 1024) {
          files.push({ fullPath: full, relPath: rel, size: stat.size, mtime: stat.mtimeMs });
        }
      }
    } catch (ignored) {}
  }
  return files;
}

// 分块切分文本
function chunkText(content, relPath, chunkSize = 45, overlap = 10) {
  const lines = content.split('\n');
  const chunks = [];
  let i = 0;
  while (i < lines.length) {
    const end = Math.min(lines.length, i + chunkSize);
    const chunkLines = lines.slice(i, end);
    const text = chunkLines.join('\n').trim();
    if (text.length > 20) {
      chunks.push({
        file: relPath,
        startLine: i + 1,
        endLine: end,
        content: text,
      });
    }
    if (end >= lines.length) break;
    i += (chunkSize - overlap);
  }
  return chunks;
}

// 简单分词与清洗
function tokenize(text) {
  const clean = text.toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, ' ');
  const tokens = [];
  const words = clean.split(' ');
  for (const w of words) {
    if (!w || w.length < 2) continue;
    tokens.push(w);
    // 对中文字符串额外加入单字/双字 ngram
    if (/[\u4e00-\u9fa5]/.test(w)) {
      for (let i = 0; i < w.length - 1; i++) {
        tokens.push(w.substring(i, i + 2));
      }
    }
  }
  return tokens;
}

// 建立索引
function buildIndex(targetDir, kbName = '') {
  const resolvedDir = path.resolve(targetDir);
  if (!fs.existsSync(resolvedDir)) {
    console.error(`❌ 目标目录不存在: ${resolvedDir}`);
    process.exit(1);
  }

  const name = kbName || path.basename(resolvedDir) || 'default';
  console.log(`📚 开始为目录构建本地知识库: ${resolvedDir} (名称: ${name})`);

  const files = scanFiles(resolvedDir);
  console.log(`  🔍 发现 ${files.length} 个源码/文档文件...`);

  const allChunks = [];
  let totalChars = 0;

  for (const f of files) {
    try {
      const content = fs.readFileSync(f.fullPath, 'utf-8');
      totalChars += content.length;
      const chunks = chunkText(content, f.relPath);
      for (const c of chunks) {
        c.absPath = f.fullPath;
        allChunks.push(c);
      }
    } catch (ignored) {}
  }

  const indexData = {
    name,
    rootPath: resolvedDir,
    createdAt: new Date().toISOString(),
    filesCount: files.length,
    chunksCount: allChunks.length,
    totalChars,
    chunks: allChunks
  };

  const outFile = path.join(KB_DIR, `${name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(indexData));

  console.log('✅ 知识库索引构建完成！');
  console.log(`  📂 索引文件: ${outFile}`);
  console.log(`  📄 索引文件数: ${files.length} 个`);
  console.log(`  🧩 文本切片数: ${allChunks.length} 个（共 ${(totalChars / 1024).toFixed(1)} KB 字符）`);
}

// 加载知识库
function loadKb(name) {
  let target = '';
  if (name) {
    target = path.join(KB_DIR, `${name}.json`);
    if (!fs.existsSync(target) && fs.existsSync(name)) target = name;
  } else {
    // 默认取最新的一个
    const files = fs.readdirSync(KB_DIR).filter(f => f.endsWith('.json'));
    if (files.length > 0) {
      files.sort((a, b) => {
        return fs.statSync(path.join(KB_DIR, b)).mtimeMs - fs.statSync(path.join(KB_DIR, a)).mtimeMs;
      });
      target = path.join(KB_DIR, files[0]);
    }
  }

  if (!target || !fs.existsSync(target)) {
    throw new Error('未找到任何已构建的知识库，请先使用 node rag.mjs index <目录> 构建索引。');
  }

  const raw = fs.readFileSync(target, 'utf-8');
  return JSON.parse(raw);
}

// 检索
function searchChunks(query, kbName = '', limit = 5) {
  const kb = loadKb(kbName);
  const qTokens = tokenize(query);

  if (qTokens.length === 0) {
    return [];
  }

  const scored = [];

  for (const chunk of kb.chunks) {
    const chunkTokens = tokenize(chunk.content + ' ' + chunk.file);
    const tokenSet = new Set(chunkTokens);
    let score = 0;

    for (const qt of qTokens) {
      if (tokenSet.has(qt)) {
        score += 2.0;
      } else if (chunk.content.toLowerCase().includes(qt)) {
        score += 1.0;
      }
      // 路径匹配加分
      if (chunk.file.toLowerCase().includes(qt)) {
        score += 3.0;
      }
    }

    if (score > 0) {
      scored.push({ chunk, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.chunk);
}

// 列出知识库
function listKbs() {
  console.log(`📋 本地知识库目录: ${KB_DIR}\n`);
  const files = fs.readdirSync(KB_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('（暂无知识库，请运行 node rag.mjs index <目录> 创建）');
    return;
  }

  console.log('知识库名称 | 源码目录 | 文件数 | 切片数 | 构建时间');
  console.log('---|---|---|---|---');
  for (const file of files) {
    try {
      const p = path.join(KB_DIR, file);
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const timeStr = data.createdAt.replace('T', ' ').substring(0, 19);
      console.log(`${data.name} | ${data.rootPath} | ${data.filesCount} 个 | ${data.chunksCount} 个 | ${timeStr}`);
    } catch (ignored) {}
  }
}

// 命令行分发
const args = process.argv.slice(2);
const cmd = args[0] || 'help';

switch (cmd) {
  case 'index': {
    const targetDir = args[1];
    if (!targetDir) {
      console.error('用法: node rag.mjs index <目录路径> [--name 知识库名]');
      process.exit(1);
    }
    const nameIdx = args.indexOf('--name');
    const name = nameIdx !== -1 ? args[nameIdx + 1] : '';
    buildIndex(targetDir, name);
    break;
  }
  case 'list':
  case 'ls': {
    listKbs();
    break;
  }
  case 'search': {
    const query = args[1];
    if (!query) {
      console.error('用法: node rag.mjs search "<查询问题/关键字>" [--kb 知识库名]');
      process.exit(1);
    }
    const kbIdx = args.indexOf('--kb');
    const kbName = kbIdx !== -1 ? args[kbIdx + 1] : '';
    const results = searchChunks(query, kbName, 5);
    console.log(`🔍 检索关键词: "${query}" (命中 ${results.length} 条段落)\n`);
    results.forEach((r, idx) => {
      console.log(`--- [${idx + 1}] 📄 ${r.file} (Line ${r.startLine}-${r.endLine}) ---`);
      console.log(r.content);
      console.log('\n');
    });
    break;
  }
  case 'context': {
    const query = args[1];
    const kbIdx = args.indexOf('--kb');
    const kbName = kbIdx !== -1 ? args[kbIdx + 1] : '';
    const results = searchChunks(query, kbName, 4);
    if (results.length === 0) {
      console.log('未找到相关上下文。');
      break;
    }
    console.log('【本地知识库参考上下文】');
    results.forEach(r => {
      console.log(`\n### 文件: ${r.file} (L${r.startLine}-L${r.endLine})\n\`\`\`\n${r.content}\n\`\`\``);
    });
    break;
  }
  default:
    console.log(`DSH 本地代码与文档 RAG 问答引擎

用法：
  node rag.mjs index <目录路径> [--name 库名]    扫描目录构建索引
  node rag.mjs list                            列出已有知识库
  node rag.mjs search "<问题/关键字>" [--kb 库名]  检索相关段落
  node rag.mjs context "<问题>" [--kb 库名]       生成 AI 问答参考上下文
`);
    break;
}
