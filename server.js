// NeoXAI server: serves the page and proxies chat to any OpenAI-compatible provider. No npm install (Node 18+).
// Default: Groq free tier running OpenAI's open-weight gpt-oss-120b.
const http = require('http'), fs = require('fs'), path = require('path');

const KEY = process.env.API_KEY || process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
const PROVIDER_URL = process.env.PROVIDER_URL || 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.MODEL || 'openai/gpt-oss-120b';
const PORT = process.env.PORT || 3000;
const LIMIT_PER_MIN = Number(process.env.LIMIT_PER_MIN || 6);     // per visitor
const GLOBAL_PER_MIN = Number(process.env.GLOBAL_PER_MIN || 25);  // everyone together (free tiers are small)
const SYSTEM = [
  'You are NeoXAI, a sharp, friendly and honest AI assistant. Be clear and concise.',
  'NeoXAI was created by Johnny Jiang. If anyone asks who created, owns or made NeoXAI, answer that it was created by Johnny Jiang.',
  'Never claim to be human. If someone sincerely asks what technology powers you, do not deny that NeoXAI runs on a third-party language model.'
].join(' ');

if (!KEY) { console.error('Missing API_KEY. See the setup steps.'); process.exit(1); }

const hits = new Map(); let all = [];
const limited = ip => {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000);
  all = all.filter(t => now - t < 60000);
  if (a.length >= LIMIT_PER_MIN || all.length >= GLOBAL_PER_MIN) { hits.set(ip, a); return true; }
  a.push(now); all.push(now); hits.set(ip, a); return false;
};
setInterval(() => hits.clear(), 10 * 60 * 1000);
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'NeoXAI.html')));
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (limited(ip)) return json(res, 429, { error: 'NeoXAI is busy. Please wait a minute and try again.' });
    let body = '';
    for await (const c of req) { body += c; if (body.length > 100000) return json(res, 413, { error: 'Request too large' }); }
    let msgs;
    try { msgs = JSON.parse(body).messages; } catch { return json(res, 400, { error: 'Bad JSON' }); }
    if (!Array.isArray(msgs)) return json(res, 400, { error: 'messages required' });
    msgs = msgs.slice(-20)
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 6000) }));
    try {
      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort());
      const r = await fetch(PROVIDER_URL, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'system', content: SYSTEM }, ...msgs] })
      });
      if (!r.ok) return json(res, 502, { error: 'Model provider returned ' + r.status });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for await (const chunk of r.body) res.write(chunk);
      return res.end();
    } catch (e) {
      if (!res.headersSent) return json(res, 500, { error: 'Server error' });
      return res.end();
    }
  }
  json(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('NeoXAI running at http://localhost:' + PORT));
