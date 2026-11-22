'use strict';
/* 邮件发送（零依赖 SMTP）+ 图形人机验证 */
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

/* ---------------- SMTP ---------------- */
function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
function encHeader(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?='; }
function wrap76(s) { return s.replace(/(.{76})/g, '$1\r\n'); }

function smtpSend(cfg, { to, subject, html, text, inline }) {
  return new Promise((resolve, reject) => {
    const port = +cfg.port || 465;
    const secure = port === 465 || cfg.secure;
    let sock, buf = '', step = 0, done = false;
    const timer = setTimeout(() => finish(new Error('邮件服务器响应超时')), 20000);
    function finish(err) { if (done) return; done = true; clearTimeout(timer); try { sock && sock.end(); } catch (_) {} err ? reject(err) : resolve(true); }
    const boundary = 'b' + crypto.randomBytes(12).toString('hex');
    const from = cfg.user;
    const msg = [
      'From: ' + encHeader(cfg.fromName || process.env.SITE_NAME || '问津') + ' <' + from + '>',
      'To: <' + to + '>',
      'Subject: ' + encHeader(subject),
      'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + crypto.randomBytes(10).toString('hex') + '@' + (from.split('@')[1] || 'localhost') + '>',
      'MIME-Version: 1.0',
      ...(inline && inline.length ? ['Content-Type: multipart/related; boundary="r' + boundary + '"', '', '--r' + boundary] : []),
      'Content-Type: multipart/alternative; boundary="' + boundary + '"',
      '',
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(text || '')),
      '--' + boundary,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64(html || '')),
      '--' + boundary + '--',
      ...(inline && inline.length ? inline.flatMap(f => ['--r' + boundary, 'Content-Type: ' + f.type + '; name="' + f.name + '"', 'Content-Transfer-Encoding: base64', 'Content-ID: <' + f.cid + '>', 'Content-Disposition: inline; filename="' + f.name + '"', 'X-Attachment-Id: ' + f.cid, '', wrap76(f.data.toString('base64'))]).concat(['--r' + boundary + '--']) : []),
      ''
    ].join('\r\n');
    const host = cfg.host || 'smtp.qq.com';
    let upgraded = false;
    // 每一步：期望的返回码 + 收到后要发的下一条
    const plan = () => [
      [220, 'EHLO localhost'],
      [250, secure || upgraded ? 'AUTH LOGIN' : 'STARTTLS'],
      ...(secure || upgraded ? [] : [[220, null]]),
      [334, b64(cfg.user)],
      [334, b64(cfg.pass)],
      [235, 'MAIL FROM:<' + from + '>'],
      [250, 'RCPT TO:<' + to + '>'],
      [250, 'DATA'],
      [354, msg + '\r\n.'],
      [250, 'QUIT']
    ];
    let steps = plan();
    function onLine(line) {
      if (/^\d{3}-/.test(line)) return; // 多行响应，等最后一行
      const code = +line.slice(0, 3);
      const [want, next] = steps[step] || [];
      if (code !== want) {
        let m = line.slice(4).trim();
        if (code === 535 || code === 530) m = '邮箱账号或授权码不对（' + m.slice(0, 80) + '）';
        else if (code === 550 || code === 553) m = '收件地址被拒收（' + m.slice(0, 80) + '）';
        return finish(new Error(m || ('SMTP 错误 ' + code)));
      }
      step++;
      if (next === null) { // STARTTLS 升级
        sock.removeAllListeners('data');
        sock = tls.connect({ socket: sock, servername: host }, () => { upgraded = true; steps = plan().slice(1); step = 0; sock.write('EHLO localhost\r\n'); });
        sock.on('data', onData); sock.on('error', e => finish(e));
        return;
      }
      if (next === 'QUIT') { sock.write('QUIT\r\n'); return finish(); }
      if (next) sock.write(next + '\r\n');
    }
    function onData(d) { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); if (!done) onLine(l); } }
    sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    sock.on('data', onData);
    sock.on('error', e => finish(new Error('连不上邮件服务器：' + e.message)));
  });
}

