'use strict';
/* 联网搜索（SearXNG）+ 服务器端读网页（防 SSRF、限大小、限时） */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;
const PAGE_TIMEOUT = 8000;

/* ---------- 私网地址判断 ---------- */
function v4ToInt(ip) { return ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0; }
const V4_BLOCK = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([b, m]) => [v4ToInt(b), m === 0 ? 0 : (0xffffffff << (32 - m)) >>> 0]);
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const n = v4ToInt(ip); return V4_BLOCK.some(([b, m]) => ((n & m) >>> 0) === b); }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const m = s.match(/^::(?:ffff:(?:0:)?)?(\d+\.\d+\.\d+\.\d+)$/); if (m) return isPrivateIp(m[1]);
    // IPv4 映射 / 兼容地址的十六进制写法（URL 解析器会把 [::ffff:127.0.0.1] 规范成 [::ffff:7f00:1]）
    const h = s.match(/^::(?:ffff:(?:0:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return isPrivateIp([a >> 8, a & 255, b >> 8, b & 255].join('.')); }
    if (s.startsWith('::')) return true; // 其余以 :: 开头的都不是正常公网地址
    if (s.startsWith('2002:')) return true; // 6to4 可能内嵌私网 IPv4
    if (/^fec/.test(s)) return true;      // 已废弃的 site-local
    if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s)) return true; // ULA / link-local / multicast
    if (s.startsWith('64:ff9b:') || s.startsWith('2001:db8')) return true;
    return false;
  }
  return true;
}
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs || []).filter(a => !isPrivateIp(a.address));
    if (!ok.length) return cb(Object.assign(new Error('blocked private address'), { code: 'EBLOCKED' }));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

/* ---------- 抓取（手动跟随重定向，每一跳都校验） ---------- */
function getRaw(urlStr, hops = 0) {
  return new Promise((resolve0, reject0) => {
    // 总时长上限：防止对方一点点慢慢吐数据拖住连接（'timeout' 只管空闲时间）
    let settled = false, req = null;
    const total = setTimeout(() => { if (req) req.destroy(); reject(new Error('网页打开超时')); }, PAGE_TIMEOUT * 2);
    const resolve = v => { if (!settled) { settled = true; clearTimeout(total); resolve0(v); } };
    const reject = e => { if (!settled) { settled = true; clearTimeout(total); reject0(e); } };
    let u; try { u = new URL(urlStr); } catch (e) { return reject(new Error('网址格式不对')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('只支持 http/https 网址'));
    if (u.username || u.password) return reject(new Error('网址不能带账号密码'));
    if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) return reject(new Error('不支持这个端口'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error('不能访问内网地址'));
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return reject(new Error('不能访问内网地址'));
    const lib = u.protocol === 'https:' ? https : http;
    req = lib.request(u, { method: 'GET', lookup: safeLookup, timeout: PAGE_TIMEOUT, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' } }, res => {
      const sc = res.statusCode || 0;
      if (sc >= 300 && sc < 400 && res.headers.location) {
        res.resume();
        if (hops >= 4) return reject(new Error('重定向次数太多'));
        return resolve(getRaw(new URL(res.headers.location, u).toString(), hops + 1));
      }
      if (sc >= 400) { res.resume(); return reject(new Error('网页返回 ' + sc)); }
      const ct = String(res.headers['content-type'] || '');
      if (ct && !/text\/|html|xml|json/i.test(ct)) { res.resume(); return reject(new Error('不是网页内容（' + ct.split(';')[0] + '）')); }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size > MAX_BYTES) { req.destroy(); resolve({ buf: Buffer.concat(chunks), ct, url: u.toString(), cut: true }); } else chunks.push(c); });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), ct, url: u.toString() }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('网页打开超时')));
    req.on('error', e => reject(e.code === 'EBLOCKED' ? new Error('不能访问内网地址') : e));
    req.end();
  });
}

function decodeBuf(buf, ct) {
  let cs = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) { const head = buf.subarray(0, 4096).toString('latin1'); cs = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1]; }
  cs = (cs || 'utf-8').toLowerCase();
  if (cs === 'gb2312' || cs === 'gbk') cs = 'gb18030';
  try { return new TextDecoder(cs).decode(buf); } catch (e) { return buf.toString('utf8'); }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', middot: '·', copy: '©' };
