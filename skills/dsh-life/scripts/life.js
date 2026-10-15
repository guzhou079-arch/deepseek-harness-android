#!/usr/bin/env node
/**
 * DSH Life & Notification Hub (生活助理与通知中枢)
 * 
 * 核心功能：
 * 1. 验证码秒提：自动监听通知/短信中的验证码，毫秒级提取并直接写入系统剪贴板 + 弹窗提示。
 * 2. 动账自动记账：自动解析微信支付、支付宝、各家银行动账通知，结构化沉淀至本地 SQLite (life.db)。
 * 3. 快递取件码聚合：自动提取菜鸟驿站、丰巢、兔喜等取件码与驿站信息，生成待取包裹清单。
 * 4. 全功能定时中枢 (Cron Scheduler)：支持精确 Cron/间隔调度，双重绑定 Android 系统 AlarmManager 闹钟。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

// 基础常量配置
const DB_PATH = '/sdcard/DeepSeekHarness/life.db';
const PID_FILE = '/data/user/0/com.deepseek.harness/files/tmp/life-daemon.pid';
const LOG_FILE = '/sdcard/DeepSeekHarness/life-daemon.log';
const BRIDGE_3181 = 'http://127.0.0.1:3181';
const BRIDGE_3081 = 'http://127.0.0.1:3081';

// 确保目录存在
try { fs.mkdirSync('/sdcard/DeepSeekHarness', { recursive: true }); } catch (_) {}
try { fs.mkdirSync('/data/user/0/com.deepseek.harness/files/tmp', { recursive: true }); } catch (_) {}

// ==================== 1. 数据库管理 ====================

function openDB() {
  const db = new DatabaseSync(DB_PATH, { timeout: 4000 });
  try { db.exec('PRAGMA busy_timeout = 4000;'); } catch (_) {}
  try { db.exec('PRAGMA journal_mode = WAL;'); } catch (_) {
    try { db.exec('PRAGMA journal_mode = DELETE;'); } catch (_) {}
  }

  // 初始化表结构
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      source TEXT,
      full_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      auto_copied INTEGER DEFAULT 1,
      used INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL, -- expense / income / transfer
      amount REAL NOT NULL,
      merchant TEXT,
      category TEXT,
      account TEXT,
      full_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      seq INTEGER UNIQUE
    );

    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_no TEXT,
      pickup_code TEXT NOT NULL,
      station TEXT,
      carrier TEXT,
      status TEXT DEFAULT 'pending', -- pending / picked
      full_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      picked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL, -- '0 8 * * *' / 'interval:30m' / 'daily:08:30'
      action_type TEXT NOT NULL, -- 'cmd' / 'notify' / 'builtin'
      action_payload TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_status TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scenes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- brief / recap / trigger / custom
      description TEXT,
      config_json TEXT,
      enabled INTEGER DEFAULT 1,
      last_triggered_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scene_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scene_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      content TEXT NOT NULL,
      triggered_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daemon_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return db;
}

// ==================== 2. HTTP 桥接请求辅助 ====================

function httpGetJson(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false, error: data || e.message }); }
      });
    }).on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function httpPostJson(url, payload) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const postData = JSON.stringify(payload);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve({ ok: false, error: data || e.message }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.write(postData);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// 写入系统剪贴板
async function copyToClipboard(text) {
  return await httpPostJson(`${BRIDGE_3081}/clipboard`, { action: 'write', content: text });
}

// 发送系统通知
async function sendNotification(title, text) {
  return await httpPostJson(`${BRIDGE_3081}/notify`, { title, text });
}

// ==================== 3. 智能特征提取引擎 ====================

function cleanMerchantName(str) {
  if (!str) return '银行消费';
  let s = str.replace(/^[0-9一二三四五六七八九十月日年月日：:\s\-\.\/]+(?:在|于|向)?/, '').trim();
  s = s.replace(/^(?:在|于|向)/, '').trim();
  return s || '银行消费';
}

// 商户名垃圾判定：银行模板里没有商户时，正则会把「10月15日12:06发生一笔」清洗成
// 「发生一笔」这种残渣。宁可退回中性名，也不要往账本里写一个假商户。
function isJunkMerchant(str) {
  if (!str) return true;
  const s = String(str).trim();
  if (s.length < 2) return true;
  if (/(发生一笔|一笔|支出|收入|交易|消费|扣款|转账|付款|尾号|余额|人民币|详情|点击|完成|存入|转入|到账|代发)/.test(s)) return true;
  if (/[0-9]{1,2}[:：][0-9]{2}/.test(s)) return true; // 时间残渣
  if (/月.*日/.test(s)) return true;                  // 日期残渣
  if (/^[0-9]/.test(s)) return true;                  // 以数字开头 → 金额/日期串
  return false;
}

// 同一笔钱常来两条通知（银行笼统提醒 + 详细交易短信），seq 不同、唯一键拦不住。
// 按「类型 + 金额 + 账户 + 时间窗」判重：重复就跳过；若新记录带得出商户而旧记录
// 是中性名，则把旧记录升级（补商户/分类/账号），不新增行。
function normalizeAccount(a) {
  return String(a || '').replace(/[（(].*?[)）]/g, '').trim();
}
function isNeutralMerchant(m) {
  return !m || /^(银行消费|银行转入\/代发|微信商户|支付宝商户|银行转入)$/.test(String(m).trim());
}
// 重放保护用：同一段通知原文是否已经入库（table 只传脚本内固定字面量）
function textAlreadyStored(db, table, fullText) {
  if (!fullText) return false;
  try { return !!db.prepare(`SELECT 1 FROM ${table} WHERE full_text = ? LIMIT 1`).get(fullText); } catch (_) { return false; }
}
function insertTransactionDedup(db, txInfo, seq, createdAt) {
  const at = createdAt || Date.now();
  try {
    // 重放保护：桥归零后缓冲会被整段重放，同一条通知原文不该重复记账。
    // 但旧行若只有中性商户（"银行消费"）而这次解析出真商户，仍要给旧行补上。
    if (txInfo.fullText) {
      const same = db.prepare(`SELECT id, merchant FROM transactions WHERE full_text = ? LIMIT 1`).get(txInfo.fullText);
      if (same) {
        if (isNeutralMerchant(same.merchant) && !isNeutralMerchant(txInfo.merchant)) {
          db.prepare(`UPDATE transactions SET merchant = ?, category = ?, account = ? WHERE id = ?`)
            .run(txInfo.merchant, txInfo.category, txInfo.account, same.id);
          return { ok: true, upgraded: true };
        }
        return { ok: true, duplicate: true };
      }
    }
    const norm = normalizeAccount(txInfo.account);
    const rows = db.prepare(`
      SELECT id, merchant, account, created_at FROM transactions
      WHERE type = ? AND abs(amount - ?) < 0.005 AND abs(created_at - ?) <= 180000
    `).all(txInfo.type, txInfo.amount, at);
    for (const r of rows) {
      const ra = normalizeAccount(r.account);
      if (ra !== norm && !ra.startsWith(norm) && !norm.startsWith(ra)) continue;
      if (isNeutralMerchant(r.merchant) && !isNeutralMerchant(txInfo.merchant)) {
        db.prepare(`UPDATE transactions SET merchant = ?, category = ?, account = ?, full_text = ? WHERE id = ?`)
          .run(txInfo.merchant, txInfo.category, txInfo.account, txInfo.fullText, r.id);
        return { ok: true, upgraded: true };
      }
      return { ok: true, duplicate: true };
    }
    db.prepare(`
      INSERT INTO transactions (type, amount, merchant, category, account, full_text, created_at, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(txInfo.type, txInfo.amount, txInfo.merchant, txInfo.category, txInfo.account, txInfo.fullText, at, seq == null ? null : seq);
    return { ok: true, inserted: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function cleanStationName(s) {
  if (!s) return '快递驿站/柜';
  let str = s.replace(/^[：:\s\-，,]+/, '').trim();
  str = str.replace(/^.*?(?:已投递至|已存放至|已送达至|已到达|已送达|已送至|已到|已存入|已放至|到达|存放在|存放至|送达至|放入)/, '').trim();
  str = str.replace(/^[：:\s\-，,]+/, '').trim();
  return str || '快递驿站/柜';
}

function getNotificationBody(item) {
  if (!item) return '';
  const text = item.text || '';
  const big = item.bigText || '';
  const sub = item.subText || '';
  const ticker = item.ticker || '';
  let main = (big && big.length > text.length) ? big : (text || big || ticker);
  if (sub && !main.includes(sub) && sub.length < 50) {
    main = `${sub} ${main}`;
  }
  return main.trim();
}

// ⛔ 判断这条通知是不是我们自己发的 —— 防止「抓取 → 发通知 → 再抓自己」的反馈死循环。
// 背景（2026-10-15 实测）：守护进程抓到验证码后发通知
//   「⚡ 验证码已复制 / 已提取 X 验证码: <CODE> 并写入剪贴板」
// 这条正文里同时含「验证码」三个字和号码本身，下一轮会被自己重新抓一次 → 无限自我复制。
// 守护日志里同一秒刷出的多条 "捕获验证码: claude (来源: ⚡ 验证码已复制)" 就是这么来的。
// 「📦 新包裹到达 / 取件码: ...」与提取器的取件码规则同理。
const SELF_NOTIFY_TITLES = new Set([
  '⚡ 验证码已复制',
  '📦 新包裹到达',
  '⏰ 定时提醒',
  '☀️ DSH 晨间早报',
  '💾 时光机备份完成',
]);

function isSelfNotification(item) {
  if (!item) return false;
  // 主判据：notify 桥 3081 跑在本 App 进程内，它发的通知包名即本 App
  if (item.package === 'com.deepseek.harness') return true;
  // 兜底：万一拿不到包名，按自家通知标题精确匹配
  return SELF_NOTIFY_TITLES.has(String(item.title || '').trim());
}

const EXTRACTOR = {
  // --- A. 验证码提取 ---
  extractCode(fullText, title = '', pkg = '') {
    if (!fullText) return null;
    const text = `${title} ${fullText}`.trim();
    
    // 排除明显不是验证码的长篇通知
    if (text.includes('DSH 自检') || text.includes('引擎未运行')) return null;

    const keywords = /(验证码|校验码|动态码|确认码|安全码|安全代码|动态密码|授权码|动态口令|短信口令|口令|verification code|auth code|security code|code)/i;
    if (!keywords.test(text)) return null;

    // 来源识别
    let source = '短信';
    const tagMatch = text.match(/【(.*?)】|\[(.*?)\]/);
    if (tagMatch) {
      source = tagMatch[1] || tagMatch[2];
    } else if (pkg.includes('tencent.mm')) {
      source = '微信';
    } else if (pkg.includes('alipay')) {
      source = '支付宝';
    } else if (title && !title.includes('短信')) {
      source = title;
    }

    // 1. Google 格式 (如 "G-123456 是您的 Google 验证码")
    const googleMatch = text.match(/\b(G-[0-9]{6})\b/i);
    if (googleMatch) {
      return { code: googleMatch[1].toUpperCase(), source, fullText: text };
    }

    // 2. Microsoft / 国际格式 (如 "使用 123456 作为 Microsoft 账户安全代码")
    const useMatch = text.match(/(?:使用|use)\s*([0-9A-Za-z]{4,8})\s*(?:作为|进行|验证|登录|as)/i);
    if (useMatch && !isExcludedCode(useMatch[1])) {
      return { code: useMatch[1], source, fullText: text };
    }

    // 3. 带连接符或空格的 6 位数 (如 "492-108", "192 830")
    const splitCodeMatch = text.match(/(?:验证码|校验码|动态码|动态密码|code|Code)[：:\s为是]*([0-9]{3}[\s\-][0-9]{3})/i);
    if (splitCodeMatch) {
      const rawCode = splitCodeMatch[1].replace(/[\s\-]/g, '');
      if (!isExcludedCode(rawCode)) {
        return { code: rawCode, source, fullText: text };
      }
    }

    // 4. 关键词后跟代码 (支持全角冒号 ：、半角冒号 :、等号 =、空格、括号、为、是)
    const afterKw = text.match(/(?:验证码|校验码|动态码|确认码|安全码|安全代码|动态密码|授权码|动态口令|短信口令|口令|verification code|auth code|security code|code|Code)(?:为|是|is|：|:|=|\s|\[|【|\(|\s)+([0-9A-Za-z]{4,8})/i);
    if (afterKw && !isExcludedCode(afterKw[1])) {
      return { code: afterKw[1], source, fullText: text };
    }

    // 5. 代码在前，关键词在后 (如 "829103 是您的验证码" / "829103(验证码)" / "[901245] 动态码")
    const beforeKw = text.match(/([0-9A-Za-z]{4,8})(?:\s|\[|【|\(|\)|）|（|\]|】)*(?:为|是)?(?:您的|本次)?(?:登录|操作)?(?:验证码|校验码|动态码|动态密码|确认码|安全码|安全代码|动态口令|短信口令|口令)/);
    if (beforeKw && !isExcludedCode(beforeKw[1])) {
      return { code: beforeKw[1], source, fullText: text };
    }

    // 6. 凭 123456 登录/验证
    const pingMatch = text.match(/凭\s*([0-9A-Za-z]{4,8})\s*(?:完成|进行|验证|登录|确认)/);
    if (pingMatch && !isExcludedCode(pingMatch[1])) {
      return { code: pingMatch[1], source, fullText: text };
    }

    // 7. 兜底提取独立的 4~6 位纯数字，伴随有效时间/勿泄露提示
    const hasValidHint = /(分钟|有效|勿泄露|切勿告知|不要告诉|请勿将|请勿泄露)/.test(text);
    if (hasValidHint) {
      const numbers = text.match(/\b([0-9]{4,8})\b/g);
      if (numbers) {
        for (const num of numbers) {
          if (!isExcludedCode(num)) {
            return { code: num, source, fullText: text };
          }
        }
      }
    }

    return null;
  },

  // --- B. 动账记账提取 ---
  extractTransaction(fullText, title = '', pkg = '') {
    if (!fullText) return null;
    const text = `${title} ${fullText}`.trim();

    // 1. 微信支付
    if (pkg.includes('tencent.mm') || text.includes('微信支付') || text.includes('微信转账')) {
      // 退款
      const refMatch = text.match(/(?:退款成功|退款到账|已退款|退还)[：:\s\n]*.*?￥?\s*([\d\.,]+)/);
      if (refMatch && (text.includes('退款') || text.includes('退还'))) {
        const amount = parseFloat(refMatch[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          let merchant = '微信退款';
          const merchMatch = text.match(/(?:商户全称|商户名称|来自|收款方)[：:\s]*([^\s,，。]+)/);
          if (merchMatch) merchant = cleanMerchantName(merchMatch[1]) + '(退款)';
          return {
            type: 'income',
            amount,
            merchant,
            category: '退款',
            account: '微信支付',
            fullText: text
          };
        }
      }

      // 收入/转账到账
      const incMatch = text.match(/(?:收款金额|转账金额|收到转账|到账|收入|赞赏收款)[：:\s]*￥?\s*([\d\.,]+)/);
      if (incMatch && !text.includes('支付金额') && !text.includes('付款金额') && !text.includes('支出')) {
        const amount = parseFloat(incMatch[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          return {
            type: 'income',
            amount,
            merchant: '微信转账/收款',
            category: '收入',
            account: '微信支付',
            fullText: text
          };
        }
      }
      // 支出
      const expMatch = text.match(/(?:支付金额|付款金额|消费金额|交易金额|已支付|支付成功|付款成功|支出|扣款)[：:\s]*(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)/);
      if (expMatch) {
        const amount = parseFloat(expMatch[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          let merchant = '微信商户';
          const merchMatch = text.match(/(?:商户全称|收款方|商户名称|付款给)[：:\s]*([^\s,，。]+)/)
            || text.match(/向\s*([^\s,，。]{2,30}?)\s*(?:付款|支付|转账)/);
          if (merchMatch) { const c = cleanMerchantName(merchMatch[1]); if (!isJunkMerchant(c)) merchant = c; }
          return {
            type: 'expense',
            amount,
            merchant,
            category: guessCategory(merchant, text),
            account: '微信支付',
            fullText: text
          };
        }
      }
    }

    // 2. 支付宝（带【XX银行】标记的是银行短信，交给下面的银行分支，别抢）
    if (!/【[^】]*银行[^】]*】/.test(text) && (pkg.includes('alipay') || text.includes('支付宝'))) {
      // 退款
      const refMatch = text.match(/(?:收到退款|退款成功|退款到账|退款金额)[：:\s\n]*.*?￥?\s*([\d\.,]+)\s*元?/);
      if (refMatch && (text.includes('退款') || text.includes('退还'))) {
        const amount = parseFloat(refMatch[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          let merchant = '支付宝退款';
          const merchMatch = text.match(/(?:退款来自|商户|来自)[：:\s]*([^\s,，。]+)/);
          if (merchMatch) merchant = cleanMerchantName(merchMatch[1]) + '(退款)';
          return {
            type: 'income',
            amount,
            merchant,
            category: '退款',
            account: '支付宝',
            fullText: text
          };
        }
      }

      // 支出
      const expMatch = text.match(/(?:成功付款|付款成功|已付款|付款|支付成功|已支付|支出|支付|消费|扣款|还款)[：:\s]*(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)\s*元?/);
      if (expMatch) {
        const amount = parseFloat(expMatch[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          let merchant = '支付宝商户';
          const merchMatch = text.match(/(?:付款给|商户名称|商户|收款人|收款方)[：:\s]*([^\s,，。]+)/)
            || text.match(/向\s*([^\s,，。]{2,30}?)\s*(?:付款|支付|转账)/);
          if (merchMatch) { const c = cleanMerchantName(merchMatch[1]); if (!isJunkMerchant(c)) merchant = c; }
          return {
            type: 'expense',
            amount,
            merchant,
            category: guessCategory(merchant, text),
            account: '支付宝',
            fullText: text
          };
        }
      }
      // 收入
      const incMatch = text.match(/(?:收到一笔转账|成功收款|转账到账|收到转账)[：:\s]*￥?\s*([\d\.,]+)\s*元?/);
      if (incMatch) {
        const amount = parseFloat(incMatch[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          return {
            type: 'income',
            amount,
            merchant: '支付宝收款',
            category: '收入',
            account: '支付宝',
            fullText: text
          };
        }
      }
    }

    // 3. 各大银行动账与云闪付 (招商/工商/建设/农行/中行/交通/中信/浦发/广发/平安/邮储/云闪付/银联等)
    const isBank = /(银行|信用卡|储蓄卡|借记卡|贷记卡|支行|农信|农商|信用社|云闪付|银联|农行|工行|建行|中行|招行|交行|邮储)/.test(text);
    if (isBank) {
      let account = '银行卡';
      const cardMatch = text.match(/尾号\s*为?\s*([0-9]{4})/);
      const bankTag = text.match(/【(.*?)】/);
      if (bankTag) {
        account = bankTag[1];
      } else {
        const bankNameMatch = text.match(/(中国农业银行|农业银行|中国建设银行|建设银行|中国工商银行|工商银行|中国银行|招商银行|交通银行|邮政储蓄银行|邮储银行|中信银行|浦发银行|兴业银行|民生银行|光大银行|华夏银行|广发银行|平安银行|浙商银行|宁波银行|北京银行|上海银行|云闪付|银联)/);
        if (bankNameMatch) account = bankNameMatch[1];
      }
      if (cardMatch && !account.includes(cardMatch[1])) account += `(${cardMatch[1]})`;

      // 方向与金额：先认带正负号的金额（最可靠），再认方向词。
      // 老版本只找「-金额」，所以「人民币+1500.00」这种收入模板一条都记不上 → 收入恒为 0。
      const signedMatch = text.match(/(?:人民币|RMB|￥|¥)\s*([+\-－])\s*([\d,]+(?:\.\d{1,2})?)/);
      let signedAmount = null, signedSign = null;
      if (signedMatch) {
        const v = parseFloat(signedMatch[2].replace(/,/g, ''));
        if (isFinite(v) && v > 0) { signedAmount = v; signedSign = signedMatch[1] === '-' ? '-' : '+'; }
      }

      const expenseWord = /(支出|消费|扣款|转出|取现|网上支付|快捷支付|付款)/.test(text);
      // ⚠️ 2026-10-15：农行「完成银联入账交易人民币63.60」这类模板整条认不出来（方向词表里只有
      //    「到账/转入/存入」，缺「入账」）→ extractTransaction 返回 null，进账静默丢失（收入恒为 0）。
      const incomeWord = /(存入|收入|转入|代发|到账|结息|汇入|退款|退汇|利息|工资|入账|入帐|转存)/.test(text);

      let txAmount = null, txIsIncome = false;
      if (signedSign) {
        txAmount = signedAmount;
        txIsIncome = signedSign === '+';
      } else if (expenseWord) {
        const m = text.match(/(?:支出|消费|扣款|转出|取现|网上支付|快捷支付|付款)(?:人民币|RMB|￥|¥)?\s*([\d,]+(?:\.\d{1,2})?)\s*元?/);
        if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (isFinite(v) && v > 0) { txAmount = v; txIsIncome = false; } }
      }
      if (txAmount === null && incomeWord) {
        // 三层：① 方向词紧邻金额；② 中间允许夹「交易/金额/到账」等字样（"入账交易人民币63.60"）；
        // ③ 兜底取第一个「人民币/￥/¥ + 数字」—— 此时方向已由 incomeWord 定死，而余额数字前面
        //    通常是"余额"不是"人民币"，所以兜底不会误取余额。
        const incWord = '(?:存入|收入|转入|代发|到账|结息|汇入|入账|入帐|转存)';
        const incFiller = '(?:工资|款项|款|人民币|RMB|￥|¥|交易|金额|到账|入账|转存|[\\s：:，,]*)';
        const m = text.match(new RegExp(incWord + incFiller + '*?\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s*元?'))
          || text.match(/(?:人民币|RMB|￥|¥)\s*([\d,]+(?:\.\d{1,2})?)/);
        if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (isFinite(v) && v > 0) { txAmount = v; txIsIncome = true; } }
      }

      if (txAmount !== null) {
        let merchant = txIsIncome ? '银行转入/代发' : '银行消费';
        const merchTagMatch = text.match(/(?:商户为|商户[：:\s]+)\s*([^\s,，。]+)/);
        const merchMatch = text.match(/(?:在|于|向)\s*([^\s,，。]{2,30}?)\s*(?:完成|消费|支出|扣款|支付|转账|扣收|付款)/);
        // 进账模板「王金鑫于10月15日19:19向您尾号0770账户完成银联入账」里，上一条规则会抓到
        // 「您尾号0770账户」这种垃圾商户，所以优先认「某人于 M月D日…」里的付款人。
        const payerMatch = txIsIncome ? text.match(/([^\s,，。【】]{2,20}?)于\s*\d{1,2}月\d{1,2}日/) : null;
        const cand = payerMatch ? payerMatch[1] : (merchTagMatch ? merchTagMatch[1] : (merchMatch ? merchMatch[1] : null));
        const cleaned = cand ? cleanMerchantName(cand) : null;
        if (cleaned && !isJunkMerchant(cleaned)) merchant = cleaned;
        return {
          type: txIsIncome ? 'income' : 'expense',
          amount: txAmount,
          merchant,
          category: txIsIncome ? '收入' : guessCategory(merchant, text),
          account,
          fullText: text
        };
      }
    }

    return null;
  },

  // --- B2. 余额提取 ---
  // 只认「余额 / 可用余额 / 账户余额」后面紧跟的数字，不碰交易金额；
  // 认不出来就返回 null（宁可没有，也不猜一个错的余额）。
  extractBalance(fullText) {
    if (!fullText) return null;
    const text = String(fullText).replace(/\s+/g, ' ');
    const m = text.match(/(?:可用余额|账户余额|当前余额|卡内余额|余额为|余额)[：:]?\s*[¥￥]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
    if (!m) return null;
    const amount = parseFloat(String(m[1]).replace(/,/g, ''));
    if (!isFinite(amount) || amount < 0) return null;
    return amount;
  },

  // --- C. 快递取件码提取 ---
  extractPackage(fullText, title = '', pkg = '') {
    if (!fullText) return null;
    const body = fullText.trim();
    const text = `${title} ${body}`.trim();

    const pkgKeywords = /(取件码|凭取件码|提货码|自提码|取件凭条|丰巢|菜鸟|兔喜|妈妈驿站|快宝|格格|近邻宝|驿站|快递柜|自提柜|快件已送达|快递已到达|放入快递柜|包裹已送达)/;
    if (!pkgKeywords.test(text)) return null;

    // 1. 取件码提取
    let pickup_code = null;
    const hyphenCode = text.match(/\b([A-Za-z0-9]+-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\b/);
    if (hyphenCode) {
      pickup_code = hyphenCode[1];
    } else {
      const codeMatch = text.match(/(?:取件码|提货码|自提码|密码|凭码|凭|提货|取件|自提)(?:为|是|：|:|=|\s|\[|【|\(|\s)*([A-Za-z0-9]{4,8})/);
      if (codeMatch && !isExcludedCode(codeMatch[1])) {
        pickup_code = codeMatch[1];
      }
    }
    if (!pickup_code) return null;

    // 2. 快递公司提取
    let carrier = '快递';
    const carrierMatch = text.match(/(顺丰|中通|圆通|申通|韵达|极兔|京东|邮政|EMS|德邦|丹鸟|丰网)/);
    if (carrierMatch) carrier = carrierMatch[1];

    // 3. 驿站/柜机位置提取（优先在正文 body 中匹配详细地址）
    let station = '快递驿站/柜';
    const cleanBody = body.replace(/【.*?】|\[.*?\]/g, ' ');
    const stationMatch = cleanBody.match(/([^\s,，。]{2,20}?(?:丰巢柜|丰巢快递柜|丰巢智能柜|菜鸟驿站|兔喜生活超市[^\s,，。]*|兔喜生活|妈妈驿站|快宝驿站|格格快递柜|近邻宝|快递柜|自提柜|代收点|物业服务中心|物业|驿站|超市))/);
    if (stationMatch) {
      station = cleanStationName(stationMatch[1]);
    } else {
      const genericMatch = text.match(/(菜鸟驿站|丰巢快递柜|丰巢智能柜|丰巢柜|兔喜生活|兔喜|妈妈驿站|顺丰速运|京东派|物业服务中心)/);
      if (genericMatch) station = cleanStationName(genericMatch[1]);
    }

    return {
      pickup_code,
      station,
      carrier,
      fullText: text
    };
  }
};

// 排除误判代码（年份、纯常见格式等）
function isExcludedCode(str) {
  if (!str) return true;
  if (/^(2024|2025|2026|2027|2028|10086|10010|10000|95588|95533|95566|95555|95599)$/.test(str)) return true;
  if (/^1[3-9]\d{9}$/.test(str)) return true;
  // 纯字母串不是验证码（如模型名 "claude"、"deepseek" 等会被误捕）
  if (/^[a-zA-Z]+$/.test(str)) return true;
  return false;
}

// 智能分类启发式匹配
function guessCategory(merchant = '', fullText = '') {
  const s = `${merchant} ${fullText}`.toLowerCase();
  if (/(退款)/.test(s)) return '退款';
  if (/(外卖|美团|饿了么|麦当劳|肯德基|必胜客|瑞幸|星巴克|喜茶|奈雪|霸王茶姬|茶百道|蜜雪冰城|奶茶|餐饮|饭店|面馆|小吃|食堂|伙食|咖啡|超市|便利店|烘焙|火锅|海底捞|烧烤|烤肉|汉堡|披萨|全家|罗森|7-11|7-eleven|美宜佳)/.test(s)) return '餐饮';
  if (/(淘宝|京东|拼多多|天猫|得物|唯品会|服装|数码|商场|购物|超市|便利店)/.test(s)) return '购物';
  if (/(滴滴|高德|花小猪|t3|打车|出租车|地铁|公交|火车|机票|12306|铁路|加油|中石化|中石油|停车|etc|出行)/.test(s)) return '交通';
  if (/(房租|物业|电费|水费|燃气|宽带|话费|充值|中国移动|中国联通|中国电信)/.test(s)) return '居住生活';
  if (/(影院|电影|淘票票|猫眼|游戏|网易|腾讯充值|米哈游|steam|b站|哔哩哔哩|爱奇艺|优酷|腾讯视频|会员|娱乐)/.test(s)) return '休闲娱乐';
  if (/(医院|药房|药店|门诊|挂号|诊所)/.test(s)) return '医疗健康';
  if (/(理财|基金|证券|股票|保险|利息|还款|借呗|微粒贷)/.test(s)) return '金融理财';
  return '其他消费';
}

// ==================== 4. 定时调度器 (Cron Engine) ====================

class CronScheduler {
  constructor(db) {
    this.db = db;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._scheduleNextTick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _scheduleNextTick() {
    if (!this.running) return;
    // 每 15 秒轮询一次任务到期状态
    this.timer = setTimeout(async () => {
      try {
        await this.checkAndRunTasks();
      } catch (err) {
        logMessage(`[Cron] 调度检查异常: ${err.message}`);
      }
      this._scheduleNextTick();
    }, 15000);
  }

  async checkAndRunTasks() {
    const now = Date.now();
    const tasks = this.db.prepare(`
      SELECT * FROM scheduled_tasks 
      WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
    `).all(now);

    for (const task of tasks) {
      logMessage(`[Cron] 触发定时任务: [${task.id}] ${task.name}`);
      let status = 'success';
      try {
        if (task.action_type === 'cmd') {
          execSync(task.action_payload, { stdio: 'ignore', timeout: 60000, shell: '/system/bin/sh' });
        } else if (task.action_type === 'notify') {
          await sendNotification('⏰ 定时提醒', task.action_payload);
        } else if (task.action_type === 'builtin') {
          await this.runBuiltinTask(task.action_payload);
        }
      } catch (e) {
        status = `error: ${e.message}`;
        logMessage(`[Cron] 任务 [${task.id}] 执行失败: ${e.message}`);
      }

      // 计算下一次执行时间
      const nextRun = computeNextRun(task.cron_expr, now);
      this.db.prepare(`
        UPDATE scheduled_tasks 
        SET last_run_at = ?, last_status = ?, next_run_at = ?
        WHERE id = ?
      `).run(now, status, nextRun, task.id);

      // 若有 Android 闹钟桥，注册下一次
      // ⛔ 守护心跳例外：这条通道**不带 lifeTaskId**，装机版本会把它当普通任务提交给 AI
      //    （命中一次 = 一个完整付费会话），而心跳的本意是「零 token 的本地 tick」。
      //    心跳只允许由 armWatchdog() 用 lifeTaskId 显式排（且默认关闭）。
      //    2026-10-15 13:18:03 实测：daemon_watchdog（interval:1h）由**这里**每小时排一个真闹钟，
      //    绕过了 armWatchdog 的开关 —— 当时只验了那道闸，漏了这条。
      // ⛔ 而且：builtin / cmd / notify 这三种**守护进程自己就能执行**（免费，见下面 runBuiltinTask
      //    和上面的 execSync/sendNotification），根本不需要叫 AI。给它们排闹钟只会得到
      //    「把任务名当用户消息提交给 AI」= 白花一个完整会话（用户 2026-10-15 确认去掉这一路）。
      //    本地执行不受影响：cron 表里的行照旧被守护进程按点跑。
      const localRun = ['builtin', 'cmd', 'notify'].includes(task.action_type);
      if (nextRun && !localRun && task.id !== WATCHDOG_ID) {
        const diffSec = Math.max(10, Math.round((nextRun - Date.now()) / 1000));
        httpPostJson(`${BRIDGE_3081}/schedule`, {
          text: `DSH 任务: ${task.name}`,
          when: String(diffSec),
          repeat: 'once'
        }).catch(() => {});
      }
    }
  }

  async runBuiltinTask(action) {
    if (action === 'morning_brief') {
      // 统计今日未取快递和重要提醒
      const pkgs = this.db.prepare(`SELECT * FROM packages WHERE status = 'pending'`).all();
      let text = '☀️ 早上好！';
      if (pkgs.length > 0) {
        text += `\n📦 待取包裹 (${pkgs.length}件): ` + pkgs.map(p => `[${p.pickup_code}] ${p.station}`).join('; ');
      } else {
        text += '\n📦 暂无待取包裹。';
      }
      await sendNotification('☀️ DSH 晨间早报', text);
    } else if (action === 'daily_reap' || action === 'memory_reap') {
      // 整理记忆库
      try {
        execSync('node /sdcard/DeepSeekHarness/tools/mem.js reap --apply', { stdio: 'ignore', shell: '/system/bin/sh' });
        logMessage('[Cron] 记忆库每日清理完成 (mem.js reap)');
      } catch (_) {}
    } else if (action === 'weekly_backup' || action === 'backup') {
      // 时光机备份
      try {
        execSync('node /sdcard/DeepSeekHarness/tools/backup.mjs', { stdio: 'ignore', shell: '/system/bin/sh' });
        logMessage('[Cron] 时光机全站备份完成 (backup.mjs)');
        await sendNotification('💾 时光机备份完成', '已完成每周全站自动快照备份');
      } catch (err) {
        logMessage(`[Cron] 自动备份失败: ${err.message}`);
      }
    }
  }
}

// ==================== 6.5 智能生活情境中枢 (Scene Engine) ====================

const SCENE_ENGINE = {
  initDefaultScenes(db) {
    const defaults = [
      {
        id: 'morning_brief',
        name: '☀️ 晨间生活早报',
        type: 'brief',
        description: '早晨自动汇总待取包裹、今日记账预算、活跃自动化任务与重要提示',
        config_json: JSON.stringify({ notify: true, copy: false }),
        enabled: 1
      },
      {
        id: 'night_recap',
        name: '🌙 晚间收支与复盘',
        type: 'recap',
        description: '晚间自动汇总今日总支出分类明细、未取包裹强提醒与待办总结',
        config_json: JSON.stringify({ notify: true, copy: false }),
        enabled: 1
      },
      {
        id: 'power_scene',
        name: '⚡ 充电与晚安联动',
        type: 'trigger',
        description: '夜间接入充电器时自动触发晚间复盘与静音关怀',
        config_json: JSON.stringify({ notify: true, min_hour: 22 }),
        enabled: 1
      },
      {
        id: 'focus_work',
        name: '🎯 专注工作模式',
        type: 'trigger',
        description: '快速进入免打扰，归纳未处理验证码与任务',
        config_json: JSON.stringify({ notify: false }),
        enabled: 1
      }
    ];

    const insert = db.prepare(`
      INSERT OR IGNORE INTO scenes (id, name, type, description, config_json, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    for (const sc of defaults) {
      insert.run(sc.id, sc.name, sc.type, sc.description, sc.config_json, sc.enabled, now);
    }
  },

  generateMorningBrief(db) {
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 星期${weekdays[now.getDay()]}`;

    const pkgs = db.prepare(`SELECT pickup_code, station, carrier FROM packages WHERE status = 'pending' ORDER BY id DESC`).all();
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const billStats = db.prepare(`
      SELECT 
        SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_exp,
        SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_inc
      FROM transactions WHERE created_at >= ?
    `).get(todayStart);

    const activeTasks = db.prepare(`SELECT name, cron_expr FROM scheduled_tasks WHERE enabled = 1`).all();
    const recentCode = db.prepare(`SELECT code, source, created_at FROM verification_codes ORDER BY id DESC LIMIT 1`).get();

    let lines = [];
    lines.push(`☀️ 早安！今天是 ${dateStr}`);
    
    if (pkgs.length > 0) {
      lines.push(`📦 待取包裹 (${pkgs.length} 件): ` + pkgs.map(p => `[${p.pickup_code}] ${p.station || p.carrier || '驿站'}`).join('；'));
    } else {
      lines.push(`📦 快递包裹：当前暂无待取快递`);
    }

    const exp = (billStats && billStats.total_exp) || 0;
    lines.push(`💰 今日消费：¥${exp.toFixed(2)}` + (exp > 0 ? '（已有记账流水）' : '（今日尚未产生支出）'));

    if (activeTasks.length > 0) {
      lines.push(`⏰ 活跃自动化：${activeTasks.length} 项守护中（${activeTasks.slice(0, 3).map(t => t.name).join('、')}）`);
    }

    if (recentCode && (Date.now() - recentCode.created_at < 30 * 60 * 1000)) {
      lines.push(`📱 最近验证码：[${recentCode.code}] 来自 ${recentCode.source || '短信'}`);
    }

    lines.push(`💡 DSH 智能中枢全天候守护中，祝你今天拥有高效充实的一天！`);

    const summary = `早安！${pkgs.length > 0 ? `有 ${pkgs.length} 件包裹待取` : '今日一切就绪'}`;
    const content = lines.join('\n');

    return {
      title: '☀️ DSH 晨间生活早报',
      summary,
      content,
      generated_at: Date.now(),
      data: {
        dateStr,
        pendingPackageCount: pkgs.length,
        todayExpense: exp,
        activeTaskCount: activeTasks.length
      }
    };
  },

  generateNightRecap(db) {
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const dateStr = `${now.getMonth() + 1}月${now.getDate()}日 星期${weekdays[now.getDay()]}`;

    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    const txs = db.prepare(`
      SELECT type, amount, merchant, category, account FROM transactions 
      WHERE created_at >= ? ORDER BY id ASC
    `).all(todayStart);

    let totalExp = 0;
    let totalInc = 0;
    const catMap = {};
    for (const t of txs) {
      if (t.type === 'expense') {
        totalExp += t.amount;
        const cat = t.category || '其它支出';
        catMap[cat] = (catMap[cat] || 0) + t.amount;
      } else if (t.type === 'income') {
        totalInc += t.amount;
      }
    }

    const pkgs = db.prepare(`SELECT pickup_code, station FROM packages WHERE status = 'pending'`).all();

    let lines = [];
    lines.push(`🌙 晚间复盘 · ${dateStr}`);
    lines.push(`💰 今日总支出：¥${totalExp.toFixed(2)} | 总收入：¥${totalInc.toFixed(2)}`);

    const catKeys = Object.keys(catMap);
    if (catKeys.length > 0) {
      const catDetails = catKeys.map(k => `${k}: ¥${catMap[k].toFixed(2)}`).join('，');
      lines.push(`   📊 分类明细：${catDetails}`);
    } else {
      lines.push(`   📊 今日没有产生记账流水`);
    }

    if (pkgs.length > 0) {
      lines.push(`⚠️ 未取包裹强提醒：仍有 ${pkgs.length} 件包裹未取！` + pkgs.map(p => `[${p.pickup_code}]`).join(' '));
    } else {
      lines.push(`📦 今日快递已全部取清`);
    }

    lines.push(`⏰ 定时中枢已完成今日调度。请早点休息，晚安！`);

    const summary = `今日支出 ¥${totalExp.toFixed(2)}${pkgs.length > 0 ? ` · ⚠️ 剩 ${pkgs.length} 件快递` : ''}`;
    const content = lines.join('\n');

    return {
      title: '🌙 DSH 晚间收支复盘',
      summary,
      content,
      generated_at: Date.now(),
      data: {
        dateStr,
        totalExpense: totalExp,
        totalIncome: totalInc,
        categories: catMap,
        pendingPackages: pkgs.length
      }
    };
  },

  async triggerScene(db, sceneId, options = {}) {
    this.initDefaultScenes(db);
    const scene = db.prepare(`SELECT * FROM scenes WHERE id = ?`).get(sceneId);
    if (!scene) {
      return { ok: false, msg: `未知情景: ${sceneId}` };
    }

    let briefResult;
    if (sceneId === 'morning_brief') {
      briefResult = this.generateMorningBrief(db);
    } else if (sceneId === 'night_recap') {
      briefResult = this.generateNightRecap(db);
    } else {
      briefResult = {
        title: scene.name,
        summary: `已触发情景: ${scene.name}`,
        content: scene.description || `情景 [${scene.name}] 触发执行完成。`,
        generated_at: Date.now(),
        data: {}
      };
    }

    // 记录日志
    const now = Date.now();
    db.prepare(`
      INSERT INTO scene_logs (scene_id, summary, content, triggered_at)
      VALUES (?, ?, ?, ?)
    `).run(sceneId, briefResult.summary, briefResult.content, now);

    db.prepare(`UPDATE scenes SET last_triggered_at = ? WHERE id = ?`).run(now, sceneId);

    // 发送系统通知
    if (options.notify !== false) {
      await sendNotification(briefResult.title, briefResult.content);
    }

    return {
      ok: true,
      msg: `情景 [${scene.name}] 触发成功`,
      scene,
      result: briefResult
    };
  }
};

// 计算下一次触发时间 (支持 daily:HH:mm, interval:Xm/Xh, 5-part cron)
function computeNextRun(expr, now = Date.now()) {
  if (!expr) return null;
  const d = new Date(now);

  // 1. daily:HH:mm (如 daily:08:30)
  if (expr.startsWith('daily:')) {
    const [h, m] = expr.replace('daily:', '').split(':').map(Number);
    const target = new Date(d);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= now) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  // 2. interval:Xm / interval:Xh
  if (expr.startsWith('interval:')) {
    const val = expr.replace('interval:', '');
    if (val.endsWith('m')) {
      const min = parseInt(val, 10) || 30;
      return now + min * 60 * 1000;
    }
    if (val.endsWith('h')) {
      const hr = parseInt(val, 10) || 1;
      return now + hr * 3600 * 1000;
    }
  }

  // 3. 简易 5 段 Cron (分 时 日 月 周)
  const parts = expr.trim().split(/\s+/);
  if (parts.length === 5) {
    const [minStr, hourStr] = parts;
    if (minStr.startsWith('*/')) {
      const step = parseInt(minStr.replace('*/', ''), 10) || 5;
      return now + step * 60 * 1000;
    }
    if (!isNaN(minStr) && !isNaN(hourStr)) {
      const target = new Date(d);
      target.setHours(Number(hourStr), Number(minStr), 0, 0);
      if (target.getTime() <= now) {
        target.setDate(target.getDate() + 1);
      }
      return target.getTime();
    }
  }

  // 默认 1 小时后
  return now + 3600 * 1000;
}