let LOGO = null;
try { LOGO = require('fs').readFileSync(require('path').join(__dirname, 'public', 'logo.png')); } catch (_) {}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* 验证码邮件：表格布局 + 内联样式，QQ 邮箱 / Gmail / Outlook / 手机都能正常显示 */
function codeMail({ site, code, purpose, minutes, email }) {
  const title = purpose === 'reset' ? '重置密码' : '注册账号';
  const lead = purpose === 'reset' ? '你正在重置' + site + '的登录密码，请输入下面的验证码完成验证。' : '欢迎来到' + site + '！请输入下面的验证码完成注册。';
  const digits = String(code).split('').map(d => `<td style="width:44px;height:56px;background:#f4f5f7;border-radius:10px;text-align:center;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:28px;font-weight:700;color:#111;">${d}</td><td style="width:8px"></td>`).join('');
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(site)}验证码</title></head>
<body style="margin:0;padding:0;background:#f2f3f5;-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">你的${esc(title)}验证码是 ${code}，${minutes} 分钟内有效。</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f3f5;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:18px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Helvetica Neue',Arial,sans-serif;">
<tr><td style="padding:28px 32px 0;">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:36px;height:36px;"><img src="cid:xylogo" width="36" height="36" alt="${esc(site)}" style="display:block;width:36px;height:36px;border:0;border-radius:10px;"></td>
<td style="padding-left:10px;font-size:17px;font-weight:600;color:#111;">${esc(site)}</td></tr></table>
</td></tr>
<tr><td style="padding:28px 32px 4px;font-size:22px;font-weight:700;color:#111;letter-spacing:.2px;">${esc(title)}验证码</td></tr>
<tr><td style="padding:6px 32px 22px;font-size:14.5px;line-height:1.7;color:#555a64;">${esc(lead)}</td></tr>
<tr><td style="padding:0 32px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${digits}</tr></table></td></tr>
<tr><td style="padding:18px 32px 0;font-size:13.5px;line-height:1.7;color:#7a7f89;">验证码 <b style="color:#111;">${minutes} 分钟</b>内有效，只能使用一次。</td></tr>
<tr><td style="padding:22px 32px 0;"><div style="height:1px;background:#eceef1;"></div></td></tr>
<tr><td style="padding:16px 32px 28px;font-size:12.5px;line-height:1.75;color:#9a9ea7;">如果这不是你本人的操作，直接忽略这封邮件即可，你的账号不会有任何变化。<br>请不要把验证码告诉任何人，${esc(site)}的工作人员不会向你索要验证码。</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;"><tr><td style="padding:16px 8px;text-align:center;font-size:12px;color:#a3a7af;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">此邮件由系统自动发送，请勿回复 · 发送给 ${esc(email)}</td></tr></table>
</td></tr></table></body></html>`;
  const text = `${site}${title}验证码：${code}\n\n${lead}\n验证码 ${minutes} 分钟内有效，只能使用一次。\n如果不是你本人操作，请忽略这封邮件。`;
  return { subject: `【${site}】${title}验证码 ${code}`, html, text, inline: LOGO ? [{ cid: 'xylogo', name: 'logo.png', type: 'image/png', data: LOGO }] : [] };
}

/* ---------------- 图形人机验证（SVG，服务器生成，不依赖第三方） ---------------- */
const CAP_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const caps = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of caps) if (v.exp < now) caps.delete(k); }, 60e3).unref();
const R = (a, b) => a + Math.random() * (b - a);
function newCaptcha() {
  let text = ''; for (let i = 0; i < 4; i++) text += CAP_CHARS[crypto.randomInt(CAP_CHARS.length)];
  const id = crypto.randomBytes(12).toString('base64url');
  caps.set(id, { text, exp: Date.now() + 5 * 60e3, tries: 0 });
  if (caps.size > 20000) caps.delete(caps.keys().next().value);
  const W = 132, H = 46; const cols = ['#1f2937', '#334155', '#3730a3', '#0f766e', '#7c2d12', '#4c1d95'];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  s += `<rect width="${W}" height="${H}" rx="10" fill="#f4f5f7"/>`;
  for (let i = 0; i < 26; i++) s += `<circle cx="${R(0, W).toFixed(1)}" cy="${R(0, H).toFixed(1)}" r="${R(.6, 1.6).toFixed(1)}" fill="#9aa1ad" opacity="${R(.25, .6).toFixed(2)}"/>`;
  for (let i = 0; i < 3; i++) s += `<path d="M${R(0, 20).toFixed(0)} ${R(5, H - 5).toFixed(0)} C${R(30, 50).toFixed(0)} ${R(0, H).toFixed(0)},${R(80, 100).toFixed(0)} ${R(0, H).toFixed(0)},${R(112, W).toFixed(0)} ${R(5, H - 5).toFixed(0)}" stroke="${cols[i % cols.length]}" stroke-width="${R(1, 1.8).toFixed(1)}" fill="none" opacity=".35"/>`;
  text.split('').forEach((c, i) => {
    const x = 12 + i * 27 + R(-2, 2), y = 33 + R(-3, 3), r = R(-24, 24), sk = R(-12, 12);
    s += `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Georgia,'Times New Roman',serif" font-size="${R(24, 28).toFixed(0)}" font-weight="700" fill="${cols[crypto.randomInt(cols.length)]}" transform="rotate(${r.toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)}) skewX(${sk.toFixed(0)})">${c}</text>`;
  });
  s += `<path d="M4 ${R(18, 30).toFixed(0)} Q${W / 2} ${R(0, H).toFixed(0)} ${W - 4} ${R(14, 32).toFixed(0)}" stroke="#475569" stroke-width="1.6" fill="none" opacity=".55"/>`;
  s += '</svg>';
  return { id, svg: 'data:image/svg+xml;base64,' + Buffer.from(s).toString('base64'), ...(process.env.CAPTCHA_TEST === '1' ? { _t: text } : {}) };
}
// 验证一次后作废，防止重复使用
function checkCaptcha(id, answer) {
  const c = caps.get(String(id || ''));
  if (!c) return false;
  caps.delete(String(id));
  return c.exp > Date.now() && String(answer || '').trim().toUpperCase() === c.text;
}

module.exports = { smtpSend, codeMail, newCaptcha, checkCaptcha };