function decodeEnt(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1); try { return String.fromCodePoint(n); } catch (_) { return m; } }
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
  });
}
function htmlToText(html) {
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  h = h.replace(/<(script|style|noscript|svg|iframe|template|canvas|form|select|button)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt)>/gi, '\n').replace(/<(li)\b[^>]*>/gi, '\n- ').replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEnt(h).replace(/[ \t\u00a0\u3000]+/g, ' ').replace(/ *\n */g, '\n');
  // 去掉过短的导航碎片行
  const codey = l => { if (/\/\*.*\*\/|^[\w$]+\s*:\s*[\w"'.$-]*,?$/.test(l)) return true; if (/^[}\])]|\/\*.*\*\/|^\/\/|;$|[{}]$|^[\w$.]+\s*(\(|=[^=])|'\s*\+|\+\s*'|^(var|let|const|if|for|function|return)\b/.test(l) && !/[\u4e00-\u9fa5]{8,}/.test(l)) return true; const m = l.match(/[{}();=$<>+]|\bfunction\b|\bvar\b|\breturn\b|=>/g); return m && m.length >= 4 && m.length / l.length > 0.04; };
  const lines = h.split('\n').map(l => l.trim()).filter(l => l && !(l.length < 4 && !/[。！？.!?]$/.test(l)) && !codey(l));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/* 段落聚类：找 <p> 最密集的一段，通常就是正文 */
function paragraphCluster(html) {
  const h = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi; let m; const ps = [];
  while ((m = re.exec(h))) {
    const t = decodeEnt(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t\u00a0\u3000]+/g, ' ').trim();
    if (t.length >= 12) ps.push({ i: m.index, e: re.lastIndex, t });
  }
  let best = null, cur = null;
  for (const p of ps) {
    if (cur && p.i - cur.e < 1500) { cur.t.push(p.t); cur.n += p.t.length; cur.e = p.e; }
    else { cur = { t: [p.t], n: p.t.length, e: p.e }; }
    if (!best || cur.n > best.n) best = cur;
  }
  return best ? best.t.join('\n') : '';
}
function extractReadable(html) {
  const title = decodeEnt(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim());
  const desc = decodeEnt((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || '');
  let best = paragraphCluster(html);
  if (best.length >= 300) return { title, desc, text: best };
  best = '';
  for (const tag of ['article', 'main']) {
    const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'gi'); let m;
    while ((m = re.exec(html))) { const t = htmlToText(m[1]); if (t.length > best.length) best = t; }
    if (best.length > 400) break;
  }
  if (best.length < 400) {
    // 找正文最密集的容器：class/id 含 content/article/post/detail/main 的 div
    const re = /<div\b[^>]*(?:class|id)=["'][^"']*(?:content|article|post|detail|main|text|body)[^"']*["'][^>]*>/gi; let m; const cands = [];
    while ((m = re.exec(html)) && cands.length < 40) cands.push(m.index);
    for (const i of cands) { const t = htmlToText(html.slice(i, i + 60000)); if (t.length > best.length) best = t; }
    const body = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
    const bt = htmlToText(body);
    if (best.length < 400 || best.length < bt.length * 0.3) best = bt;
  }
  return { title, desc, text: best };
}

async function readPage(url, maxChars = 6000) {
  const r = await getRaw(url);
  const s = decodeBuf(r.buf, r.ct);
  if (/json/i.test(r.ct)) return { url: r.url, title: '', text: s.slice(0, maxChars) };
  if (/text\/plain/i.test(r.ct)) return { url: r.url, title: '', text: s.slice(0, maxChars) };
  const x = extractReadable(s);
  let text = x.text;
  if (text.length < 80 && x.desc) text = x.desc + (text ? '\n' + text : '');
  return { url: r.url, title: x.title.slice(0, 200), text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

/* ---------- SearXNG ---------- */
function isMostlyAscii(q) { const s = q.replace(/\s/g, ''); if (!s) return false; let a = 0; for (const c of s) if (c.charCodeAt(0) < 128) a++; return a / s.length > 0.9; }
async function searx(base, query, { limit = 6, news = false, timeout = 10000 } = {}) {
  const u = new URL(String(base).replace(/\/+$/, '') + '/search');
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  u.searchParams.set('categories', news ? 'news,general' : 'general,news');
  u.searchParams.set('language', isMostlyAscii(query) ? 'en' : 'zh-CN');
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
  let r;
  try { r = await fetch(u, { signal: ac.signal, headers: { Accept: 'application/json', 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1' } }); }
  finally { clearTimeout(t); }
  if (!r.ok) throw new Error('搜索服务返回 ' + r.status);
  const j = await r.json();
  const seen = new Set(), out = [];
  // 新闻/时效类问题让新闻结果排前面；其余按 SearXNG 打分
  const list = (j.results || []).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const x of list) {
    if (!x.url || !/^https?:/i.test(x.url)) continue;
    const key = x.url.replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/$/, '');
    if (seen.has(key)) continue; seen.add(key);
    out.push({ title: String(x.title || '').replace(/\s+/g, ' ').trim().slice(0, 160), url: x.url, snippet: String(x.content || '').replace(/\s+/g, ' ').trim().slice(0, 300), engine: x.engine || '', date: x.publishedDate || '' });
    if (out.length >= limit) break;
  }
  return { results: out, unresponsive: (j.unresponsive_engines || []).map(e => e[0]) };
}

/* 搜索并读前几页正文 */
async function searchAndRead(base, query, { limit = 6, read = 2, news = false } = {}) {
  const s = await searx(base, query, { limit, news });
  const pages = [];
  if (read > 0 && s.results.length) {
    const top = s.results.slice(0, Math.min(read, 3));
    const got = await Promise.allSettled(top.map(r => Promise.race([readPage(r.url, 3000), new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 9000))])));
    got.forEach((g, i) => { if (g.status === 'fulfilled' && g.value.text && g.value.text.length > 80) pages.push({ n: i + 1, url: top[i].url, title: g.value.title || top[i].title, text: g.value.text }); });
  }
  return { ...s, pages };
}

module.exports = { searx, searchAndRead, readPage, isPrivateIp };