// ==================== 5. 后台守护进程核心逻辑 ====================

function logMessage(msg) {
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const line = `[${time}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  if (process.env.DSH_LIFE_FOREGROUND) {
    process.stdout.write(line);
  }
}

/**
 * 确保守护进程在跑；不在就 detached 拉起。
 * 所有保活入口（CLI `tick` / 开机自检 selfcheck.sh / 引擎插件）都走这一条，
 * 避免每个入口各写一份判断（三份 life.js 的教训就在这）。
 *
 * 判断依据只有 PID 文件 + `process.kill(pid,0)`；心跳年龄只用于**报告**，
 * 不拿它去拉起第二个守护 —— 万一误判就会双份记账，代价比晚发现更大。
 */
function ensureDaemonRunning() {
  let pid = '';
  let alive = false;
  if (fs.existsSync(PID_FILE)) {
    pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
    try { process.kill(Number(pid), 0); alive = true; } catch (_) { alive = false; }
  }

  let beatAge = null;
  try {
    const db = openDB();
    const row = db.prepare(`SELECT value FROM daemon_state WHERE key = 'last_beat'`).get();
    if (row && row.value) beatAge = Date.now() - Number(row.value);
    db.close();
  } catch (_) {}

  if (alive) {
    const note = beatAge === null
      ? 'PID 存活（无心跳记录，可能是升级前的旧守护）'
      : beatAge > 120000
        ? `⚠️ PID 存活但心跳停了 ${Math.round(beatAge / 1000)}s（可能卡死，先观察）`
        : `心跳在 ${Math.round(beatAge / 1000)}s 前`;
    return { alive: true, pid, spawned: false, beatAge, note };
  }

  const child = spawn(process.execPath, [__filename, '__run_daemon'], { detached: true, stdio: 'ignore' });
  child.unref();
  return { alive: false, pid, spawned: true, newPid: child.pid, beatAge, note: `原 PID 文件内容: ${pid || '无'}` };
}

async function runDaemon() {
  logMessage('>>> DSH Life & Notification Hub 守护进程已启动 <<<');
  fs.writeFileSync(PID_FILE, String(process.pid));

  const db = openDB();
  const scheduler = new CronScheduler(db);
  scheduler.start();

  // 恢复上次处理的通知 seq
  let lastSeq = 0;
  try {
    const row = db.prepare(`SELECT value FROM daemon_state WHERE key = 'last_seq'`).get();
    if (row && row.value) lastSeq = parseInt(row.value, 10) || 0;
  } catch (_) {}

  // 首次拉取先对齐当前最大 seq，避免处理历史重复通知
  const status = await httpGetJson(`${BRIDGE_3181}/notifications-status`);
  if (status.ok && status.seq) {
    if (lastSeq === 0) lastSeq = status.seq;
    else if (status.seq < lastSeq) {
      // App 重启后桥的 seq 计数器从 1 重来（内存缓冲也清空），旧高水位会让监听**永久瞎掉**：
      // 用 since=903 去要，而新通知编号只有 1..N，永远要不回任何东西。
      // 2026-10-15 实测踩到：守护记到 903、桥已归零到 9 → 记账/验证码/快递全停。
      logMessage(`[Notification] 桥的 seq 归零（App 重启过）：高水位 ${lastSeq} → ${status.seq}，重置为 0 重放缓冲`);
      lastSeq = 0;
    }
  }

  logMessage(`[Notification] 正在监听系统通知流 (起始 seq: ${lastSeq})...`);

  // 「心跳」：只写 daemon_state.last_beat。
  // 为什么需要它：只看 PID 文件分不清「守护在跑」和「PID 被别的进程复用 / 进程卡死」。
  // 有了心跳，外部（life.js tick / selfcheck）能判断它是不是真的在动。
  let lastBeatAt = 0;

  // 主事件循环（长轮询通知）
  while (true) {
    try {
      const nowMs = Date.now();
      if (nowMs - lastBeatAt > 30000) {
        lastBeatAt = nowMs;
        try {
          db.prepare(`INSERT OR REPLACE INTO daemon_state (key, value) VALUES ('last_beat', ?)`).run(String(nowMs));
        } catch (_) {}
      }
      // 阻塞等待新通知（超时 15 秒返回）
      const res = await httpGetJson(`${BRIDGE_3181}/notifications-wait?since=${lastSeq}&timeout=15`);
      // 长轮询空转时体检一次：高水位可能因为这次循环期间 App 重启而变成黑洞
      if (lastSeq > 0 && (!res.items || res.items.length === 0)) {
        const st = await httpGetJson(`${BRIDGE_3181}/notifications-status`);
        if (st.ok && typeof st.seq === 'number' && st.seq < lastSeq) {
          logMessage(`[Notification] 桥的 seq 归零（App 重启过）：高水位 ${lastSeq} → ${st.seq}，重置为 0 重放缓冲`);
          lastSeq = 0;
          continue;
        }
      }
      if (res.ok && res.items && res.items.length > 0) {
        for (const item of res.items) {
          if (item.seq > lastSeq) lastSeq = item.seq;
          // 自家通知一律不处理（否则验证码/取件码通知会被自己反复抓取，无限刷屏）
          if (isSelfNotification(item)) continue;
          const bodyText = getNotificationBody(item);

          // 1. 验证码检测
          const codeInfo = EXTRACTOR.extractCode(bodyText, item.title, item.package);
          if (codeInfo && !textAlreadyStored(db, 'verification_codes', codeInfo.fullText)) {
            logMessage(`[Code] 🎯 捕获验证码: ${codeInfo.code} (来源: ${codeInfo.source})`);
            // 写入剪贴板
            await copyToClipboard(codeInfo.code);
            // 记录数据库
            db.prepare(`
              INSERT INTO verification_codes (code, source, full_text, created_at, auto_copied)
              VALUES (?, ?, ?, ?, 1)
            `).run(codeInfo.code, codeInfo.source, codeInfo.fullText, Date.now());
            // 弹窗提示
            await sendNotification('⚡ 验证码已复制', `已提取 ${codeInfo.source} 验证码: ${codeInfo.code} 并写入剪贴板`);
          }

          // 2. 动账记账检测
          const txInfo = EXTRACTOR.extractTransaction(bodyText, item.title, item.package);
          if (txInfo) {
            logMessage(`[Bill] 💰 记账: [${txInfo.type === 'expense' ? '支出' : '收入'}] ¥${txInfo.amount.toFixed(2)} (${txInfo.merchant} · ${txInfo.category})`);
            const _r = insertTransactionDedup(db, txInfo, item.seq, Date.now());
            if (_r.duplicate) logMessage(`[Bill] ⏭️ 跳过重复记账: ¥${txInfo.amount.toFixed(2)} (${txInfo.merchant})`);
            if (_r.upgraded) logMessage(`[Bill] ⬆️ 合并同笔记账: 补上商户 ${txInfo.merchant}`);
          }

          // 3. 快递取件码检测
          const pkgInfo = EXTRACTOR.extractPackage(bodyText, item.title, item.package);
          if (pkgInfo && !textAlreadyStored(db, 'packages', pkgInfo.fullText)) {
            logMessage(`[Package] 📦 快递取件码: [${pkgInfo.pickup_code}] (${pkgInfo.carrier} · ${pkgInfo.station})`);
            db.prepare(`
              INSERT INTO packages (pickup_code, station, carrier, full_text, created_at)
              VALUES (?, ?, ?, ?, ?)
            `).run(pkgInfo.pickup_code, pkgInfo.station, pkgInfo.carrier, pkgInfo.fullText, Date.now());
            await sendNotification('📦 新包裹到达', `取件码: ${pkgInfo.pickup_code} (${pkgInfo.station})`);
          }
        }

        // 记盘最新 seq
        db.prepare(`INSERT OR REPLACE INTO daemon_state (key, value) VALUES ('last_seq', ?)`).run(String(lastSeq));
      }
    } catch (err) {
      logMessage(`[Loop Error] ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ==================== 6. CLI 命令实现 ====================

function printHelp() {
  console.log(`
DSH Life & Notification Hub · 生活与通知中枢

使用方法:
  life status                      查看中枢守护运行状态与今日概况
  life daemon [start|stop|restart] 启动/停止/重启后台通知与定时守护
  life code [--last|--copy]        查看/复制最新捕获的验证码
  life bill [today|month|list]     查看账单流水与分类统计
  life bill add --amount 25 ...    手动记录一笔账单
  life pkg [list|pick <id>]        查看待取快递包裹 / 标记已取
  life cron [list|add|rm]          管理定时自动化任务
  life scan [N]                    回溯扫描最近 N 条历史通知并入库
`);
}

async function handleCLI() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';

  const db = openDB();

  switch (cmd) {
    case 'status': {
      let isRunning = false;
      let pid = null;
      if (fs.existsSync(PID_FILE)) {
        pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
        try {
          process.kill(Number(pid), 0);
          isRunning = true;
        } catch (_) {}
      }

      console.log(`\n=== 🌟 DSH Life Hub 状态概览 ===`);
      console.log(`守护进程: ${isRunning ? `✅ 运行中 (PID: ${pid})` : '⚪ 未运行 (执行 life daemon start 启动)'}`);
      console.log(`数据库:   ${DB_PATH}`);

      // 今日验证码
      const todayStart = new Date().setHours(0, 0, 0, 0);
      const codeCount = db.prepare(`SELECT count(*) as c FROM verification_codes WHERE created_at >= ?`).get(todayStart).c;
      const latestCode = db.prepare(`SELECT * FROM verification_codes ORDER BY id DESC LIMIT 1`).get();
      console.log(`\n【📱 验证码】今日捕获: ${codeCount} 条`);
      if (latestCode) {
        console.log(`  最新验证码: [${latestCode.code}] (来源: ${latestCode.source}, ${new Date(latestCode.created_at).toLocaleTimeString()})`);
      }

      // 今日收支
      const billStats = db.prepare(`
        SELECT 
          SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_exp,
          SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_inc
        FROM transactions WHERE created_at >= ?
      `).get(todayStart);
      console.log(`\n【💰 今日记账】`);
      console.log(`  支出: ¥${(billStats.total_exp || 0).toFixed(2)} | 收入: ¥${(billStats.total_inc || 0).toFixed(2)}`);

      // 待取快递
      const pendingPkgs = db.prepare(`SELECT * FROM packages WHERE status = 'pending' ORDER BY id DESC`).all();
      console.log(`\n【📦 待取快递】共 ${pendingPkgs.length} 件`);
      for (const p of pendingPkgs.slice(0, 5)) {
        console.log(`  • [${p.pickup_code}] ${p.carrier} - ${p.station}`);
      }

      // 定时任务
      const tasks = db.prepare(`SELECT count(*) as c FROM scheduled_tasks WHERE enabled = 1`).get().c;
      console.log(`\n【⏰ 定时任务】活跃任务: ${tasks} 项\n`);
      break;
    }

    // tick: 「保活」入口，给三处调用：Android 闹钟（新装机版本）、开机自检 selfcheck.sh、
    // 以及人工排障。守护进程挂掉时安卓端不会自己发现（10/9–10/15 就这样丢了 6 天的账），
    // 所以每次有人叫这条，就顺手确认一下守护还在不在。
    case 'tick': {
      const r = ensureDaemonRunning();
      if (r.alive) {
        console.log(`tick: 守护进程存活 (PID: ${r.pid}) — ${r.note}`);
      } else {
        console.log(`tick: 守护进程不在（${r.note}），已重新拉起 (PID: ${r.newPid})`);
      }
      const arm = await armWatchdog();
      if (arm && arm.skipped) console.log(`tick: 未排心跳 — ${arm.skipped}`);
      break;
    }

    // watchdog: 开关「闹钟心跳」这个**付费**保活通道（当前装机版本上每次 = 一个 AI 会话）。
    // 开关有两个动作：写/删开关文件（armWatchdog 认它），以及启/停 life.db 里的
    // daemon_watchdog 行（App 侧 ScheduleBridge.lifeEnabled 靠它放行 lifeTaskId 注册；
    // 但那一行是 interval:1h 的 cron，**必须停掉**，否则守护进程自己每小时排一个付费闹钟）。
    case 'watchdog': {
      const action = args[1] || 'status';
      if (action === 'on') {
        fs.mkdirSync(path.dirname(WATCHDOG_FLAG), { recursive: true });
        fs.writeFileSync(WATCHDOG_FLAG, new Date().toISOString() + '\n');
        try { db.prepare('UPDATE scheduled_tasks SET enabled = 1 WHERE id = ?').run(WATCHDOG_ID); } catch (_) {}
        console.log(`✅ 已开启守护心跳（${WATCHDOG_FLAG}）—— 仅当装机版本支持 lifeTaskId 本地路径时才该开`);
        const r = await armWatchdog();
        if (r && r.ok) console.log(`   第一次心跳已排上: ${r.taskId}`);
      } else if (action === 'off') {
        try { fs.unlinkSync(WATCHDOG_FLAG); } catch (_) {}
        try { db.prepare('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?').run(WATCHDOG_ID); } catch (_) {}
        console.log('🛑 已关闭守护心跳（开关文件已删、cron 行已停用）。AlarmManager 里那一次撤不掉，最多再响一次；那次不会续排，链条就此断开。');
      } else {
        console.log(`守护心跳: ${watchdogArmed() ? '已开启' : '关闭（默认）'}`);
        console.log(`开关文件: ${WATCHDOG_FLAG}`);
        console.log('说明: 当前装机版本（1.37/175）不支持 lifeTaskId 本地路径，开启后每次心跳都走 AI，约每小时一个会话。');
      }
      break;
    }

    case 'daemon': {
      const action = args[1] || 'status';
      if (action === 'start') {
        if (fs.existsSync(PID_FILE)) {
          const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
          try {
            process.kill(Number(pid), 0);
            console.log(`守护进程已在运行中 (PID: ${pid})`);
            return;
          } catch (_) {}
        }
        const child = spawn(process.execPath, [__filename, '__run_daemon'], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
        console.log(`✅ DSH Life 守护进程已在后台启动 (PID: ${child.pid})`);
      } else if (action === 'stop') {
        if (fs.existsSync(PID_FILE)) {
          const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
          try {
            process.kill(Number(pid), 'SIGTERM');
            console.log(`✅ 已停止守护进程 (PID: ${pid})`);
          } catch (e) {
            console.log(`停止失败或进程已不在: ${e.message}`);
          }
          try { fs.unlinkSync(PID_FILE); } catch (_) {}
        } else {
          console.log('守护进程未运行。');
        }
      } else if (action === 'restart') {
        execSync(`node ${__filename} daemon stop`, { shell: '/system/bin/sh' });
        execSync(`node ${__filename} daemon start`, { shell: '/system/bin/sh' });
      } else if (action === 'foreground') {
        process.env.DSH_LIFE_FOREGROUND = '1';
        await runDaemon();
      }
      break;
    }

    case '__run_daemon': {
      await runDaemon();
      break;
    }

    case 'code': {
      const sub = args[1];
      if (sub === '--copy' || sub === '-c') {
        const latest = db.prepare(`SELECT * FROM verification_codes ORDER BY id DESC LIMIT 1`).get();
        if (latest) {
          await copyToClipboard(latest.code);
          console.log(`✅ 已复制最新验证码 [${latest.code}] 到剪贴板 (${latest.source})`);
        } else {
          console.log('暂无记录的验证码');
        }
      } else {
        const list = db.prepare(`SELECT * FROM verification_codes ORDER BY id DESC LIMIT 10`).all();
        console.log(`\n=== 📱 最近验证码记录 ===`);
        for (const item of list) {
          const time = new Date(item.created_at).toLocaleString();
          console.log(`[${time}] 验证码: ${item.code.padEnd(8)} 来源: ${item.source}`);
        }
        console.log('');
      }
      break;
    }

    case 'bill': {
      const sub = args[1] || 'today';
      if (sub === 'today') {
        const start = new Date().setHours(0, 0, 0, 0);
        const list = db.prepare(`SELECT * FROM transactions WHERE created_at >= ? ORDER BY created_at DESC, id DESC`).all(start);
        console.log(`\n=== 💰 今日消费流水 ===`);
        let total = 0;
        for (const item of list) {
          const sign = item.type === 'expense' ? '-' : '+';
          if (item.type === 'expense') total += item.amount;
          console.log(`${sign} ¥${item.amount.toFixed(2).padStart(7)}  [${item.category}] ${item.merchant} (${item.account})`);
        }
        console.log(`-----------------------------------`);
        console.log(`今日支出合计: ¥${total.toFixed(2)}`);
        const bals = readLatestBalances(db, 1);
        if (bals.length) console.log(`最近余额: ¥${bals[0].amount.toFixed(2)}  (${bals[0].account}${bals[0].at ? ' · ' + new Date(bals[0].at).toLocaleString('zh-CN') : ''})`);
        console.log('');
      } else if (sub === 'month') {
        const start = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
        const cats = db.prepare(`
          SELECT category, SUM(amount) as sum_amt, count(*) as cnt 
          FROM transactions 
          WHERE created_at >= ? AND type = 'expense'
          GROUP BY category ORDER BY sum_amt DESC
        `).all(start);
        console.log(`\n=== 📊 本月消费分类汇总 ===`);
        let total = 0;
        for (const c of cats) {
          total += c.sum_amt;
          console.log(`${c.category.padEnd(8)} ¥${c.sum_amt.toFixed(2).padStart(8)} (${c.cnt}笔)`);
        }
        console.log(`-----------------------------------`);
        const inc = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE created_at >= ? AND type = 'income'`).get(start).s || 0;
        console.log(`本月支出总额: ¥${total.toFixed(2)}  收入 ¥${inc.toFixed(2)}  结余 ¥${(inc - total).toFixed(2)}\n`);
      } else if (sub === 'all' || sub === 'list') {
        // life bill all --limit 30 --offset 0 [--days 7]
        let limit = 30;
        let offset = 0;
        let days = 0;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--limit') limit = parseInt(args[++i], 10) || 30;
          if (args[i] === '--offset') offset = parseInt(args[++i], 10) || 0;
          if (args[i] === '--days') days = parseInt(args[++i], 10) || 0;
        }
        const out = readLedger(db, { limit, offset, from: days > 0 ? Date.now() - days * 86400000 : 0 });
        console.log(`\n=== 📒 全部账目（共 ${out.total} 笔 · 本次 ${out.txs.length} 笔 · offset=${offset}）===`);
        let day = '';
        for (const item of out.txs) {
          const d = new Date(item.created_at);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (key !== day) { day = key; console.log(`-- ${key} --`); }
          const sign = item.type === 'expense' ? '-' : '+';
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          console.log(`${sign} ¥${item.amount.toFixed(2).padStart(7)}  [${item.category || '-'}] ${item.merchant} (${item.account}) ${hh}:${mm}`);
        }
        console.log(`-----------------------------------`);
        console.log(`全部支出: ¥${out.expense.toFixed(2)}   全部收入: ¥${out.income.toFixed(2)}\n`);
      } else if (sub === 'add') {
        // life bill add --amount 25 --merchant "瑞幸" --cat "餐饮" --type expense
        let amount = 0, merchant = '手动记账', category = '其他消费', type = 'expense';
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--amount') amount = parseFloat(args[++i]);
          if (args[i] === '--merchant') merchant = args[++i];
          if (args[i] === '--cat') category = args[++i];
          if (args[i] === '--type') type = args[++i];
        }
        if (amount > 0) {
          db.prepare(`
            INSERT INTO transactions (type, amount, merchant, category, account, full_text, created_at)
            VALUES (?, ?, ?, ?, '手动录入', '手动记账', ?)
          `).run(type, amount, merchant, category, Date.now());
          console.log(`✅ 已记录: [${type === 'expense' ? '支出' : '收入'}] ¥${amount.toFixed(2)} (${merchant} · ${category})`);
        } else {
          console.log('请提供正确的 --amount 金额参数');
        }
      }
      break;
    }

    case 'pkg': {
      const sub = args[1] || 'list';
      if (sub === 'pick') {
        const idOrCode = args[2];
        if (!idOrCode) {
          console.log('请指定要标记的包裹 ID 或取件码');
          return;
        }
        db.prepare(`
          UPDATE packages SET status = 'picked', picked_at = ? 
          WHERE id = ? OR pickup_code = ?
        `).run(Date.now(), idOrCode, idOrCode);
        console.log(`✅ 包裹 [${idOrCode}] 已标记为已取件！`);
      } else {
        const list = db.prepare(`SELECT * FROM packages WHERE status = 'pending' ORDER BY id DESC`).all();
        console.log(`\n=== 📦 待取包裹清单 (${list.length} 件) ===`);
        for (const item of list) {
          console.log(`ID: ${item.id.toString().padEnd(3)} 取件码: \x1b[32m${item.pickup_code.padEnd(10)}\x1b[0m 驿站: ${item.station} (${item.carrier})`);
        }
        console.log(`\n提示: 取完后可执行: life pkg pick <ID或取件码> 标记已取\n`);
      }
      break;
    }

    case 'cron': {
      const sub = args[1] || 'list';
      if (sub === 'list') {
        const tasks = db.prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`).all();
        console.log(`\n=== ⏰ 定时调度任务列表 (${tasks.length} 项) ===`);
        for (const t of tasks) {
          const next = t.next_run_at ? new Date(t.next_run_at).toLocaleString() : '未排期';
          const enabled = t.enabled ? '🟢 启用' : '⚪ 禁用';
          console.log(`[${t.id}] ${t.name.padEnd(14)} 规则: ${t.cron_expr.padEnd(12)} 下次执行: ${next} (${enabled})`);
        }
        console.log('');
      } else if (sub === 'add') {
        // life cron add --id task1 --name "早报" --expr "daily:08:30" --type builtin --payload "morning_brief"
        let id = '', name = '', expr = '', type = 'cmd', payload = '';
        for (let i = 2; i < args.length; i++) {
          if (args[i] === '--id') id = args[++i];
          if (args[i] === '--name') name = args[++i];
          if (args[i] === '--expr') expr = args[++i];
          if (args[i] === '--type') type = args[++i];
          if (args[i] === '--payload') payload = args[++i];
        }
        if (!id || !name || !expr || !payload) {
          console.log('缺少参数。示例: life cron add --id task1 --name "早报" --expr "daily:08:30" --type builtin --payload "morning_brief"');
          return;
        }
        const next = computeNextRun(expr);
        db.prepare(`
          INSERT OR REPLACE INTO scheduled_tasks (id, name, cron_expr, action_type, action_payload, enabled, next_run_at, created_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `).run(id, name, expr, type, payload, next, Date.now());
        console.log(`✅ 定时任务 [${id}] 添加成功！下次触发时间: ${new Date(next).toLocaleString()}`);
      } else if (sub === 'rm' || sub === 'delete') {
        const id = args[2];
        if (!id) { console.log('用法: life cron rm <id>'); break; }
        // 顺手让原生侧把这条任务注册过的唤醒闹钟撤掉，避免删了记录闹钟还在响
        try { await httpPostJson(`${BRIDGE_3081}/schedule/cancel`, { source: 'life', taskId: id }); } catch (_) {}
        db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
        console.log(`✅ 已删除定时任务: ${id}`);
      } else if (sub === 'run') {
        // 控制台「立即运行」按钮走的是 life cron run <id>，老版本没有这个分支 → 点了没反应
        const id = args[2];
        if (!id) { console.log('用法: life cron run <id>'); break; }
        const res = await handleLifeAction('task.run', id);
        console.log(res && res.ok ? `✅ ${res.msg}` : `❌ ${(res && res.msg) || '执行失败'}`);
      }
      break;
    }

    case 'scan': {
      const limit = parseInt(args[1], 10) || 50;
      console.log(`正在扫描最近 ${limit} 条系统通知...`);
      const res = await httpGetJson(`${BRIDGE_3181}/notifications?limit=${limit}`);
      if (res.ok && res.items) {
        let codeCount = 0, billCount = 0, pkgCount = 0;
        for (const item of res.items) {
          if (isSelfNotification(item)) continue;
          const bodyText = getNotificationBody(item);
          const codeInfo = EXTRACTOR.extractCode(bodyText, item.title, item.package);
          if (codeInfo) {
            codeCount++;
            db.prepare(`
              INSERT INTO verification_codes (code, source, full_text, created_at, auto_copied)
              VALUES (?, ?, ?, ?, 0)
            `).run(codeInfo.code, codeInfo.source, codeInfo.fullText, item.time || Date.now());
          }
          const txInfo = EXTRACTOR.extractTransaction(bodyText, item.title, item.package);
          if (txInfo) {
            billCount++;
            insertTransactionDedup(db, txInfo, item.seq, item.time || Date.now());
          }
          const pkgInfo = EXTRACTOR.extractPackage(bodyText, item.title, item.package);
          if (pkgInfo) {
            pkgCount++;
            db.prepare(`
              INSERT INTO packages (pickup_code, station, carrier, full_text, created_at)
              VALUES (?, ?, ?, ?, ?)
            `).run(pkgInfo.pickup_code, pkgInfo.station, pkgInfo.carrier, pkgInfo.fullText, item.time || Date.now());
          }
        }
        console.log(`✅ 历史扫描完成：提取到 ${codeCount} 个验证码，${billCount} 笔账单，${pkgCount} 个包裹！`);
      } else {
        console.log('获取通知失败:', res.error);
      }
      break;
    }

    case 'scene': {
      SCENE_ENGINE.initDefaultScenes(db);
      const sub = args[1] || 'list';
      if (sub === 'morning' || sub === 'brief') {
        const brief = SCENE_ENGINE.generateMorningBrief(db);
        console.log(`\n=== ${brief.title} ===\n`);
        console.log(brief.content);
        console.log('\n================================');
      } else if (sub === 'night' || sub === 'recap') {
        const recap = SCENE_ENGINE.generateNightRecap(db);
        console.log(`\n=== ${recap.title} ===\n`);
        console.log(recap.content);
        console.log('\n================================');
      } else if (sub === 'trigger') {
        const targetId = args[2] || 'morning_brief';
        const res = await SCENE_ENGINE.triggerScene(db, targetId);
        console.log(`[Scene Trigger] ${res.msg}`);
        if (res.result) {
          console.log(`\n${res.result.content}\n`);
        }
      } else {
        const list = db.prepare(`SELECT id, name, type, description, enabled, last_triggered_at FROM scenes ORDER BY created_at ASC`).all();
        console.log(`\n=== 🌟 DSH 生活情境模式清单 (${list.length} 个) ===\n`);
        for (const sc of list) {
          const lastTime = sc.last_triggered_at ? new Date(sc.last_triggered_at).toLocaleString() : '未触发过';
          console.log(`  • [${sc.id}] ${sc.name} (${sc.enabled ? '启用' : '禁用'})`);
          console.log(`    描述: ${sc.description}`);
          console.log(`    上次触发: ${lastTime}\n`);
        }
      }
      break;
    }

    default:
      printHelp();
      break;
  }
}

// ==================== 8. Web API 与前端桥接 ====================

/**
 * 把一条动账归到「哪张卡」：银行名 + 尾号四位。
 * 为什么不能只看 account 字段：同一张农行卡的通知，有的解析出「中国农业银行(0770)」，
 * 有的只有「中国农业银行」（尾号写在正文里）—— 只看字段会把同一张卡拆成两个账户。
 */
function bankKeyOf(account, fullText) {
  const s = String(account || '') + ' ' + String(fullText || '');
  const bank = (s.match(/(中国农业银行|农业银行|中国建设银行|建设银行|中国工商银行|工商银行|中国银行|招商银行|交通银行|邮储银行|邮政储蓄银行|中信银行|浦发银行|兴业银行|民生银行|光大银行|华夏银行|广发银行|平安银行|云闪付|银联)/) || [])[1] || String(account || '账户');
  const tail = (s.match(/尾号(?:为)?\s*(\d{4})/) || s.match(/\((\d{4})\)/) || [])[1] || '';
  return bank.replace(/^中国/, '') + ':' + tail;
}

/**
 * 从最近的动账通知正文里读「余额」，按账户去重、取最新的几个（默认 3 个）。
 *
 * ⚠️ 银行报的余额是**某一刻的快照**，之后的小额动账不再带余额
 *    （2026-10-15 实测：农行 ≥¥10 发短信且带余额；<¥10 只有掌银通知，
 *     title/text 就一句「发生一笔支出X元，详情请点击」，bigText/subText 都是空的）。
 *    ⇒ 这里把基准余额之后**同一张卡**的动账逐笔加减，得到「推算到最后一笔卡内动账」
 *      的余额；derived=true 表示这不是银行原话，是推出来的。
 *    ⚠️ 手工补录的账不知道走哪张卡，一律不参与推算（宁可少扣，也不乱扣别的账户）。
 */
function readLatestBalances(db, limit = 3) {
  const out = [];
  try {
    // ⚠️ 必须按**业务时间**倒序，不能按 id：补录/回填的行 id 最大但时间很旧，
    //    按 id 取 30 条会把「带余额的那条」直接挤出窗口
    //    （2026-10-15 补录 69 笔手工账后就踩了这个：balances 从 ¥1069.97 变成空）。
    //    再用 LIKE '%余额%' 预筛 —— 只有含「余额」字样的正文才可能解析出余额，
    //    这样窗口只跟「有余额的通知条数」有关，跟补录多少笔无关。
    const rows = db.prepare(`SELECT id, merchant, account, full_text, created_at FROM transactions
      WHERE full_text LIKE '%余额%' ORDER BY created_at DESC, id DESC LIMIT 300`).all();
    // 用户校准是独立余额快照，不伪造交易；新银行余额仍可覆盖旧快照。
    try {
      const saved = db.prepare("SELECT value FROM daemon_state WHERE key = 'balance_snapshots'").get();
      const snapshots = saved ? JSON.parse(saved.value) : [];
      if (Array.isArray(snapshots)) for (const s of snapshots) {
        if (!s || typeof s.account !== 'string' || !s.account ||
            !Number.isFinite(s.amount) || !Number.isSafeInteger(s.at) || s.at <= 0) continue;
        rows.push({ account: s.account, full_text: '', created_at: s.at,
          manualAmount: s.amount, merchant: '', id: Number.MAX_SAFE_INTEGER });
      }
    } catch (_) {}
    rows.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
    const seen = new Set();
    for (const r of rows) {
      const base = r.manualAmount !== undefined ? r.manualAmount : EXTRACTOR.extractBalance(r.full_text);
      if (base === null) continue;
      const account = String(r.account || '账户');
      const key = bankKeyOf(account, r.full_text);
      if (seen.has(key)) continue;
      seen.add(key);
      // 用基准之后同一张卡的动账把余额推到最新
      let amount = base, at = r.created_at, moves = 0;
      try {
        const later = db.prepare(`SELECT type, amount, account, full_text, created_at FROM transactions
          WHERE created_at > ? ORDER BY created_at ASC, id ASC`).all(r.created_at);
        for (const t of later) {
          if (bankKeyOf(t.account, t.full_text) !== key) continue;
          const a = Number(t.amount) || 0;
          amount += (t.type === 'income' ? a : -a);
          at = t.created_at;
          moves++;
        }
      } catch (_) {}
      out.push({
        account, amount: Math.round(amount * 100) / 100, merchant: r.merchant || '', at,
        base, baseAt: r.created_at, moves, derived: moves > 0
      });
      if (out.length >= limit) break;
    }
  } catch (_) {}
  return out;
}

/** App 侧闹钟任务注册表（纯文本，一行一条：id|triggerAt|repeat|intervalMin|text）。 */
const APP_SCHED_TASKS = process.env.DSH_SCHED_FILE || '/data/user/0/com.deepseek.harness/files/scheduled-tasks.json';

/**
 * 直接从 App 的定时任务注册表里删掉一个任务：
 *  - 删掉该 id 的所有任务行与附属元数据行（#life / #daily / #delivered）；
 *  - 补一条永久取消栅栏 `#cancel|id`（新版 Java 认这条；老版当未知行原样保留，无害）。
 * 写入用「临时文件 + rename」，和 Java 侧 save() 同一套路，避免半截文件。
 * ⚠️ 已注册进 AlarmManager 的闹钟无法从外部撤（见 lesson-android-schedule-internals），
 *    所以这一步只保证「列表里消失」，到点是否仍触发取决于该版本的 AlarmReceiver。
 */
function deleteAppScheduledTask(id) {
  const fs = require('node:fs');
  if (!fs.existsSync(APP_SCHED_TASKS)) return { missing: true, removed: 0 };
  const lines = fs.readFileSync(APP_SCHED_TASKS, 'utf8').split('\n');
  const kept = [];
  let removed = 0;
  let fenced = false;
  for (const line of lines) {
    const f = line.split('|');
    if (f[0] === id) { removed++; continue; }
    if ((f[0] === '#life' || f[0] === '#daily' || f[0] === '#delivered') && f[1] === id) { removed++; continue; }
    if (f[0] === '#cancel' && f[1] === id) fenced = true;
    kept.push(line);
  }
  if (!fenced) kept.push(`#cancel|${id}`);
  let out = kept.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  fs.writeFileSync(APP_SCHED_TASKS + '.tmp', out, 'utf8');
  fs.renameSync(APP_SCHED_TASKS + '.tmp', APP_SCHED_TASKS);
  const after = fs.readFileSync(APP_SCHED_TASKS, 'utf8').split('\n');
  return { removed, stillListed: after.some((l) => l.split('|')[0] === id) };
}

/** 老版原生桥没有 /schedule/cancel 时返回的「路径不认识」类错误——不当失败看。 */
function isBridgeUnsupported(msg) {
  return !msg || /缺少 text 参数|未知|Not Found|404/i.test(String(msg));
}

// ==================== 守护心跳（自续期闹钟） ====================

/**
 * 守护心跳（闹钟自续期）—— **默认关闭**，理由见下。
 *
 * 背景：守护进程 10/9 14:14 挂掉后，直到 10/15 08:38 才被手动拉起 —— 中间 6 天
 * 的通知全丢（而自检日志显示那几天 App/引擎其实是活着的，只是没人发现守护不在）。
 * 所以需要「有人定期确认守护还在」。
 *
 * 设计：life.db 里一条 daemon_watchdog 任务（enabled=1，供 ScheduleBridge.lifeEnabled 放行），
 * 注册同名 lifeTaskId 闹钟；到点 AlarmReceiver → ScheduleExecutor.tickLife → `life.js tick`
 * → 再排下一次。**在支持 lifeTaskId 的装机版本上，这条路径不经过 AI，零 token。**
 *
 * ⛔ 2026-10-15 实测：**当前装机版本（1.37/175）不支持这条本地路径**。
 *    闹钟按时触发（12:20:24），但注册表里没有 `#life|<id>|daemon_watchdog` 元数据行，
 *    AlarmReceiver 走的是普通分支：发通知 + 把任务文本作为消息提交给 AI。
 *    结果就是「零 token 心跳」变成**每小时一个完整 AI 会话**。
 *    证据与复核方法见 lesson-life-watchdog-falls-into-ai-path。
 *    因此本函数默认直接跳过；只有确认装机版本支持（能 grep 到 `^#life` 行）后，
 *    才由 `life.js watchdog on` 创建开关文件放行。
 *
 * ⚠️ repeat 必须是 once：MainActivity 的 /schedule 对 lifeTaskId 只接受 once（v118 起）。
 * ⚠️ 同名 lifeTaskId 再注册时 Java 会先撤掉旧闹钟，所以重复排不会造成闹钟堆积。
 * ⚠️ 已在队列里的闹钟**撤不掉**（AlarmReceiver exported=false），停用时最多还会再响一次；
 *    靠「响那次不续排」自然断链。
 */
const WATCHDOG_ID = 'daemon_watchdog';
const WATCHDOG_INTERVAL_SEC = 3600;
const WATCHDOG_TEXT = 'DSH 生活助理守护自检（只跑本地脚本，不调用 AI）';
const WATCHDOG_FLAG = '/sdcard/DeepSeekHarness/state/life-watchdog-arm';

function watchdogArmed() {
  try { return fs.existsSync(WATCHDOG_FLAG); } catch (_) { return false; }
}

async function armWatchdog() {
  if (!watchdogArmed()) {
    return { ok: false, skipped: `本机默认不开守护心跳（${WATCHDOG_FLAG} 不存在）。当前装机版本不支持 lifeTaskId 本地路径，每次心跳都会变成一次付费 AI 会话；保活改由开机自检 selfcheck.sh 承担。确认装机版本支持（grep 得到 ^#life 行）后用 life.js watchdog on 开启。` };
  }
  try {
    const r = await httpPostJson(`${BRIDGE_3081}/schedule`, {
      text: WATCHDOG_TEXT,
      when: String(WATCHDOG_INTERVAL_SEC),
      repeat: 'once',
      lifeTaskId: WATCHDOG_ID
    });
    if (r && r.ok) {
      console.log(`tick: 下一次守护心跳已排上 (+${WATCHDOG_INTERVAL_SEC}s, ${r.taskId || ''})`);
      pruneWatchdogRecords();
      return { ok: true, taskId: r.taskId };
    }
    const msg = (r && (r.error || r.warning)) || '未知错误';
    console.log(`tick: ⚠️ 排心跳失败: ${msg}`);
    return { ok: false, msg };
  } catch (e) {
    console.log(`tick: ⚠️ 桥不可用，心跳没排上: ${e.message}`);
    return { ok: false, msg: e.message };
  }
}

/**
 * 心跳每次触发都会在 App 任务注册表里留一条一次性记录（+ 一条 #life 元数据）。
 * 不清的话一天 48 行、一年上万行。这里只保留最新的一条，其余删掉。
 * 写入用「临时文件 + rename」，与 Java 侧同一套路；失败就原样不动，绝不半截写。
 */
function pruneWatchdogRecords(keepAtLeast = 8) {
  try {
    if (!fs.existsSync(APP_SCHED_TASKS)) return { pruned: 0 };
    const lines = fs.readFileSync(APP_SCHED_TASKS, 'utf8').split('\n');
    const ids = [];
    for (const line of lines) {
      const f = line.split('|');
      if (f[0] === '#life' && f[2] === WATCHDOG_ID && f[1]) ids.push(f[1]);
    }
    if (ids.length < keepAtLeast) return { pruned: 0, pending: ids.length };
    const keep = ids[ids.length - 1]; // 最后一条 = 最新的那次注册
    const kept = lines.filter((line) => {
      const f = line.split('|');
      if (f[0] === keep) return true;
      if ((f[0] === '#life' || f[0] === '#daily' || f[0] === '#delivered') && f[1] === keep) return true;
      if (ids.includes(f[0])) return false;                       // 旧的守护记录本体
      if (f[0] === '#life' && f[2] === WATCHDOG_ID) return false;  // 旧的守护元数据
      return true;
    });
    const removed = lines.length - kept.length;
    if (removed <= 0) return { pruned: 0 };
    let out = kept.join('\n');
    if (!out.endsWith('\n')) out += '\n';
    fs.writeFileSync(APP_SCHED_TASKS + '.tmp', out, 'utf8');
    fs.renameSync(APP_SCHED_TASKS + '.tmp', APP_SCHED_TASKS);
    return { pruned: removed, kept: keep };
  } catch (e) {
    return { pruned: 0, error: e.message };
  }
}

/**
 * 账目分页读取（面板「全部账目」入口 + CLI `life bill all` 共用）。
 * 统一按**业务时间**倒序（created_at DESC, id DESC）：回填的历史账 id 更大，
 * 按 id 排会把最老的账排到最前面（2026-10-15 踩过）。
 */
function readLedger(db, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 300);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const from = Number(opts.from) || 0;
  const to = Number(opts.to) || 0;
  const where = [];
  const args = [];
  if (from) { where.push('created_at >= ?'); args.push(from); }
  if (to) { where.push('created_at <= ?'); args.push(to); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM transactions${w}`).get(...args).c || 0;
  const sums = db.prepare(`SELECT type, SUM(amount) AS total FROM transactions${w} GROUP BY type`).all(...args);
  let expense = 0;
  let income = 0;
  for (const s of sums) {
    if (s.type === 'expense') expense = s.total || 0;
    else if (s.type === 'income') income = s.total || 0;
  }
  const txs = db.prepare(`SELECT id, type, amount, merchant, category, account, created_at, seq FROM transactions${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { total, expense, income, limit, offset, txs };
}

function getLifeStatus() {
  let daemonRunning = false;
  let daemonPid = null;
  if (fs.existsSync(PID_FILE)) {
    try {
      const pidStr = fs.readFileSync(PID_FILE, 'utf-8').trim();
      const pid = Number(pidStr);
      if (pid > 0) {
        process.kill(pid, 0);
        daemonRunning = true;
        daemonPid = pid;
      }
    } catch (_) {}
  }

  const db = openDB();
  SCENE_ENGINE.initDefaultScenes(db);

  const pkgs = db.prepare(`SELECT id, pickup_code, station, carrier, created_at FROM packages WHERE status = 'pending' ORDER BY id DESC LIMIT 10`).all();
  const codes = db.prepare(`SELECT id, code, source, created_at FROM verification_codes ORDER BY id DESC LIMIT 5`).all();
  
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const sums = db.prepare(`SELECT type, SUM(amount) as total FROM transactions WHERE created_at >= ? GROUP BY type`).all(todayStart.getTime());
  let todayExpense = 0;
  let todayIncome = 0;
  for (const s of sums) {
    if (s.type === 'expense') todayExpense = s.total || 0;
    else if (s.type === 'income') todayIncome = s.total || 0;
  }

  // 本月（自然月）合计 —— 面板上并排显示「月结余」用（结余 = 本月收入 − 本月支出）。
  // 用户 2026-10-15 要求：记账 App 里每个月有结余，我们面板上也该看得到，省得手动算。
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthSums = db.prepare(`SELECT type, SUM(amount) as total FROM transactions WHERE created_at >= ? GROUP BY type`).all(monthStart.getTime());
  let monthExpense = 0;
  let monthIncome = 0;
  for (const s of monthSums) {
    if (s.type === 'expense') monthExpense = s.total || 0;
    else if (s.type === 'income') monthIncome = s.total || 0;
  }
  const monthTxCount = db.prepare(`SELECT COUNT(*) AS c FROM transactions WHERE created_at >= ?`).get(monthStart.getTime()).c || 0;

  // 卡片只列**今天**的账（用户 2026-10-15 明确要求：标题写着「今日」，
  // 下面却混着昨天那几笔，看着就像数据对不上）。更早的账走「全部账目」入口（/api/tx 分页）。
  const txs = db.prepare(`SELECT id, type, amount, merchant, category, account, created_at FROM transactions WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 20`).all(todayStart.getTime());
  const txTotal = db.prepare(`SELECT COUNT(*) AS c FROM transactions`).get().c || 0;
  // 今日总笔数：卡片最多列 20 条，超过了要明说「还有 N 笔未显示」，不许静默截断
  //（2026-10-15 正是被"看不见的截断"坑过：余额行被挤出窗口，界面上一片正常）。
  const txToday = db.prepare(`SELECT COUNT(*) AS c FROM transactions WHERE created_at >= ?`).get(todayStart.getTime()).c || 0;
  const tasks = db.prepare(`SELECT id, name, cron_expr, action_type, enabled, last_status, next_run_at FROM scheduled_tasks ORDER BY id ASC`).all();
  const scenes = db.prepare(`SELECT id, name, type, description, enabled, last_triggered_at FROM scenes ORDER BY created_at ASC`).all();
  const balances = readLatestBalances(db, 3);

  const morningBrief = SCENE_ENGINE.generateMorningBrief(db);
  const nightRecap = SCENE_ENGINE.generateNightRecap(db);

  const summary = (daemonRunning ? '🟢 守护中' : '⚪ 未启动') + ` · 今日支出 ¥${todayExpense.toFixed(2)}` + (pkgs.length > 0 ? ` · 📦 待取快递 ${pkgs.length} 件` : '');

  return {
    ok: true,
    daemonRunning,
    daemonPid,
    todayExpense,
    todayIncome,
    monthExpense,
    monthIncome,
    monthTxCount,
    packages: pkgs,
    codes,
    transactions: txs,
    txTotal,
    txToday,
    tasks,
    scenes,
    balances,
    latestBalance: balances[0] || null,
    morningBrief,
    nightRecap,
    summary
  };
}

async function handleLifeAction(id, arg) {
  const db = openDB();
  const cleanId = String(id || '').replace(/^life\./, '');

  if (cleanId === 'daemon.start' || cleanId === 'start') {
    if (fs.existsSync(PID_FILE)) {
      try {
        const pid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
        if (pid > 0) {
          process.kill(pid, 0);
          return { ok: true, msg: `守护进程已在运行 (PID: ${pid})` };
        }
      } catch (_) {}
    }
    const child = spawn(process.execPath, [__filename, '__run_daemon'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return { ok: true, msg: `守护进程已启动 (PID: ${child.pid})` };
  }

  if (cleanId === 'daemon.stop' || cleanId === 'stop') {
    if (fs.existsSync(PID_FILE)) {
      try {
        const pid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
        process.kill(pid, 'SIGTERM');
      } catch (_) {}
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
    }
    return { ok: true, msg: '守护进程已停止' };
  }

  if (cleanId === 'daemon.restart' || cleanId === 'restart') {
    if (fs.existsSync(PID_FILE)) {
      try {
        const pid = Number(fs.readFileSync(PID_FILE, 'utf-8').trim());
        process.kill(pid, 'SIGTERM');
      } catch (_) {}
      try { fs.unlinkSync(PID_FILE); } catch (_) {}
    }
    const child = spawn(process.execPath, [__filename, '__run_daemon'], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return { ok: true, msg: `守护进程已重启 (PID: ${child.pid})` };
  }

  if (cleanId === 'pkg.pick') {
    db.prepare(`
      UPDATE packages 
      SET status = 'picked', picked_at = ?
      WHERE id = ? OR pickup_code = ?
    `).run(Date.now(), Number(arg) || -1, String(arg));
    return { ok: true, msg: '包裹已标记为已取' };
  }

  if (cleanId === 'code.copy') {
    const codeText = String(arg || '');
    if (codeText) {
      await copyToClipboard(codeText);
    }
    return { ok: true, msg: `验证码 [${codeText}] 已复制` };
  }

  if (cleanId === 'scan') {
    const limit = Number(arg) || 50;
    const res = await httpGetJson(`${BRIDGE_3181}/notifications?limit=${limit}`);
    let codeCount = 0, billCount = 0, pkgCount = 0;
    if (res.ok && Array.isArray(res.items)) {
      for (const item of res.items) {
        if (isSelfNotification(item)) continue;
        const bodyText = getNotificationBody(item);
        const codeInfo = EXTRACTOR.extractCode(bodyText, item.title, item.package);
        if (codeInfo) {
          codeCount++;
          db.prepare(`
            INSERT INTO verification_codes (code, source, full_text, created_at, auto_copied)
            VALUES (?, ?, ?, ?, 0)
          `).run(codeInfo.code, codeInfo.source, codeInfo.fullText, item.time || Date.now());
        }
        const txInfo = EXTRACTOR.extractTransaction(bodyText, item.title, item.package);
        if (txInfo) {
          billCount++;
          insertTransactionDedup(db, txInfo, item.seq, item.time || Date.now());
        }
        const pkgInfo = EXTRACTOR.extractPackage(bodyText, item.title, item.package);
        if (pkgInfo) {
          pkgCount++;
          db.prepare(`
            INSERT INTO packages (pickup_code, station, carrier, full_text, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(pkgInfo.pickup_code, pkgInfo.station, pkgInfo.carrier, pkgInfo.fullText, item.time || Date.now());
        }
      }
    }
    return { ok: true, msg: `扫描完成：提取到 ${codeCount} 个验证码，${billCount} 笔账单，${pkgCount} 个包裹` };
  }

  if (cleanId === 'scene.morning' || cleanId === 'morning_brief') {
    const res = await SCENE_ENGINE.triggerScene(db, 'morning_brief');
    return res;
  }

  if (cleanId === 'scene.night' || cleanId === 'night_recap') {
    const res = await SCENE_ENGINE.triggerScene(db, 'night_recap');
    return res;
  }

  if (cleanId === 'scene.trigger') {
    const res = await SCENE_ENGINE.triggerScene(db, arg || 'morning_brief');
    return res;
  }

  // 删除定时任务（不是「暂停」）：life 源整行删除，app 源连闹钟注册一起撤掉。
  // 两种入参都吃：纯 id 字符串，或 {"source":"life|app","id":"..."} 的 JSON。
  if (cleanId === 'task.delete') {
    let p = arg;
    if (typeof p === 'string') {
      const s = p.trim();
      if (s.startsWith('{')) { try { p = JSON.parse(s); } catch (_) { p = { id: s }; } }
      else p = { id: s };
    }
    if (!p || typeof p !== 'object') p = {};
    const taskId = String(p.id || p.taskId || p.task || '');
    const source = String(p.source || 'life');
    if (!taskId) return { ok: false, msg: '缺少任务 ID' };

    if (source === 'app') {
      // 新版原生桥能直接撤闹钟；老版没有这条路径（会回「缺少 text 参数」），
      // 那就退回直接改 App 的任务注册表：列表里立刻消失。
      let note = '';
      try {
        const r = await httpPostJson(`${BRIDGE_3081}/schedule/cancel`, { source: 'app', taskId });
        if (r && r.ok) return { ok: true, msg: `已删除 App 闹钟任务 ${taskId}` };
        const err = (r && (r.error || r.warning)) || '';
        if (!isBridgeUnsupported(err)) note = `（原生桥: ${err}）`;
      } catch (e) { note = `（原生桥不可用: ${e.message}）`; }
      const res = deleteAppScheduledTask(taskId);
      if (res.missing) return { ok: false, msg: 'App 任务注册表不存在' };
      if (res.stillListed) return { ok: false, msg: `删除失败: ${taskId}` };
      return { ok: true, msg: `已从列表删除 App 任务 ${taskId}${note}` };
    }

    const row = db.prepare(`SELECT id, name FROM scheduled_tasks WHERE id = ?`).get(taskId);
    if (!row) return { ok: false, msg: `未找到任务: ${taskId}` };
    // 先让原生侧回收这条任务注册过的唤醒闹钟；老版桥没这条路径就不提示（见 isBridgeUnsupported）
    let warn = '';
    try {
      const r = await httpPostJson(`${BRIDGE_3081}/schedule/cancel`, { source: 'life', taskId });
      const err = (r && (r.error || r.warning)) || '';
      if (r && r.ok === false && !isBridgeUnsupported(err)) warn = `（唤醒闹钟回收: ${err}）`;
    } catch (e) { warn = `（唤醒闹钟回收失败: ${e.message}）`; }
    db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(taskId);
    const still = db.prepare(`SELECT id FROM scheduled_tasks WHERE id = ?`).get(taskId);
    return still
      ? { ok: false, msg: `删除失败: ${taskId}` }
      : { ok: true, msg: `已删除定时任务「${row.name || taskId}」${warn}` };
  }

  if (cleanId === 'task.run') {
    const task = db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(arg);
    if (!task) return { ok: false, msg: `未找到任务: ${arg}` };
    const scheduler = new CronScheduler(db);
    try {
      if (task.action_type === 'cmd') {
        execSync(task.action_payload, { stdio: 'ignore', timeout: 60000, shell: '/system/bin/sh' });
      } else if (task.action_type === 'notify') {
        await sendNotification('⏰ 定时提醒', task.action_payload);
      } else if (task.action_type === 'builtin') {
        await scheduler.runBuiltinTask(task.action_payload);
      }
      return { ok: true, msg: `任务 [${task.name}] 执行完成` };
    } catch (e) {
      return { ok: false, msg: `任务执行失败: ${e.message}` };
    }
  }

  return { ok: false, msg: `未知动作: ${id}` };
}

function createHandler(prefix = '/life') {
  return async function(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname.replace(new RegExp(`^${prefix}`), '') || '/';
    
    const sendJson = (status, obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': b.length,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type'
      });
      res.end(b);
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type'
      });
      res.end();
      return;
    }

    if (p === '/api/status' || p === '/status' || p === '/api') {
      try {
        const state = getLifeStatus();
        return sendJson(200, state);
      } catch (err) {
        return sendJson(500, { ok: false, error: err.message });
      }
    }

    if (p === '/api/tx' || p === '/tx' || p === '/api/ledger') {
      try {
        const db = openDB();
        const out = readLedger(db, {
          limit: url.searchParams.get('limit'),
          offset: url.searchParams.get('offset'),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to')
        });
        return sendJson(200, Object.assign({ ok: true }, out));
      } catch (err) {
        return sendJson(500, { ok: false, error: err.message });
      }
    }

    if (p === '/api/act' || p === '/act' || p === '/action') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          const result = await handleLifeAction(payload.id || payload.action, payload.arg);
          return sendJson(200, result);
        } catch (err) {
          return sendJson(500, { ok: false, error: err.message });
        }
      });
      return;
    }

    sendJson(404, { ok: false, error: `Not found: ${req.url}` });
  };
}

// 导出与执行入口
if (require.main === module) {
  handleCLI().catch(err => console.error(err));
} else {
  module.exports = {
    EXTRACTOR,
    SCENE_ENGINE,
    openDB,
    computeNextRun,
    CronScheduler,
    getLifeStatus,
    handleLifeAction,
    createHandler,
    isSelfNotification,
    getNotificationBody,
    insertTransactionDedup,
    isJunkMerchant,
    normalizeAccount,
    // 保活：给 selfcheck.sh / 引擎插件 / 闹钟共用，别各自复制一份判断
    ensureDaemonRunning,
    watchdogArmed,
    armWatchdog
  };
}
