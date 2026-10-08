// realtime.js — SSE 허브 견고성(보안 리뷰 H2·M1)과 레이트 리미터.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createEventHub, createRateLimiter, MAX_SSE_PER_IP } = require('./realtime.js');

function fakeRes({ throwOnWrite = false } = {}) {
  const res = new EventEmitter();
  res.status = null;
  res.frames = [];
  res.writeHead = (status) => { res.status = status; return res; };
  res.write = (chunk) => { if (throwOnWrite) throw new Error('EPIPE'); res.frames.push(String(chunk)); return true; };
  res.end = () => {};
  return res;
}

test('[H2] 한 클라이언트 쓰기가 실패해도 broadcast는 던지지 않고, 그 클라이언트는 빠진다', () => {
  const hub = createEventHub();
  const good = fakeRes();
  const bad = fakeRes();
  hub.handle(new EventEmitter(), good, 'ip-a');
  hub.handle(new EventEmitter(), bad, 'ip-b');
  bad.write = () => { throw new Error('EPIPE'); };
  assert.doesNotThrow(() => hub.broadcast('purchase', { a: 1 }));
  assert.doesNotThrow(() => hub.broadcast('purchase', { a: 2 }));
  assert.equal(good.frames.filter((f) => f.includes('purchase')).length, 2);
  hub.close();
});

test('[H2] 응답 스트림 error 이벤트가 나도 프로세스가 죽지 않는다(리스너 등록)', () => {
  const hub = createEventHub();
  const res = fakeRes();
  hub.handle(new EventEmitter(), res, 'ip-a');
  assert.doesNotThrow(() => res.emit('error', new Error('ECONNRESET')));
  hub.close();
});

test(`[M1] 같은 IP의 SSE 연결은 ${MAX_SSE_PER_IP}개까지, 넘으면 429`, () => {
  const hub = createEventHub();
  const results = [];
  for (let i = 0; i < MAX_SSE_PER_IP + 1; i += 1) {
    const res = fakeRes();
    hub.handle(new EventEmitter(), res, 'same-ip');
    results.push(res.status);
  }
  assert.equal(results.filter((s) => s === 200).length, MAX_SSE_PER_IP);
  assert.equal(results[results.length - 1], 429);
  hub.close();
});

test('[M1] 연결이 닫히면 IP 카운트가 줄어든다', () => {
  const hub = createEventHub();
  const reqs = [];
  for (let i = 0; i < MAX_SSE_PER_IP; i += 1) {
    const req = new EventEmitter();
    reqs.push(req);
    hub.handle(req, fakeRes(), 'same-ip');
  }
  reqs[0].emit('close');
  const res = fakeRes();
  hub.handle(new EventEmitter(), res, 'same-ip');
  assert.equal(res.status, 200);
  hub.close();
});

test('createRateLimiter: 창 안에서 limit회까지 허용, 창이 지나면 초기화', () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.equal(rl.hit('a'), true);
  assert.equal(rl.hit('a'), true);
  assert.equal(rl.hit('a'), false);
  assert.equal(rl.hit('b'), true, '키별 독립');
  t = 1000;
  assert.equal(rl.hit('a'), true);
});
