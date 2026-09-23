// 負荷試験: N 人が参加・SSE 接続した状態で抽選し、全員に届くまでの時間を測る
// 使い方: node scripts/loadtest.js [BASE_URL] [人数] [抽選回数]
//   例: node scripts/loadtest.js http://localhost:3000 2000 5
import http from 'node:http';
import https from 'node:https';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const N = Number(process.argv[3] ?? 1000);
const DRAWS = Number(process.argv[4] ?? 5);
const agentOpts = { keepAlive: true, maxSockets: Infinity };
const lib = BASE.startsWith('https') ? https : http;
const agent = new lib.Agent(agentOpts);

async function call(path, body, token) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error}`);
  return data;
}

async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

function listen(roomId, token, onData) {
  return new Promise((resolve, reject) => {
    const req = lib.get(`${BASE}/api/rooms/${roomId}/events?token=${token}`, { agent }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE ${res.statusCode}`));
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) onData(JSON.parse(line.slice(6)));
        }
      });
      resolve(req);
    });
    req.on('error', reject);
  });
}

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((arr.length * p) / 100))];

const t0 = Date.now();
const { roomId, hostToken } = await call('/api/rooms', { title: `負荷試験 ${N}人` });
const players = await pool(Array.from({ length: N }, (_, i) => i), 50, (i) => call(`/api/rooms/${roomId}/join`, { name: `p${i}` }));
console.log(`参加 ${N} 人: ${Date.now() - t0} ms`);

let waiting = null;
const t1 = Date.now();
const conns = await pool(players, 100, (p) =>
  listen(roomId, p.token, (msg) => {
    if (msg.event?.kind === 'draw' && waiting) waiting.hit(msg.event.number);
  }));
console.log(`SSE 接続 ${conns.length} 本: ${Date.now() - t1} ms`);

await call(`/api/rooms/${roomId}/host/start`, {}, hostToken);
const results = [];
for (let d = 0; d < DRAWS; d++) {
  const latencies = [];
  const start = Date.now();
  const done = new Promise((resolve) => {
    waiting = {
      hit() {
        latencies.push(Date.now() - start);
        if (latencies.length === N) resolve();
      },
    };
  });
  await call(`/api/rooms/${roomId}/host/draw`, {}, hostToken);
  await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);
  latencies.sort((a, b) => a - b);
  results.push({ 抽選: d + 1, 到達: `${latencies.length}/${N}`, p50: pct(latencies, 50), p95: pct(latencies, 95), 最大: latencies.at(-1) });
  await new Promise((r) => setTimeout(r, 300));
}
console.table(results);
for (const c of conns) c.destroy();
agent.destroy();
