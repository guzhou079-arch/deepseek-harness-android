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

function cleanStationName(s) {
  if (!s) return '快递驿站/柜';
  let str = s.replace(/^.*?(?:已投递至|已存放至|已送达至|已到达|已送达|已送至|已到|到达|存放在|存放至)/, '').trim();
  return str || s;
}

const EXTRACTOR = {
  // --- A. 验证码提取 ---
  extractCode(fullText, title = '', pkg = '') {
    if (!fullText) return null;
    const text = `${title} ${fullText}`.trim();
    
    // 排除明显不是验证码的长篇通知
    if (text.includes('DSH 自检') || text.includes('引擎未运行')) return null;

    const keywords = /(验证码|校验码|动态码|确认码|安全码|动态密码|授权码|动态口令|短信口令|口令|verification code|auth code|code)/i;
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

    // 2. 带连接符或空格的 6 位数 (如 "492-108", "192 830")
    const splitCodeMatch = text.match(/(?:验证码|校验码|动态码|动态密码|code|Code)[：:\s为是]*([0-9]{3}[\s\-][0-9]{3})/i);
    if (splitCodeMatch) {
      const rawCode = splitCodeMatch[1].replace(/[\s\-]/g, '');
      if (!isExcludedCode(rawCode)) {
        return { code: rawCode, source, fullText: text };
      }
    }

    // 3. 关键词后跟代码 (支持全角冒号 ：、半角冒号 :、等号 =、空格、括号、为、是)
    const afterKw = text.match(/(?:验证码|校验码|动态码|确认码|安全码|动态密码|授权码|动态口令|短信口令|口令|verification code|auth code|code|Code)(?:为|是|is|：|:|=|\s|\[|【|\(|\s)+([0-9A-Za-z]{4,8})/i);
    if (afterKw && !isExcludedCode(afterKw[1])) {
      return { code: afterKw[1], source, fullText: text };
    }

    // 4. 代码在前，关键词在后 (如 "829103 是您的验证码" / "829103(验证码)" / "[901245] 动态码")
    const beforeKw = text.match(/([0-9A-Za-z]{4,8})(?:\s|\[|【|\(|\)|）|（|\]|】)*(?:为|是)?(?:您的|本次)?(?:登录|操作)?(?:验证码|校验码|动态码|动态密码|确认码|安全码|动态口令|短信口令|口令)/);
    if (beforeKw && !isExcludedCode(beforeKw[1])) {
      return { code: beforeKw[1], source, fullText: text };
    }

    // 5. 凭 123456 登录/验证
    const pingMatch = text.match(/凭\s*([0-9A-Za-z]{4,8})\s*(?:完成|进行|验证|登录|确认)/);
    if (pingMatch && !isExcludedCode(pingMatch[1])) {
      return { code: pingMatch[1], source, fullText: text };
    }

    // 6. 兜底提取独立的 4~6 位纯数字，伴随有效时间/勿泄露提示
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
      const expMatch = text.match(/(?:支付金额|付款金额|支出|扣款|消费金额|交易金额)[：:\s]*￥?\s*([\d\.,]+)/);
      if (expMatch) {
        const amount = parseFloat(expMatch[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          let merchant = '微信商户';
          const merchMatch = text.match(/(?:商户全称|收款方|商户名称|向|付款给|商户)[：:\s]*([^\s,，。]+)/);
          if (merchMatch) merchant = cleanMerchantName(merchMatch[1]);
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

    // 2. 支付宝
    if (pkg.includes('alipay') || text.includes('支付宝')) {
      const expMatch = text.match(/(?:成功付款|支付|消费|扣款|还款)[：:\s]*￥?\s*([\d\.,]+)\s*元?/);
      if (expMatch) {
        const amount = parseFloat(expMatch[1].replace(/,/g, ''));
        if (!isNaN(amount) && amount > 0) {
          let merchant = '支付宝商户';
          const merchMatch = text.match(/(?:付款给|商户|收款人|向)[：:\s]*([^\s,，。]+)/);
          if (merchMatch) merchant = cleanMerchantName(merchMatch[1]);
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
    const isBank = /(银行|信用卡|储蓄卡|支行|农信|农商|信用社|云闪付|银联)/.test(text);
    if (isBank) {
      let account = '银行卡';
      const cardMatch = text.match(/尾号\s*([0-9]{4})/);
      const bankTag = text.match(/【(.*?)】/);
      if (bankTag) {
        account = bankTag[1];
      } else {
        const bankNameMatch = text.match(/(中国农业银行|农业银行|中国建设银行|建设银行|中国工商银行|工商银行|中国银行|招商银行|交通银行|邮政储蓄银行|邮储银行|中信银行|浦发银行|兴业银行|民生银行|光大银行|华夏银行|广发银行|平安银行|浙商银行|宁波银行|北京银行|上海银行|云闪付|银联)/);
        if (bankNameMatch) account = bankNameMatch[1];
      }
      if (cardMatch && !account.includes(cardMatch[1])) account += `(${cardMatch[1]})`;

      let expAmount = null;
      const negMatch = text.match(/(?:交易|完成.*?交易|扣款|支出|发生|支付)?(?:人民币|RMB|￥)?\s*-\s*([\d\.,]+)\s*元?/);
      if (negMatch) {
        expAmount = parseFloat(negMatch[1].replace(/,/g, ''));
      } else {
        const expMatch = text.match(/(?:支出|消费|扣款|转出|网上支付|快捷支付|支付|完成.*?交易)(?:人民币|RMB|￥)?\s*([\d\.,]+)\s*元?/);
        if (expMatch) {
          expAmount = parseFloat(expMatch[1].replace(/,/g, ''));
        }
      }

      if (expAmount !== null && !isNaN(expAmount) && expAmount > 0) {
        let merchant = '银行消费';
        const merchTagMatch = text.match(/(?:商户为|商户[：:\s]+)\s*([^\s,，。]+)/);
        if (merchTagMatch) {
          merchant = cleanMerchantName(merchTagMatch[1]);
        } else {
          const merchMatch = text.match(/(?:在|于|向|商户)\s*([^\s,，。]+?)\s*(?:完成|消费|支出|扣款|支付|转账)/);
          if (merchMatch) {
            merchant = cleanMerchantName(merchMatch[1]);
          }
        }
        return {
          type: 'expense',
          amount: expAmount,
          merchant,
          category: guessCategory(merchant, text),
          account,
          fullText: text
        };
      }

      const posMatch = text.match(/(?:存入|收入|转入|代发|到账|结息|汇入)(?:人民币|RMB|￥)?\s*([\d\.,]+)\s*元?/);
      if (posMatch) {
        const amountStr = posMatch[1].replace(/,/g, '');
        const amount = parseFloat(amountStr);
        if (!isNaN(amount) && amount > 0) {
          return {
            type: 'income',
            amount,
            merchant: '银行转入/代发',
            category: '收入',
            account,
            fullText: text
          };
        }
      }
    }

    return null;
  },

  // --- C. 快递取件码提取 ---
  extractPackage(fullText, title = '', pkg = '') {
    if (!fullText) return null;
    const body = fullText.trim();
    const text = `${title} ${body}`.trim();

    const pkgKeywords = /(取件码|凭取件码|提货码|取件凭条|丰巢|菜鸟|兔喜|妈妈驿站|快宝|格格|近邻宝|驿站|快递柜|快件已送达|快递已到达|放入快递柜)/;
    if (!pkgKeywords.test(text)) return null;

    // 1. 取件码提取
    let pickup_code = null;
    const hyphenCode = text.match(/\b([A-Za-z0-9]+-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\b/);
    if (hyphenCode) {
      pickup_code = hyphenCode[1];
    } else {
      const codeMatch = text.match(/(?:取件码|提货码|密码|凭码|凭|提货|取件)(?:为|是|：|:|=|\s|\[|【|\(|\s)*([A-Za-z0-9]{4,8})/);
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
    const stationMatch = cleanBody.match(/([^\s,，。]{2,20}?(?:丰巢柜|丰巢快递柜|丰巢智能柜|菜鸟驿站|兔喜生活超市[^\s,，。]*|兔喜生活|妈妈驿站|快宝驿站|格格快递柜|近邻宝|快递柜|代收点|物业服务中心|物业|驿站|超市))/);
    if (stationMatch) {
      station = cleanStationName(stationMatch[1]);
    } else {
      const genericMatch = text.match(/(菜鸟驿站|丰巢快递柜|丰巢智能柜|丰巢柜|兔喜生活|兔喜|妈妈驿站|顺丰速运|京东派|物业服务中心)/);
      if (genericMatch) station = genericMatch[1];
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
  return false;
}

// 智能分类启发式匹配
function guessCategory(merchant = '', fullText = '') {
  const s = `${merchant} ${fullText}`.toLowerCase();
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
      if (nextRun) {
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
  }

  logMessage(`[Notification] 正在监听系统通知流 (起始 seq: ${lastSeq})...`);

  // 主事件循环（长轮询通知）
  while (true) {
    try {
      // 阻塞等待新通知（超时 15 秒返回）
      const res = await httpGetJson(`${BRIDGE_3181}/notifications-wait?since=${lastSeq}&timeout=15`);
      if (res.ok && res.items && res.items.length > 0) {
        for (const item of res.items) {
          if (item.seq > lastSeq) lastSeq = item.seq;

          // 1. 验证码检测
          const codeInfo = EXTRACTOR.extractCode(item.text || item.bigText, item.title, item.package);
          if (codeInfo) {
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
          const txInfo = EXTRACTOR.extractTransaction(item.text || item.bigText, item.title, item.package);
          if (txInfo) {
            logMessage(`[Bill] 💰 记账: [${txInfo.type === 'expense' ? '支出' : '收入'}] ¥${txInfo.amount.toFixed(2)} (${txInfo.merchant} · ${txInfo.category})`);
            try {
              db.prepare(`
                INSERT INTO transactions (type, amount, merchant, category, account, full_text, created_at, seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(txInfo.type, txInfo.amount, txInfo.merchant, txInfo.category, txInfo.account, txInfo.fullText, Date.now(), item.seq);
            } catch (_) {} // 忽略唯一键冲突
          }

          // 3. 快递取件码检测
          const pkgInfo = EXTRACTOR.extractPackage(item.text || item.bigText, item.title, item.package);
          if (pkgInfo) {
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
        const list = db.prepare(`SELECT * FROM transactions WHERE created_at >= ? ORDER BY id DESC`).all(start);
        console.log(`\n=== 💰 今日消费流水 ===`);
        let total = 0;
        for (const item of list) {
          const sign = item.type === 'expense' ? '-' : '+';
          if (item.type === 'expense') total += item.amount;
          console.log(`${sign} ¥${item.amount.toFixed(2).padStart(7)}  [${item.category}] ${item.merchant} (${item.account})`);
        }
        console.log(`-----------------------------------`);
        console.log(`今日支出合计: ¥${total.toFixed(2)}\n`);
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
        console.log(`本月支出总额: ¥${total.toFixed(2)}\n`);
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
      } else if (sub === 'rm') {
        const id = args[2];
        if (id) {
          db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
          console.log(`✅ 已删除定时任务: ${id}`);
        }
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
          const codeInfo = EXTRACTOR.extractCode(item.text || item.bigText, item.title, item.package);
          if (codeInfo) {
            codeCount++;
            db.prepare(`
              INSERT INTO verification_codes (code, source, full_text, created_at, auto_copied)
              VALUES (?, ?, ?, ?, 0)
            `).run(codeInfo.code, codeInfo.source, codeInfo.fullText, item.time || Date.now());
          }
          const txInfo = EXTRACTOR.extractTransaction(item.text || item.bigText, item.title, item.package);
          if (txInfo) {
            billCount++;
            try {
              db.prepare(`
                INSERT INTO transactions (type, amount, merchant, category, account, full_text, created_at, seq)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(txInfo.type, txInfo.amount, txInfo.merchant, txInfo.category, txInfo.account, txInfo.fullText, item.time || Date.now(), item.seq);
            } catch (_) {}
          }
          const pkgInfo = EXTRACTOR.extractPackage(item.text || item.bigText, item.title, item.package);
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

    default:
      printHelp();
      break;
  }
}

// ==================== 8. Web API 与前端桥接 ====================

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

  const txs = db.prepare(`SELECT id, type, amount, merchant, category, account, created_at FROM transactions ORDER BY id DESC LIMIT 10`).all();
  const tasks = db.prepare(`SELECT id, name, cron_expr, action_type, enabled, last_status, next_run_at FROM scheduled_tasks ORDER BY id ASC`).all();

  const summary = (daemonRunning ? '🟢 守护中' : '⚪ 未启动') + ` · 今日支出 ¥${todayExpense.toFixed(2)}` + (pkgs.length > 0 ? ` · 📦 待取快递 ${pkgs.length} 件` : '');

  return {
    ok: true,
    daemonRunning,
    daemonPid,
    todayExpense,
    todayIncome,
    packages: pkgs,
    codes,
    transactions: txs,
    tasks,
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
        const codeInfo = EXTRACTOR.extractCode(item.text || item.bigText, item.title, item.package);
        if (codeInfo) {
          codeCount++;
          db.prepare(`
            INSERT INTO verification_codes (code, source, full_text, created_at, auto_copied)
            VALUES (?, ?, ?, ?, 0)
          `).run(codeInfo.code, codeInfo.source, codeInfo.fullText, item.time || Date.now());
        }
        const txInfo = EXTRACTOR.extractTransaction(item.text || item.bigText, item.title, item.package);
        if (txInfo) {
          billCount++;
          try {
            db.prepare(`
              INSERT INTO transactions (type, amount, merchant, category, account, full_text, created_at, seq)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(txInfo.type, txInfo.amount, txInfo.merchant, txInfo.category, txInfo.account, txInfo.fullText, item.time || Date.now(), item.seq);
          } catch (_) {}
        }
        const pkgInfo = EXTRACTOR.extractPackage(item.text || item.bigText, item.title, item.package);
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
    openDB,
    computeNextRun,
    CronScheduler,
    getLifeStatus,
    handleLifeAction,
    createHandler
  };
}
