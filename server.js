// Gaplashish v2: chat (WebSocket) + brauzerdagi SSH terminal (WebSocket -> ssh2).
// json-server ishlatilmaydi.
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')); } catch (e) { return fallback; }
}
const cfg = Object.assign(
  { port: 3000, host: '127.0.0.1', sshHost: '127.0.0.1', sshPort: 22, accessCode: '', maxSessions: 3, idleMinutes: 30, allowedOrigins: [] },
  readJson('config.json', {})
);
// Kirish kodi: config.json da yozilmasa, har ishga tushganda tasodifiy yaratiladi
const ACCESS_CODE = String(cfg.accessCode || crypto.randomBytes(4).toString('hex'));

/* ---------- Express: statik fayllar ---------- */
const app = express();
const nm = (...p) => path.join(__dirname, 'node_modules', ...p);
app.get('/vendor/xterm.js', (req, res) => res.sendFile(nm('@xterm', 'xterm', 'lib', 'xterm.js')));
app.get('/vendor/xterm.css', (req, res) => res.sendFile(nm('@xterm', 'xterm', 'css', 'xterm.css')));
app.get('/vendor/addon-fit.js', (req, res) => res.sendFile(nm('@xterm', 'addon-fit', 'lib', 'addon-fit.js')));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

/* ---------- Yordamchi funksiyalar ---------- */
function clientIp(req) {
  const h = req.headers;
  return String(h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
}
function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Noto'g'ri urinishlarni cheklash: 10 daqiqada 5 ta xato -> 10 daqiqa blok
const fails = new Map();
const WINDOW = 10 * 60 * 1000, MAX_FAILS = 5;
function failCount(ip) {
  const r = fails.get(ip);
  if (!r) return 0;
  if (Date.now() - r.t > WINDOW) { fails.delete(ip); return 0; }
  return r.n;
}
function addFail(ip) {
  const r = fails.get(ip);
  if (!r || Date.now() - r.t > WINDOW) fails.set(ip, { n: 1, t: Date.now() });
  else r.n++;
}
function blockedMinutes(ip) {
  if (failCount(ip) < MAX_FAILS) return 0;
  return Math.max(1, Math.ceil((WINDOW - (Date.now() - fails.get(ip).t)) / 60000));
}

/* ---------- Chat ---------- */
const MSG_FILE = path.join(__dirname, 'data', 'messages.json');
let history = [];
try { history = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); } catch (e) { history = []; }
let seq = history.reduce((m, x) => Math.max(m, x.id || 0), 0);
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(MSG_FILE), { recursive: true }); fs.writeFileSync(MSG_FILE, JSON.stringify(history)); } catch (e) { console.error('Saqlab bo\'lmadi:', e.message); }
  }, 500);
}

const chatWss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
chatWss.on('connection', ws => {
  ws.send(JSON.stringify({ t: 'history', msgs: history.slice(-50) }));
  let last = 0;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || m.t !== 'chat') return;
    const now = Date.now();
    if (now - last < 300) return;
    last = now;
    const text = String(m.text || '').trim().slice(0, 500);
    const name = String(m.name || '').trim().slice(0, 20) || 'Mehmon';
    if (!text) return;
    const msg = { t: 'chat', id: ++seq, uid: String(m.uid || '').slice(0, 20), name, text, ts: now };
    history.push(msg);
    if (history.length > 200) history = history.slice(-200);
    saveSoon();
    const out = JSON.stringify(msg);
    chatWss.clients.forEach(c => { if (c.readyState === 1) c.send(out); });
  });
});

