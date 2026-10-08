// 실시간 광고 전쟁(PRD MVP 4) — Server-Sent Events 허브 + IP별 고정 창 레이트 리미터.
//   SSE를 고른 이유: 서버→클라이언트 단방향이면 충분하고, WebSocket과 달리 의존성 0으로 된다.
//
//   견고성(보안 리뷰 H2·M1 — server/realtime.test.js):
//   - 한 클라이언트의 쓰기 실패·스트림 error가 프로세스 전체(모든 플레이어)를 죽이지 않게 한다
//   - 전체 상한 외에 IP별 상한 — 한 사람이 연결을 독점해 다른 사람의 실시간 피드를 막지 못하게

const { SECURITY_HEADERS } = require('./http-util.js');

const HEARTBEAT_MS = 25_000; // 프록시가 유휴 연결을 끊지 않게
const MAX_SSE_CLIENTS = 2000;
const MAX_SSE_PER_IP = 4; // 탭 몇 개는 허용

function createEventHub() {
  const clients = new Map(); // res → ip
  const perIp = new Map();

  const drop = (res) => {
    const ip = clients.get(res);
    if (ip === undefined) return;
    clients.delete(res);
    const n = (perIp.get(ip) || 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  };

  const safeWrite = (res, frame) => {
    try {
      res.write(frame);
    } catch (err) {
      console.warn('[sse] 쓰기 실패 — 연결 제거', err.message);
      drop(res);
    }
  };

  const heartbeat = setInterval(() => {
    for (const res of [...clients.keys()]) safeWrite(res, ': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    handle(req, res, ip) {
      if (clients.size >= MAX_SSE_CLIENTS || (perIp.get(ip) || 0) >= MAX_SSE_PER_IP) {
        res.writeHead(clients.size >= MAX_SSE_CLIENTS ? 503 : 429, SECURITY_HEADERS);
        res.end();
        return;
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      clients.set(res, ip);
      perIp.set(ip, (perIp.get(ip) || 0) + 1);
      res.on('error', () => drop(res));
      req.on('close', () => drop(res));
      safeWrite(res, 'retry: 3000\n\n');
    },
    broadcast(type, data) {
      const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of [...clients.keys()]) safeWrite(res, frame);
    },
    close() {
      clearInterval(heartbeat);
      for (const res of clients.keys()) res.end();
      clients.clear();
      perIp.clear();
    },
  };
}

/** limit회/windowMs. hit(key) → 허용이면 true */
function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const buckets = new Map();
  return {
    hit(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || t - b.start >= windowMs) {
        buckets.set(key, { start: t, count: 1 });
        if (buckets.size > 10_000) {
          for (const [k, v] of buckets) if (t - v.start >= windowMs) buckets.delete(k);
        }
        return true;
      }
      if (b.count >= limit) return false;
      buckets.set(key, { start: b.start, count: b.count + 1 });
      return true;
    },
  };
}

module.exports = { createEventHub, createRateLimiter, MAX_SSE_PER_IP };
