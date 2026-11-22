/*
 * 问津 Wenjin · 后台服务
 * 零依赖：只需要 Node.js 18 或更新版本。
 * 启动：node server.js     打开 http://localhost:3000     管理后台 http://localhost:3000/admin
 * 配置：环境变量或同目录下的 .env 文件（见 .env.example）
 *
 * 安全要点：
 *  - 管理员配置的 API Key 只存在服务器 data/db.json 里，任何接口都不会把它原样返回给浏览器。
 *  - 用户的聊天内容只做转发，不落盘；服务器只记录用量（模型、token 数、扣了多少积分）。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/* 读取同目录 .env（不覆盖已存在的环境变量；零依赖实现） */
(function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1); else v = v.replace(/\s+#.*$/, '');
      process.env[m[1]] = v;
    }
  } catch (e) { /* 没有 .env 就用默认值 */ }
})();
const { smtpSend, codeMail, newCaptcha, checkCaptcha } = require('./mailcap');
const WS = require('./websearch');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR ? path.resolve(__dirname, process.env.DATA_DIR) : path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_BODY = 40 * 1024 * 1024; // 长对话可能很大
// TRUST_PROXY：0/不填 = 直连，用 TCP 来源地址；1 = 前面有一层反向代理（nginx / Cloudflare Tunnel 等），
// 取 X-Forwarded-For 的最后一项（由最近一层代理追加，客户端伪造不了）；cloudflare = 优先用 CF-Connecting-IP
// （只有当服务只能经 Cloudflare 访问时才安全）。
const TRUST_PROXY_RAW = String(process.env.TRUST_PROXY || '0').toLowerCase();
const TRUST_PROXY = TRUST_PROXY_RAW !== '0' && TRUST_PROXY_RAW !== 'false' && TRUST_PROXY_RAW !== '';
const SITE_NAME = process.env.SITE_NAME || '问津';
const SEARXNG_URL = process.env.SEARXNG_URL || process.env.SEARCH_URL || 'http://127.0.0.1:8890';
const ENV_SMTP = process.env.SMTP_USER && process.env.SMTP_PASS ? {
  host: process.env.SMTP_HOST || 'smtp.qq.com', port: +process.env.SMTP_PORT || 465,
  user: String(process.env.SMTP_USER).trim().toLowerCase(), pass: process.env.SMTP_PASS, fromName: process.env.SMTP_FROM_NAME || ''
} : null;

/* ---------------- 数据存储（JSON 文件，原子写入） ---------------- */
const DEFAULT_DB = () => ({
  v: 1,
  settings: {
    siteName: SITE_NAME, notice: '', allowSignup: true,
    signupBonus: 100,      // 注册送积分
    checkin: 30,           // 每日签到积分
    streakBonus: 5,        // 连续签到每天额外 +5
    streakMax: 7,          // 连续加成最多算 7 天
    minBalance: 1,         // 余额低于这个值不能发起对话
    maxConcurrent: 3,      // 每个用户同时进行的请求数
    requireEmail: true,    // 注册需要邮箱验证码（发信邮箱配置好之后才生效）
    inviteBonus: 50,       // 邀请成功：邀请人和新用户各得多少积分
    searchOn: true,        // 联网搜索总开关
    searchUrl: SEARXNG_URL // SearXNG 地址（建议只在服务器本机 / 内网访问）
  },
  redeem: [],              // 兑换码 {code,credits,note,created,uid,usedAt}
  smtp: { host: 'smtp.qq.com', port: 465, user: '', pass: '', fromName: '' },
  codes: {},               // email -> {hash, exp, tries, purpose, sent}
  admin: null,             // {salt, hash}
  channels: [],            // {id,name,type,base,key,enabled,created}
  models: [],              // {id,name,channel,upstream,ctx,inPrice,outPrice,think,search,enabled,sort}
  users: [],               // {id,username,salt,hash,credits,created,lastCheckin,streak,banned,used}
  sessions: {},            // token -> {uid, exp, admin?}
  logs: []                 // {t,uid,model,in,out,cost,ok}
});
let db;
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { if (fs.existsSync(DB_FILE)) { fs.copyFileSync(DB_FILE, DB_FILE + '.broken-' + Date.now()); } db = DEFAULT_DB(); }
  const d = DEFAULT_DB();
  for (const k of Object.keys(d)) if (db[k] === undefined) db[k] = d[k];
  db.settings = Object.assign(d.settings, db.settings);
  if (!db.admin && process.env.ADMIN_PASSWORD) db.admin = hashPw(process.env.ADMIN_PASSWORD);
  if (!db.secret) db.secret = crypto.randomBytes(24).toString('hex'); // 邮箱验证码哈希用的站点密钥
  if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
  saveNow();
}
let saveTimer = null;
function save() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400); }
function saveNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });

/* ---------------- 工具函数 ---------------- */
const uid = () => crypto.randomBytes(8).toString('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
function hashPw(pw, salt) { salt = salt || crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') }; }
function checkPw(pw, rec) { if (!rec) return false; const h = crypto.scryptSync(String(pw), rec.salt, 64); const r = Buffer.from(rec.hash, 'hex'); return h.length === r.length && crypto.timingSafeEqual(h, r); }
function today() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); } // 北京时间日期
function yesterday() { return new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 10); }
function maskKey(k) { if (!k) return ''; return k.length <= 10 ? '••••' : k.slice(0, 3) + '••••••' + k.slice(-4); }
const round2 = n => Math.round(n * 100) / 100;
function clientIp(req) {
  const direct = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!TRUST_PROXY) return direct;
  if (TRUST_PROXY_RAW === 'cloudflare' && req.headers['cf-connecting-ip']) return String(req.headers['cf-connecting-ip']).trim();
  // X-Forwarded-For 的第一项可以被客户端随便写；最后一项是最近一层代理追加的真实来源
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (String(req.headers['x-real-ip'] || '').trim() || direct);
}