/* ---------- SSH terminal ---------- */
let sessions = 0;
const sshWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
sshWss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  let conn = null, stream = null, idleTimer = null, counted = false;
  const send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const cleanup = () => {
    clearTimeout(idleTimer);
    try { if (stream) stream.close(); } catch (e) {}
    try { if (conn) conn.end(); } catch (e) {}
    stream = null; conn = null;
    if (counted) { counted = false; sessions--; }
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { send({ t: 'error', msg: 'Uzoq vaqt harakatsiz qolgani uchun seans yopildi.' }); cleanup(); }, cfg.idleMinutes * 60 * 1000);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m) return;

    if (m.t === 'start') {
      if (conn) return;
      const wait = blockedMinutes(ip);
      if (wait) return send({ t: 'error', msg: "Juda ko'p xato urinish. " + wait + " daqiqadan keyin qayta urinib ko'ring." });
      if (!safeEq(m.code, ACCESS_CODE)) { addFail(ip); return send({ t: 'error', msg: "Kirish kodi noto'g'ri." }); }
      if (sessions >= cfg.maxSessions) return send({ t: 'error', msg: "Hozir juda ko'p seans ochiq. Keyinroq urinib ko'ring." });
      const user = String(m.user || '').slice(0, 64), pass = String(m.pass || '').slice(0, 256);
      if (!user || !pass) return send({ t: 'error', msg: 'Login va parolni kiriting.' });
      const cols = Math.min(Math.max(parseInt(m.cols) || 100, 20), 300);
      const rows = Math.min(Math.max(parseInt(m.rows) || 30, 5), 100);

      sessions++; counted = true;
      conn = new Client();
      conn.on('ready', () => {
        conn.shell({ term: 'xterm-256color', cols, rows }, (err, s) => {
          if (err) { send({ t: 'error', msg: 'Shell ochilmadi: ' + err.message }); return cleanup(); }
          stream = s;
          fails.delete(ip);
          send({ t: 'ready' });
          const dec = new StringDecoder('utf8');
          s.on('data', d => send({ t: 'out', d: dec.write(d) }));
          s.stderr.on('data', d => send({ t: 'out', d: d.toString('utf8') }));
          s.on('close', () => { send({ t: 'closed' }); cleanup(); });
          resetIdle();
        });
      });
      conn.on('error', e => {
        const authErr = e && e.level === 'client-authentication';
        if (authErr) addFail(ip);
        send({ t: 'error', msg: authErr ? "Login yoki parol noto'g'ri." : 'SSH ulanish xatosi: ' + (e && e.message) });
        cleanup();
      });
      conn.on('close', () => { send({ t: 'closed' }); cleanup(); });
      conn.connect({ host: cfg.sshHost, port: cfg.sshPort, username: user, password: pass, readyTimeout: 15000 });
    } else if (m.t === 'in' && stream) {
      stream.write(String(m.d)); resetIdle();
    } else if (m.t === 'resize' && stream) {
      const c = Math.min(Math.max(parseInt(m.cols) || 80, 20), 300), r = Math.min(Math.max(parseInt(m.rows) || 24, 5), 100);
      try { stream.setWindow(r, c, 0, 0); } catch (e) {}
    } else if (m.t === 'stop') {
      send({ t: 'closed' }); cleanup();
    }
  });
});

/* ---------- WebSocket yo'naltirish ---------- */
server.on('upgrade', (req, socket, head) => {
  // Boshqa saytlardan kelgan WebSocket'larni rad etamiz. Tunnel (trycloudflare/ngrok) orqali kelganlarga ruxsat.
  // Eslatma: terminal baribir kirish kodi + SSH paroli talab qiladi.
  const origin = req.headers.origin;
  if (origin) {
    let oh = '';
    try { oh = new URL(origin).host; } catch (e) { socket.destroy(); return; }
    const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
    const tunnelHost = /\.(trycloudflare\.com|ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.io)$/i.test(oh);
    const extra = (cfg.allowedOrigins || []).includes(oh);
    if (!hosts.includes(oh) && !tunnelHost && !extra) {
      console.log("WebSocket RAD ETILDI: origin=" + oh + " host=" + req.headers.host + " (config.json da allowedOrigins ga qo'shing)");
      socket.destroy();
      return;
    }
  }
  const url = (req.url || '').split('?')[0];
  if (url === '/chat') chatWss.handleUpgrade(req, socket, head, ws => chatWss.emit('connection', ws, req));
  else if (url === '/ssh') sshWss.handleUpgrade(req, socket, head, ws => sshWss.emit('connection', ws, req));
  else socket.destroy();
});

server.listen(cfg.port, cfg.host, () => {
  console.log('Gaplashish v2: http://localhost:' + cfg.port);
  console.log('SSH nishoni: ' + cfg.sshHost + ':' + cfg.sshPort);
  console.log('');
  console.log('Terminal uchun KIRISH KODI: ' + ACCESS_CODE);
  console.log('(Kodni faqat ishongan odamlarga bering. Kodsiz SSH urinish ham qilib bo\'lmaydi.)');
});