// 把上游返回的报错里可能出现的 Key、地址抹掉，绝不外泄
function scrub(text) {
  let s = String(text || '').slice(0, 600);
  for (const c of db.channels) {
    if (c.key) s = s.split(c.key).join('***');
    if (c.base) s = s.split(c.base).join('[上游]');
  }
  return s.replace(/(sk|ak|key|Bearer)[-_ ]?[A-Za-z0-9._\-]{12,}/gi, '***');
}

function send(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
const fail = (res, status, message, code) => send(res, status, { error: { message, code: code || status } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, ended = false; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { ended = true; reject(Object.assign(new Error('内容太大'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      ended = true;
      if (!chunks.length) return resolve({});
      let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return reject(Object.assign(new Error('请求格式不对'), { status: 400 })); }
      resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); // 只接受 JSON 对象，避免 null / 数组导致 500
    });
    req.on('error', e => { ended = true; reject(e); });
    req.on('close', () => { if (!ended) { ended = true; reject(Object.assign(new Error('连接已断开'), { status: 400 })); } });
  });
}

/* ---------------- 简单限流 ---------------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++; return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); for (const [t, s] of Object.entries(db.sessions)) if (s.exp < now) delete db.sessions[t]; }, 60e3).unref();

/* ---------------- 会话 ---------------- */
function bearer(req) { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; }
function sessionUser(req) {
  const s = db.sessions[bearer(req)];
  if (!s || s.admin || s.exp < Date.now()) return null;
  const u = db.users.find(x => x.id === s.uid);
  return u && !u.banned ? u : null;
}
function isAdmin(req) { const s = db.sessions[bearer(req)]; return !!(s && s.admin && s.exp > Date.now()); }
function newSession(uidv, admin) { const t = token(); db.sessions[t] = { uid: uidv, admin: !!admin, exp: Date.now() + (admin ? 7 : 30) * 86400e3 }; save(); return t; }

const INV_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genCode(n) { let c = ''; for (let i = 0; i < n; i++) c += INV_CHARS[crypto.randomInt(INV_CHARS.length)]; return c; }
function inviteOf(u) {
  if (!u.inviteCode) { let c; do { c = genCode(6); } while (db.users.some(x => x.inviteCode === c)); u.inviteCode = c; save(); }
  return u.inviteCode;
}
function publicUser(u) {
  return { id: u.id, username: u.username, email: u.email || '', inviteCode: inviteOf(u), invited: u.invited || 0, credits: round2(u.credits), checkedToday: u.lastCheckin === today(), streak: u.lastCheckin === today() || u.lastCheckin === yesterday() ? (u.streak || 0) : 0, created: u.created, used: round2(u.used || 0) };
}
function publicModels() {
  return db.models.filter(m => m.enabled && db.channels.some(c => c.id === m.channel && c.enabled))
    .sort((a, b) => (a.sort || 0) - (b.sort || 0))
    .map(m => ({ id: m.id, name: m.name, ctx: m.ctx || 128000, inPrice: m.inPrice, outPrice: m.outPrice, think: !!m.think, search: !!m.search, desc: m.desc || '' }));
}
function checkinAmount(streakAfter) {
  const s = db.settings; return s.checkin + Math.min(Math.max(streakAfter - 1, 0), s.streakMax - 1) * s.streakBonus;
}

/* ---------------- 模型转发（核心） ---------------- */
const inflight = new Map();
const estTok = s => Math.ceil(String(s || '').length / 1.6);
function estimateInput(body) {
  let n = 0;
  for (const m of body.messages || []) n += estTok(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')) + 4;
  if (body.tools) n += estTok(JSON.stringify(body.tools));
  return n;
}
function priceOf(model, inTok, outTok) {
  const c = (inTok / 1000) * (+model.inPrice || 0) + (outTok / 1000) * (+model.outPrice || 0);
  return c > 0 ? Math.max(0.01, round2(c)) : 0;
}
function charge(u, model, usage, ok) {
  const cost = priceOf(model, usage.in, usage.out);
  u.credits = round2(Math.max(0, u.credits - cost));
  u.used = round2((u.used || 0) + cost);
  db.logs.push({ t: Date.now(), uid: u.id, model: model.id, in: usage.in, out: usage.out, cost, ok: ok !== false });
  if (db.logs.length > 20000) db.logs.splice(0, db.logs.length - 20000);
  save();
  return cost;
}

async function proxyChat(req, res) {
  const u = sessionUser(req);
  if (!u) return fail(res, 401, '请先登录账号', 'login');
  const body = await readBody(req);
  const model = db.models.find(m => m.id === body.model && m.enabled);
  if (!model) return fail(res, 404, '这个模型已下架或不存在，换一个试试', 'model');
  const ch = db.channels.find(c => c.id === model.channel && c.enabled);
  if (!ch) return fail(res, 503, '这个模型暂时不可用，请联系管理员', 'channel');
  if (u.credits < db.settings.minBalance) return fail(res, 402, '积分不够了。每天签到可以领积分', 'credits');
  const n = inflight.get(u.id) || 0;
  if (n >= db.settings.maxConcurrent) return fail(res, 429, '同时进行的对话太多，等一下再发', 'busy');
  if (limited('chat:' + u.id, 40, 60e3)) return fail(res, 429, '发得太快了，休息一下再试', 'rate');

  // 只放行安全字段，模型名替换成上游真实名称
  const up = { model: model.upstream, messages: body.messages };
  for (const k of ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'stop', 'tools', 'tool_choice', 'response_format']) if (body[k] !== undefined) up[k] = body[k];
  const stream = body.stream !== false;
  up.stream = stream;
  if (stream) up.stream_options = { include_usage: true };
  if (ch.type === 'deepseek') {
    up.thinking = { type: body.xy_think && model.think ? 'enabled' : 'disabled' };
  }
  if (!Array.isArray(up.messages) || !up.messages.length) return fail(res, 400, '消息为空');

  inflight.set(u.id, n + 1);
  const done = () => { const v = (inflight.get(u.id) || 1) - 1; if (v <= 0) inflight.delete(u.id); else inflight.set(u.id, v); };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15 * 60e3);
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  let upRes;
  try {
    upRes = await fetch(ch.base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ch.key, ...(ch.headers || {}) },
      body: JSON.stringify(up)
    });
  } catch (e) {
    clearTimeout(timer); done();
    if (ac.signal.aborted) return;
    return fail(res, 502, '服务器连不上模型服务商，稍后再试', 'upstream');
  }

  if (!upRes.ok) {
    const t = await upRes.text().catch(() => '');
    clearTimeout(timer); done();
    let msg = ''; try { const j = JSON.parse(t); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch (e) { msg = t; }
    msg = scrub(typeof msg === 'string' ? msg : JSON.stringify(msg));
    console.warn('[upstream]', ch.name, upRes.status, msg.slice(0, 200));
    if (upRes.status === 401 || upRes.status === 403) return fail(res, 502, '云端模型暂时不可用（渠道配置有问题），请联系管理员', 'upstream');
    if (upRes.status === 402) return fail(res, 502, '云端模型额度用完了，请联系管理员', 'upstream');
    if (upRes.status === 429) return fail(res, 429, '云端模型太忙了，稍等再试', 'upstream_busy');
    if (upRes.status === 400) return fail(res, 400, '请求被模型拒绝：' + msg.slice(0, 200), 'bad');
    return fail(res, 502, '模型服务出错（' + upRes.status + '），稍后再试', 'upstream');
  }

  const inEst = estimateInput(up);
  if (!stream) {
    const j = await upRes.json().catch(() => ({}));
    clearTimeout(timer); done();
    const usage = j.usage ? { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 } : { in: inEst, out: estTok(JSON.stringify(j.choices || '')) };
    const cost = charge(u, model, usage);
    j.model = model.id; j.xy = { cost, credits: u.credits };
    return send(res, 200, j);
  }

  sseStart(res);
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15e3);
  let buf = '', outChars = 0, usage = null, sawDone = false, pend = '';
  const dec = new TextDecoder();
  const handleLine = line => {
    const tline = line.trim();
    if (tline.startsWith('data:')) {
      const d = tline.slice(5).trim();
      if (d === '[DONE]') { sawDone = true; return; } // 稍后在末尾补上
      try {
        const j = JSON.parse(d);
        if (j.usage) usage = { in: j.usage.prompt_tokens || 0, out: j.usage.completion_tokens || 0 };
        const dl = j.choices && j.choices[0] && j.choices[0].delta;
        if (dl) { outChars += (dl.content || '').length + (dl.reasoning_content || '').length + (dl.tool_calls ? JSON.stringify(dl.tool_calls).length : 0); }
        if (j.model) j.model = model.id; // 不暴露上游真实模型名
        pend += 'data: ' + JSON.stringify(j) + '\n\n';
        return;
      } catch (e) { /* 原样转发 */ }
    }
    if (tline && !tline.startsWith(':')) pend += line + '\n';
  };
  try {
    for await (const chunk of upRes.body) {
      buf += dec.decode(chunk, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handleLine(line); }
      if (pend && !res.writableEnded) { res.write(pend); pend = ''; } // 每收到一块就立刻整块转发
    }
    if (buf) handleLine(buf);
    if (pend && !res.writableEnded) res.write(pend);
  } catch (e) { /* 用户中途停止或网络断开 */ }
  clearInterval(ping); clearTimeout(timer); done();
  const final = usage || { in: inEst, out: Math.ceil(outChars / 1.6) };
  const cost = (final.out > 0 || usage) ? charge(u, model, final, !ac.signal.aborted) : 0;
  if (!res.writableEnded) {
    res.write('data: ' + JSON.stringify({ xy: { cost, credits: u.credits, usage: final } }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/* SSE：关掉 Nagle、立刻发出响应头和一个注释行，让代理和浏览器马上进入流式模式 */
function sseStart(res) {
  try { res.socket && res.socket.setNoDelay(true); } catch (e) {}
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': ok\n\n');
}

/* ---------------- 静态文件 ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream', '.ktx2': 'image/ktx2', '.md': 'text/markdown; charset=utf-8' };
function serveStatic(req, res, p) {
  if (p === '/admin' || p === '/admin/') p = '/admin.html';
  let rel; try { rel = decodeURIComponent(p); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  if (path.basename(file).startsWith('.')) { res.writeHead(404); return res.end('404'); } // 不暴露隐藏文件
  fs.stat(file, (e, st) => {
    if (!e && st.isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); return res.end(); } // 子目录（例如放在 public/ 下的其他静态小站）
      file = path.join(file, 'index.html');
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
      const ext = path.extname(file);
      const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': p.includes('/assets/') ? 'public, max-age=86400' : 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
      if (ext === '.html') h['X-Frame-Options'] = 'SAMEORIGIN';
      res.writeHead(200, h);
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

/* ---------------- 路由 ---------------- */
const USERNAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_\-.@]{2,24}$/;
function needAdmin(req, res) { if (!isAdmin(req)) { fail(res, 401, '请先登录管理后台', 'admin'); return false; } return true; }
function adminState() {
  const now = Date.now(), dayAgo = now - 86400e3;
  const logs24 = db.logs.filter(l => l.t > dayAgo);
  return {
    settings: db.settings,
    smtp: { host: smtpCfg().host, port: smtpCfg().port, user: smtpCfg().user, fromName: smtpCfg().fromName, hasPass: !!smtpCfg().pass, ready: mailReady(), fromEnv: !!ENV_SMTP },
    channels: db.channels.map(c => ({ ...c, key: undefined, keyMask: maskKey(c.key), hasKey: !!c.key })),
    models: db.models,
    stats: {
      users: db.users.length,
      newUsers24: db.users.filter(u => u.created > dayAgo).length,
      checkins: db.users.filter(u => u.lastCheckin === today()).length,
      calls24: logs24.length,
      tokens24: logs24.reduce((a, l) => a + l.in + l.out, 0),
      credits24: round2(logs24.reduce((a, l) => a + l.cost, 0)),
      creditsOut: round2(db.users.reduce((a, u) => a + u.credits, 0)),
      byDay: Array.from({ length: 7 }, (_, i) => { const s = now - (6 - i) * 86400e3; const d = new Date(s + 8 * 3600e3).toISOString().slice(0, 10); const ls = db.logs.filter(l => new Date(l.t + 8 * 3600e3).toISOString().slice(0, 10) === d); return { d: d.slice(5), calls: ls.length, cost: round2(ls.reduce((a, l) => a + l.cost, 0)) }; })
    }
  };
}
function cleanChannel(b, old) {
  const c = old || { id: uid(), created: Date.now() };
  if (b.name !== undefined) c.name = String(b.name).slice(0, 40) || '未命名渠道';
  if (b.type !== undefined) c.type = b.type === 'deepseek' ? 'deepseek' : 'openai';
  // 管理员常把完整接口地址贴进来（…/v1/chat/completions、…/v1/responses），统一截成 …/v1 这样的基础地址
  if (b.base !== undefined) c.base = String(b.base).trim().replace(/\/+$/, '').replace(/\/(chat\/completions|completions|responses|models)$/i, '');
  if (b.key) c.key = String(b.key).trim();           // 留空表示不修改
  if (b.enabled !== undefined) c.enabled = !!b.enabled;
  if (c.enabled === undefined) c.enabled = true;
  return c;
}
function cleanModel(b, old) {
  const m = old || { id: '', enabled: true, sort: db.models.length };
  for (const k of ['name', 'channel', 'upstream', 'desc']) if (b[k] !== undefined) m[k] = String(b[k]).trim().slice(0, 120);
  if (b.id !== undefined && !old) m.id = String(b.id).trim().replace(/[^\w.\-:]/g, '').slice(0, 60);
  for (const k of ['ctx', 'inPrice', 'outPrice', 'sort']) if (b[k] !== undefined) m[k] = Math.max(0, +b[k] || 0);
  for (const k of ['think', 'search', 'enabled']) if (b[k] !== undefined) m[k] = !!b[k];
  return m;
}

const EMAIL_RE = /^[^\s@<>()"',;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const normEmail = e => String(e || '').trim().toLowerCase();
const smtpCfg = () => ENV_SMTP || db.smtp; // 环境变量里配置了 SMTP_USER/SMTP_PASS 时优先使用
const mailReady = () => { const m = smtpCfg(); return !!(m && m.user && m.pass); };
const needEmail = () => db.settings.requireEmail && mailReady();
const codeHash = (email, code) => crypto.createHash('sha256').update(email + ':' + code + ':' + db.secret).digest('hex');
function verifyCode(email, code, purpose) {
  const c = db.codes[email];
  if (!c || c.purpose !== purpose || c.exp < Date.now()) return '验证码已过期，请重新获取';
  if (c.tries >= 5) { delete db.codes[email]; save(); return '错误次数太多，请重新获取验证码'; }
  if (codeHash(email, String(code || '').trim()) !== c.hash) { c.tries++; save(); return '验证码不对'; }
  delete db.codes[email]; save(); return '';
}
const loginFails = new Map(); // ip -> {n, reset}
function failCount(ip) { const f = loginFails.get(ip); if (!f || f.reset < Date.now()) return 0; return f.n; }
function addFail(ip) { const f = loginFails.get(ip); if (!f || f.reset < Date.now()) loginFails.set(ip, { n: 1, reset: Date.now() + 15 * 60e3 }); else f.n++; }

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, M = req.method;
  if (M === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE' }); return res.end(); }
  if (!p.startsWith('/api/')) { if (M !== 'GET' && M !== 'HEAD') return fail(res, 405, 'Method not allowed'); return serveStatic(req, res, p); }
  const ip = clientIp(req);

  /* ---- 公开 ---- */
  /* ---- 联网工具：搜索 / 读网页（需要登录，防止被当成匿名搜索代理 / 抓取代理；按账号和 IP 限流） ---- */
  if ((p === '/api/tools/search' || p === '/api/tools/read') && M === 'POST') {
    const tu = sessionUser(req);
    if (!tu) return fail(res, 401, '联网搜索需要先登录账号', 'login');
    if (limited('tool:' + tu.id, 30, 60e3) || limited('toolip:' + ip, 60, 60e3)) return fail(res, 429, '联网请求太频繁，稍等一下', 'rate');
    const b = await readBody(req);
    if (p === '/api/tools/search') {
      if (!db.settings.searchOn) return fail(res, 503, '管理员关闭了联网搜索', 'search_off');
      const q = String(b.query || '').trim().slice(0, 200);
      if (!q) return fail(res, 400, '搜索词为空');
      try {
        const r = await WS.searchAndRead(db.settings.searchUrl, q, { limit: Math.min(10, Math.max(1, +b.limit || 6)), read: Math.min(3, Math.max(0, b.read === undefined ? 2 : +b.read || 0)), news: !!b.news });
        return send(res, 200, r);
      } catch (e) { console.warn('[search]', e.message); return fail(res, 502, '联网搜索暂时不可用，请稍后再试', 'search'); }
    }
    try { return send(res, 200, await WS.readPage(String(b.url || '').trim().slice(0, 2000), Math.min(12000, Math.max(500, +b.max || 8000)))); }
    catch (e) { return fail(res, 502, '网页打不开：' + String(e.message || e).slice(0, 120), 'read'); }
  }
  if (p === '/api/config' && M === 'GET') { const s = db.settings; return send(res, 200, { siteName: s.siteName, notice: s.notice, allowSignup: s.allowSignup, signupBonus: s.signupBonus, checkin: s.checkin, streakBonus: s.streakBonus, streakMax: s.streakMax, models: publicModels(), adminReady: !!db.admin, needEmail: needEmail(), inviteBonus: s.inviteBonus, search: !!s.searchOn }); }

  if (p === '/api/captcha' && M === 'GET') { if (limited('cap:' + ip, 60, 600e3)) return fail(res, 429, '刷新太频繁，稍后再试'); return send(res, 200, newCaptcha()); }
  if (p === '/api/email/code' && M === 'POST') {
    const b = await readBody(req); const email = normEmail(b.email); const purpose = b.purpose === 'reset' ? 'reset' : 'register';
    if (!mailReady()) return fail(res, 503, '站点还没配置发信邮箱，请联系管理员');
    if (!EMAIL_RE.test(email)) return fail(res, 400, '邮箱格式不对');
    if (!checkCaptcha(b.captchaId, b.captcha)) return fail(res, 400, '图形验证码不对，换一张再试', 'captcha');
    if (limited('mailip:' + ip, 15, 3600e3)) return fail(res, 429, '发送太频繁，过一会儿再试');
    const old = db.codes[email];
    if (old && old.sent > Date.now() - 60e3) return fail(res, 429, '验证码刚发过，' + Math.ceil((old.sent + 60e3 - Date.now()) / 1000) + ' 秒后再试');
    if (limited('maild:' + email, 10, 86400e3)) return fail(res, 429, '这个邮箱今天收到的验证码太多了，明天再试');
    const exists = db.users.find(u => u.email === email);
    if (purpose === 'register' && exists) return fail(res, 409, '这个邮箱已经注册过了，直接登录就行');
    if (purpose === 'reset' && !exists) return send(res, 200, { ok: true, wait: 60 }); // 不暴露邮箱是否注册
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    try {
      await smtpSend(smtpCfg(), { to: email, ...codeMail({ site: db.settings.siteName || SITE_NAME, code, purpose, minutes: 10, email }) });
    } catch (e) { console.error('[mail]', e.message); return fail(res, 502, '验证码发送失败，请稍后再试'); }
    db.codes[email] = { hash: codeHash(email, code), exp: Date.now() + 10 * 60e3, tries: 0, purpose, sent: Date.now() };
    for (const [k, v] of Object.entries(db.codes)) if (v.exp < Date.now()) delete db.codes[k];
    save(); return send(res, 200, { ok: true, wait: 60 });
  }
  if (p === '/api/reset' && M === 'POST') {
    if (limited('reset:' + ip, 10, 600e3)) return fail(res, 429, '尝试次数太多，稍后再试');
    const b = await readBody(req); const email = normEmail(b.email); const pw = String(b.password || '');
    if (pw.length < 6 || pw.length > 128) return fail(res, 400, '新密码至少 6 位');
    const err = verifyCode(email, b.code, 'reset'); if (err) return fail(res, 400, err);
    const u = db.users.find(x => x.email === email); if (!u) return fail(res, 400, '验证码不对');
    Object.assign(u, hashPw(pw)); for (const [t, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[t];
    save(); return send(res, 200, { token: newSession(u.id), user: publicUser(u), models: publicModels() });
  }
  if (p === '/api/register' && M === 'POST') {
    if (!db.settings.allowSignup) return fail(res, 403, '暂时关闭了注册');
    if (limited('reg:' + ip, 5, 3600e3)) return fail(res, 429, '注册太频繁，过一会儿再试');
    const b = await readBody(req); const name = String(b.username || '').trim(); const pw = String(b.password || '');
    if (!USERNAME_RE.test(name)) return fail(res, 400, '用户名 2 到 24 个字，可以用中文、字母、数字');
    if (pw.length < 6 || pw.length > 128) return fail(res, 400, '密码至少 6 位');
    if (db.users.some(u => u.username.toLowerCase() === name.toLowerCase())) return fail(res, 409, '这个用户名已经被用了');
    let email = '';
    if (needEmail()) {
      email = normEmail(b.email);
      if (!EMAIL_RE.test(email)) return fail(res, 400, '请填写正确的邮箱');
      if (db.users.some(u => u.email === email)) return fail(res, 409, '这个邮箱已经注册过了，直接登录就行');
      const err = verifyCode(email, b.code, 'register'); if (err) return fail(res, 400, err, 'code');
    } else if (!checkCaptcha(b.captchaId, b.captcha)) return fail(res, 400, '图形验证码不对，换一张再试', 'captcha');
    const u = { id: uid(), username: name, email, ...hashPw(pw), credits: db.settings.signupBonus, created: Date.now(), lastCheckin: '', streak: 0, banned: false, used: 0 };
    const invCode = String(b.invite || '').trim().toUpperCase();
    let invitedBonus = 0;
    if (invCode && db.settings.inviteBonus > 0) {
      const inviter = db.users.find(x => x.inviteCode === invCode && !x.banned);
      // 同一 IP 一天内只给邀请人记 3 次，防止自己刷
      if (inviter && !limited('inv:' + inviter.id + ':' + ip, 3, 86400e3)) {
        inviter.credits = round2(inviter.credits + db.settings.inviteBonus); inviter.invited = (inviter.invited || 0) + 1;
        u.credits = round2(u.credits + db.settings.inviteBonus); u.invitedBy = inviter.id; invitedBonus = db.settings.inviteBonus;
      }
    }
    db.users.push(u); save();
    return send(res, 200, { token: newSession(u.id), user: publicUser(u), models: publicModels(), invitedBonus });
  }
  if (p === '/api/login' && M === 'POST') {
    if (limited('login:' + ip, 12, 600e3)) return fail(res, 429, '尝试次数太多，10 分钟后再试');
    const b = await readBody(req); const name = String(b.username || '').trim().toLowerCase();
    if (failCount(ip) >= 3 && !checkCaptcha(b.captchaId, b.captcha)) return fail(res, 400, b.captchaId ? '图形验证码不对，换一张再试' : '为了账号安全，请先完成图形验证', 'captcha');
    const u = db.users.find(x => x.username.toLowerCase() === name || (x.email && x.email === name));
    if (!u || !checkPw(b.password, u)) { addFail(ip); console.warn('[login-fail] ip=' + ip); return fail(res, 401, '账号或密码不对', failCount(ip) >= 3 ? 'captcha' : 401); }
    loginFails.delete(ip);
    if (u.banned) return fail(res, 403, '这个账号已被停用');
    return send(res, 200, { token: newSession(u.id), user: publicUser(u), models: publicModels() });
  }
  if (p === '/api/logout' && M === 'POST') { delete db.sessions[bearer(req)]; save(); return send(res, 200, { ok: true }); }

  /* ---- 用户 ---- */
  if (p === '/api/me' && M === 'GET') { const u = sessionUser(req); if (!u) return fail(res, 401, '登录已过期，请重新登录', 'login'); return send(res, 200, { user: publicUser(u), models: publicModels(), nextCheckin: checkinAmount(u.lastCheckin === yesterday() ? (u.streak || 0) + 1 : 1) }); }
  if (p === '/api/checkin' && M === 'POST') {
    const u = sessionUser(req); if (!u) return fail(res, 401, '请先登录', 'login');
    if (u.lastCheckin === today()) return fail(res, 409, '今天已经签到过了，明天再来');
    u.streak = u.lastCheckin === yesterday() ? (u.streak || 0) + 1 : 1;
    const gained = checkinAmount(u.streak);
    u.credits = round2(u.credits + gained); u.lastCheckin = today(); save();
    return send(res, 200, { gained, user: publicUser(u), tomorrow: checkinAmount(u.streak + 1) });
  }
  if (p === '/api/redeem' && M === 'POST') {
    const u = sessionUser(req); if (!u) return fail(res, 401, '请先登录', 'login');
    if (limited('redeem:' + u.id, 10, 600e3)) return fail(res, 429, '尝试太频繁，10 分钟后再试');
    const b = await readBody(req); const code = String(b.code || '').trim().toUpperCase().replace(/[\s-]/g, '');
    const r = db.redeem.find(x => x.code === code);
    if (!r) return fail(res, 400, '兑换码不存在，检查一下有没有输错');
    if (r.uid) return fail(res, 409, '这个兑换码已经被用过了');
    if (r.exp && r.exp < Date.now()) return fail(res, 410, '这个兑换码已经过期了');
    r.uid = u.id; r.usedAt = Date.now(); u.credits = round2(u.credits + r.credits); save();
    return send(res, 200, { gained: r.credits, user: publicUser(u) });
  }
  if (p === '/api/usage' && M === 'GET') {
    const u = sessionUser(req); if (!u) return fail(res, 401, '请先登录', 'login');
    const ls = []; for (let i = db.logs.length - 1; i >= 0 && ls.length < 40; i--) if (db.logs[i].uid === u.id) ls.push(db.logs[i]);
    const names = Object.fromEntries(db.models.map(m => [m.id, m.name]));
    return send(res, 200, { logs: ls.map(l => ({ t: l.t, model: names[l.model] || l.model, in: l.in, out: l.out, cost: l.cost })) });
  }
  if (p === '/api/password' && M === 'POST') {
    const u = sessionUser(req); if (!u) return fail(res, 401, '请先登录', 'login');
    if (limited('pw:' + u.id, 8, 600e3)) return fail(res, 429, '尝试次数太多，10 分钟后再试');
    const b = await readBody(req);
    if (!checkPw(b.old, u)) return fail(res, 400, '原密码不对');
    if (String(b.password || '').length < 6 || String(b.password).length > 128) return fail(res, 400, '新密码 6 到 128 位');
    Object.assign(u, hashPw(b.password));
    for (const [t, s] of Object.entries(db.sessions)) if (s.uid === u.id && t !== bearer(req)) delete db.sessions[t];
    save(); return send(res, 200, { ok: true });
  }

  /* ---- 兼容 OpenAI 的接口（前端调用这里，服务器替它带上管理员的 Key） ---- */
  if (p === '/api/v1/models' && M === 'GET') return send(res, 200, { object: 'list', data: publicModels().map(m => ({ id: m.id, object: 'model', name: m.name })) });
  if (p === '/api/v1/chat/completions' && M === 'POST') return proxyChat(req, res);

  /* ---- 管理后台 ---- */
  if (p === '/api/admin/setup' && M === 'POST') {
    if (db.admin) return fail(res, 409, '管理员密码已经设置过了');
    if (limited('admin:' + ip, 8, 900e3)) return fail(res, 429, '尝试次数太多，15 分钟后再试');
    const b = await readBody(req); if (String(b.password || '').length < 8) return fail(res, 400, '管理员密码至少 8 位');
    db.admin = hashPw(b.password); save();
    return send(res, 200, { token: newSession('admin', true) });
  }
  if (p === '/api/admin/login' && M === 'POST') {
    if (limited('admin:' + ip, 8, 900e3)) return fail(res, 429, '尝试次数太多，15 分钟后再试');
    const b = await readBody(req); if (!db.admin || !checkPw(b.password, db.admin)) return fail(res, 401, '密码不对');
    return send(res, 200, { token: newSession('admin', true) });
  }
  if (p.startsWith('/api/admin/')) {
    if (!needAdmin(req, res)) return;
    const seg = p.split('/').slice(3); // ['state'] / ['channels', id, 'test']
    if (seg[0] === 'state' && M === 'GET') return send(res, 200, adminState());
    if (seg[0] === 'settings' && M === 'PUT') {
      const b = await readBody(req); const s = db.settings;
      for (const k of ['siteName', 'notice']) if (b[k] !== undefined) s[k] = String(b[k]).replace(/[\r\n]+/g, k === 'notice' ? '\n' : ' ').slice(0, k === 'notice' ? 500 : 30);
      for (const k of ['signupBonus', 'checkin', 'streakBonus', 'streakMax', 'minBalance', 'maxConcurrent', 'inviteBonus']) if (b[k] !== undefined) s[k] = Math.max(0, +b[k] || 0);
      if (s.streakMax < 1) s.streakMax = 1; if (s.maxConcurrent < 1) s.maxConcurrent = 1;
      if (b.allowSignup !== undefined) s.allowSignup = !!b.allowSignup;
      if (b.requireEmail !== undefined) s.requireEmail = !!b.requireEmail;
      if (b.searchOn !== undefined) s.searchOn = !!b.searchOn;
      if (b.searchUrl !== undefined) { const v = String(b.searchUrl).trim().replace(/\/+$/, ''); if (v && !/^https?:\/\/[^\s]+$/.test(v)) return fail(res, 400, '搜索服务地址要以 http:// 或 https:// 开头'); s.searchUrl = (v || SEARXNG_URL).slice(0, 300); }
      if (b.adminPassword) { if (String(b.adminPassword).length < 8) return fail(res, 400, '管理员密码至少 8 位'); db.admin = hashPw(b.adminPassword); }
      save(); return send(res, 200, adminState());
    }
    if (seg[0] === 'search' && seg[1] === 'test' && M === 'POST') {
      const b = await readBody(req); const t0 = Date.now();
      try { const r = await WS.searx(String(b.url || db.settings.searchUrl), String(b.q || '今天的新闻').slice(0, 100), { limit: 5 }); return send(res, 200, { ok: true, ms: Date.now() - t0, count: r.results.length, unresponsive: r.unresponsive, results: r.results }); }
      catch (e) { return fail(res, 502, '搜索服务连不上：' + (e.name === 'AbortError' ? '超时' : e.message)); }
    }
    if (seg[0] === 'codes') {
      if (M === 'GET') {
        const names = Object.fromEntries(db.users.map(u => [u.id, u.username]));
        return send(res, 200, { codes: db.redeem.slice(-500).reverse().map(r => ({ ...r, user: r.uid ? (names[r.uid] || '已删除') : '' })), total: db.redeem.length, used: db.redeem.filter(r => r.uid).length });
      }
      if (M === 'POST') {
        const b = await readBody(req); const n = Math.min(200, Math.max(1, +b.count || 1)); const credits = Math.max(1, Math.min(1e6, +b.credits || 0));
        if (!+b.credits) return fail(res, 400, '请填每个兑换码的积分');
        const note = String(b.note || '').slice(0, 40); const days = Math.max(0, +b.days || 0); const out = [];
        for (let i = 0; i < n; i++) { let c; do { c = genCode(4) + genCode(4) + genCode(4); } while (db.redeem.some(r => r.code === c)); const r = { code: c, credits, note, created: Date.now(), uid: '', usedAt: 0, exp: days ? Date.now() + days * 86400e3 : 0 }; db.redeem.push(r); out.push(r); }
        save(); return send(res, 200, { codes: out });
      }
      if (M === 'DELETE' && seg[1]) { db.redeem = db.redeem.filter(r => r.code !== seg[1] || r.uid); save(); return send(res, 200, { ok: true }); }
    }
    if (seg[0] === 'smtp' && M === 'PUT' && !seg[1]) {
      if (ENV_SMTP) return fail(res, 400, '发信邮箱由服务器环境变量（SMTP_*）配置，请修改 .env 后重启');
      const b = await readBody(req); const m = db.smtp;
      if (b.host !== undefined) m.host = String(b.host).trim().slice(0, 100) || 'smtp.qq.com';
      if (b.port !== undefined) m.port = +b.port || 465;
      if (b.user !== undefined) m.user = normEmail(b.user);
      if (b.fromName !== undefined) m.fromName = String(b.fromName).slice(0, 30);
      if (b.pass) m.pass = String(b.pass).trim();
      save(); return send(res, 200, adminState());
    }
    if (seg[0] === 'smtp' && seg[1] === 'test' && M === 'POST') {
      const b = await readBody(req); const to = normEmail(b.to || smtpCfg().user);
      if (!mailReady()) return fail(res, 400, '先填好发信邮箱和授权码');
      if (!EMAIL_RE.test(to)) return fail(res, 400, '收件邮箱格式不对');
      try { await smtpSend(smtpCfg(), { to, ...codeMail({ site: db.settings.siteName || SITE_NAME, code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), purpose: 'register', minutes: 10, email: to }) }); return send(res, 200, { ok: true }); }
      catch (e) { return fail(res, 502, '发送失败：' + String(e.message).split(smtpCfg().pass).join('***').slice(0, 200)); }
    }
    if (seg[0] === 'channels') {
      if (M === 'POST' && !seg[1]) { const b = await readBody(req); if (!/^https?:\/\//.test(b.base || '')) return fail(res, 400, '接口地址要以 http:// 或 https:// 开头'); if (!b.key) return fail(res, 400, '请填 API Key'); db.channels.push(cleanChannel(b)); save(); return send(res, 200, adminState()); }
      const c = db.channels.find(x => x.id === seg[1]); if (!c) return fail(res, 404, '渠道不存在');
      if (M === 'PUT' && !seg[2]) { const b = await readBody(req); if (b.base !== undefined && !/^https?:\/\//.test(b.base)) return fail(res, 400, '接口地址要以 http:// 或 https:// 开头'); cleanChannel(b, c); save(); return send(res, 200, adminState()); }
      if (M === 'DELETE') { db.channels = db.channels.filter(x => x !== c); db.models = db.models.filter(m => m.channel !== c.id); save(); return send(res, 200, adminState()); }
      if (seg[2] === 'models' && M === 'GET') {
        try { const r = await fetch(c.base + '/models', { headers: { Authorization: 'Bearer ' + c.key }, signal: AbortSignal.timeout(15000) }); const t = await r.text(); if (!r.ok) return fail(res, 502, '获取失败（' + r.status + '）：' + scrub(t).slice(0, 160)); const j = JSON.parse(t); return send(res, 200, { ids: (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean).slice(0, 300) }); }
        catch (e) { return fail(res, 502, '连不上：' + scrub(e.message)); }
      }
      if (seg[2] === 'test' && M === 'POST') {
        const b = await readBody(req); const model = b.model || (db.models.find(m => m.channel === c.id) || {}).upstream;
        if (!model) return fail(res, 400, '先填一个模型名再测试');
        const t0 = Date.now();
        try {
          const body = { model, messages: [{ role: 'user', content: '用五个字回复：你好' }], max_tokens: 30 };
          if (c.type === 'deepseek') body.thinking = { type: 'disabled' };
          const r = await fetch(c.base + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.key }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
          const t = await r.text(); if (!r.ok) return fail(res, 502, '失败（' + r.status + '）：' + scrub(t).slice(0, 200));
          const j = JSON.parse(t); return send(res, 200, { ok: true, ms: Date.now() - t0, reply: ((j.choices || [])[0] || {}).message?.content || '' });
        } catch (e) { return fail(res, 502, '连不上：' + scrub(e.message)); }
      }
    }
    if (seg[0] === 'models') {
      if (M === 'POST' && !seg[1]) {
        const b = await readBody(req); const m = cleanModel(b);
        if (!m.id) m.id = (m.upstream || 'model').replace(/[^\w.\-]/g, '-').toLowerCase();
        if (db.models.some(x => x.id === m.id)) return fail(res, 409, '对外 ID 重复了，换一个');
        if (!db.channels.some(c => c.id === m.channel)) return fail(res, 400, '请选择渠道');
        if (!m.upstream) return fail(res, 400, '请填上游模型名');
        if (!m.name) m.name = m.upstream; if (!m.ctx) m.ctx = 128000;
        if (m.inPrice === undefined) m.inPrice = 1; if (m.outPrice === undefined) m.outPrice = 2;
        db.models.push(m); save(); return send(res, 200, adminState());
      }
      const m = db.models.find(x => x.id === seg[1]); if (!m) return fail(res, 404, '模型不存在');
      if (M === 'PUT') { cleanModel(await readBody(req), m); save(); return send(res, 200, adminState()); }
      if (M === 'DELETE') { db.models = db.models.filter(x => x !== m); save(); return send(res, 200, adminState()); }
    }
    if (seg[0] === 'users') {
      if (M === 'GET' && !seg[1]) {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const list = db.users.filter(u => !q || u.username.toLowerCase().includes(q) || (u.email || '').includes(q)).sort((a, b) => b.created - a.created).slice(0, 300);
        return send(res, 200, { total: db.users.length, users: list.map(u => ({ ...publicUser(u), banned: !!u.banned, lastCheckin: u.lastCheckin })) });
      }
      const u = db.users.find(x => x.id === seg[1]); if (!u) return fail(res, 404, '用户不存在');
      if (M === 'PUT') {
        const b = await readBody(req);
        if (b.delta) u.credits = round2(Math.max(0, u.credits + (+b.delta || 0)));
        if (b.credits !== undefined) u.credits = round2(Math.max(0, +b.credits || 0));
        if (b.banned !== undefined) { u.banned = !!b.banned; if (u.banned) for (const [t, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[t]; }
        if (b.password) { if (String(b.password).length < 6) return fail(res, 400, '密码至少 6 位'); Object.assign(u, hashPw(b.password)); }
        save(); return send(res, 200, { user: { ...publicUser(u), banned: !!u.banned, lastCheckin: u.lastCheckin } });
      }
      if (M === 'DELETE') { db.users = db.users.filter(x => x !== u); for (const [t, s] of Object.entries(db.sessions)) if (s.uid === u.id) delete db.sessions[t]; save(); return send(res, 200, { ok: true }); }
    }
    if (seg[0] === 'logs' && M === 'GET') {
      const names = Object.fromEntries(db.users.map(u => [u.id, u.username]));
      return send(res, 200, { logs: db.logs.slice(-200).reverse().map(l => ({ ...l, user: names[l.uid] || '已删除' })) });
    }
    return fail(res, 404, '没有这个接口');
  }
  return fail(res, 404, '没有这个接口');
}

loadDb();
http.createServer((req, res) => {
  route(req, res).catch(e => { console.error(e); if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : '服务器出错了'); else try { res.end(); } catch (_) {} });
}).listen(PORT, HOST, () => {
  console.log('\n  ' + (db.settings.siteName || SITE_NAME) + ' 已启动');
  console.log('  聊天页面：  http://localhost:' + PORT);
  console.log('  管理后台：  http://localhost:' + PORT + '/admin' + (db.admin ? '' : '   （第一次打开会让你设置管理员密码）'));
  console.log('  数据文件：  ' + DB_FILE + '\n');
  if (!db.admin) console.warn('  [注意] 还没有管理员密码：请尽快打开 /admin 设置，或用环境变量 ADMIN_PASSWORD 预先指定。\n');
});
