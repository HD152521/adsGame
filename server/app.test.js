// app.js HTTP 통합 테스트 — 실제 서버를 포트 0에 띄우고 fetch로 두드린다(의존성 0, Node 내장 fetch).
//   보안 경계: 서버 코드·데이터 파일 비노출, 경로 탈출 차단, 위조 웹훅 거부, 본문 크기 제한,
//   레이트 리밋, 관리자 토큰, 업로드 이미지 nosniff.
//   실행: apps/ad-dodge 안에서 node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createApp } = require('./app.js');
const M = require('./moderation.js');

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CONSENTS = { rights: true, dilution: true, refund: true };
const ADMIN = 'admin-token-for-test';

let server;
let base;
let dataDir;
let provider;

async function start(overrides = {}) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-'));
  const app = createApp({
    dataDir,
    adminToken: ADMIN,
    webhookSecret: 'whsec',
    devMode: true,
    classifier: M.reviewAllClassifier(),
    limits: { orders: 100, kills: 100, reports: 20, windowMs: 60_000 }, // 공유 서버 — 리밋 자체는 전용 테스트에서
    ...overrides,
  });
  provider = app.provider;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

before(async () => {
  const s = await start();
  server = s.app;
  base = s.base;
});
after(() => server.close());

const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

async function buySnipe(name = '민수', slots = 1) {
  const res = await post('/api/orders', { kind: 'snipe', name, slots, consents: CONSENTS });
  assert.equal(res.status, 201);
  const order = await res.json();
  const dep = await post(`/api/dev/deposit/${order.orderId}`, {});
  assert.equal(dep.status, 200);
  return order;
}

test('GET / → index.html + 보안 헤더(CSP·nosniff)', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('서버 코드·테스트·데이터는 정적으로 노출되지 않는다', async () => {
  for (const p of ['/server/orders.js', '/shares.test.js', '/dom-stub.js', '/data/db.json', '/..%2f..%2fpackage.json', '/%2e%2e/README.md']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, p);
  }
});

test('GET /api/ledger → 하우스 광고 + 규칙', async () => {
  const res = await fetch(`${base}/api/ledger`);
  const ledger = await res.json();
  assert.equal(ledger.maxSlots, 1000000);
  assert.ok(ledger.advertisers.some((a) => a.isHouse));
  assert.ok(ledger.rules.snipeRate > 0);
});

test('주문 → 모의 입금 → 즉시 장부 반영, 주문 조회는 orderId로만', async () => {
  const order = await buySnipe('영희', 2);
  const view = await (await fetch(`${base}/api/orders/${order.orderId}`)).json();
  assert.equal(view.status, 'active');
  const ledger = await (await fetch(`${base}/api/ledger`)).json();
  assert.ok(ledger.advertisers.some((a) => a.id === order.advertiserId && a.name === '영희'));
  assert.equal((await fetch(`${base}/api/orders/${order.advertiserId}`)).status, 404, '공개 id로는 주문 조회 불가');
});

test('잘못된 주문 → 400 + 한국어 메시지', async () => {
  const res = await post('/api/orders', { kind: 'snipe', name: '민수', slots: 1, consents: {} });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /동의/);
  const bad = await post('/api/orders', '{not json');
  assert.equal(bad.status, 400);
});

test('웹훅: 서명 없음 401, 올바른 서명 200', async () => {
  const res = await post('/api/orders', { kind: 'snipe', name: '철수', slots: 1, consents: CONSENTS });
  const order = await res.json();
  const raw = JSON.stringify({ orderId: order.orderId, status: 'DONE', amount: 1000 });
  assert.equal((await post('/api/payments/webhook', raw)).status, 401);
  const ok = await post('/api/payments/webhook', raw, { 'x-mock-signature': provider.sign(raw) });
  assert.equal(ok.status, 200);
});

test('본문 크기 상한 초과 → 413', async () => {
  const res = await post('/api/orders', JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal(res.status, 413);
});

test('로고 주문 → 업로드 이미지는 올바른 타입 + nosniff로 서빙', async () => {
  const res = await post('/api/orders', { kind: 'logo', name: '치킨집', slots: 1, image: PNG_1PX, consents: CONSENTS });
  assert.equal(res.status, 201);
  const order = await res.json();
  assert.equal(order.review, true);
  const img = await fetch(`${base}${order.logoUrl}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
});

test('관리자 API: 토큰 없으면 401, 있으면 대기열 조회·승인', async () => {
  const res = await post('/api/orders', { kind: 'logo', name: '피자집', slots: 3, image: PNG_1PX, consents: CONSENTS });
  const order = await res.json();
  await post(`/api/dev/deposit/${order.orderId}`, {});
  assert.equal((await fetch(`${base}/api/admin/advertisers?status=pending_review`)).status, 401);
  const auth = { authorization: `Bearer ${ADMIN}` };
  const list = await (await fetch(`${base}/api/admin/advertisers?status=pending_review`, { headers: auth })).json();
  assert.ok(list.some((a) => a.advertiserId === order.advertiserId));
  const ok = await post(`/api/admin/advertisers/${order.advertiserId}/approve`, {}, auth);
  assert.equal(ok.status, 200);
  const view = await (await fetch(`${base}/api/orders/${order.orderId}`)).json();
  assert.equal(view.status, 'active');
  assert.equal((await post(`/api/admin/advertisers/${order.advertiserId}/approve`, {}, { authorization: 'Bearer wrong' })).status, 401);
});

test('킬 기록 → 오늘 순위', async () => {
  const order = await buySnipe('킬러', 1);
  await post('/api/kills', { advId: order.advertiserId });
  await post('/api/kills', { advId: order.advertiserId });
  const ranking = await (await fetch(`${base}/api/kills/today`)).json();
  assert.ok(ranking.some((r) => r.id === order.advertiserId && r.kills === 2));
  assert.equal((await post('/api/kills', { advId: 'nope' })).status, 400);
});

test('권리침해 신고 → 즉시 장부에서 빠진다', async () => {
  const order = await buySnipe('신고대상', 1);
  const res = await post('/api/reports', { advId: order.advertiserId, reason: 'rights' });
  assert.equal(res.status, 202);
  const ledger = await (await fetch(`${base}/api/ledger`)).json();
  assert.equal(ledger.advertisers.some((a) => a.id === order.advertiserId), false);
});

test('SSE: 입금 확정 시 purchase 이벤트가 온다', async () => {
  const received = new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/events`, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk;
        if (buf.includes('event: purchase') && buf.includes('SSE광고')) {
          req.destroy();
          resolve(buf);
        }
      });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
    setTimeout(() => reject(new Error('SSE timeout')), 3000).unref();
  });
  await new Promise((r) => setTimeout(r, 50));
  await buySnipe('SSE광고', 1);
  assert.match(await received, /"slots":1/);
});

test('레이트 리밋: 같은 IP의 주문이 창 안에서 상한을 넘으면 429', async () => {
  const s = await start({ limits: { orders: 2, kills: 100, reports: 20, windowMs: 60_000 } });
  try {
    const body = JSON.stringify({ kind: 'snipe', name: '민수', slots: 1, consents: CONSENTS });
    const hit = () => fetch(`${s.base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await hit()).status, 201);
    assert.equal((await hit()).status, 201);
    assert.equal((await hit()).status, 429);
  } finally {
    s.app.close();
  }
});

test('devMode가 꺼져 있으면 모의 입금 엔드포인트가 없다', async () => {
  const s = await start({ devMode: false });
  try {
    assert.equal((await fetch(`${s.base}/api/dev/deposit/x`, { method: 'POST' })).status, 404);
    const cfg = await (await fetch(`${s.base}/api/config`)).json();
    assert.equal(cfg.devDeposit, false);
  } finally {
    s.app.close();
  }
});

test('저장소 파일에 기록이 남아 재시작 후에도 장부가 유지된다', async () => {
  const s = await start();
  const order = await (await fetch(`${s.base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'snipe', name: '영속', slots: 4, consents: CONSENTS }) })).json();
  await fetch(`${s.base}/api/dev/deposit/${order.orderId}`, { method: 'POST' });
  s.app.close();
  const again = createApp({ dataDir, adminToken: ADMIN, webhookSecret: 'whsec', devMode: true, classifier: M.reviewAllClassifier() });
  assert.ok(again.service.getLedger().advertisers.some((a) => a.name === '영속'));
  again.close();
});

// ── 보안 리뷰 H1: X-Forwarded-For 위조 ───────────────────────────
const { clientIp } = require('./app.js');

test('[H1] TRUST_PROXY: 클라이언트가 붙인 앞쪽 값이 아니라 프록시가 붙인 마지막 값을 쓴다', () => {
  const req = { headers: { 'x-forwarded-for': 'spoofed-1, spoofed-2, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientIp(req, true), '203.0.113.9');
});

test('[H1] TRUST_PROXY 꺼져 있으면 헤더를 무시하고 소켓 주소', () => {
  const req = { headers: { 'x-forwarded-for': 'spoofed' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientIp(req, false), '10.0.0.1');
});

test('[H1] 위조 헤더를 바꿔 가며 신고해도(TRUST_PROXY 꺼짐) 같은 신고자 1명으로 센다', async () => {
  const order = await buySnipe('위조방어', 1);
  for (const fake of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
    await post('/api/reports', { advId: order.advertiserId, reason: 'obscene' }, { 'x-forwarded-for': fake });
  }
  const ledger = await (await fetch(`${base}/api/ledger`)).json();
  assert.ok(ledger.advertisers.some((a) => a.id === order.advertiserId), '가려지면 안 된다');
});

test('[테스트 모드] freeMode: /api/config 에 표시, 주문하면 바로 active', async () => {
  const s = await start({ freeMode: true, classifier: M.autoApproveClassifier() });
  try {
    const cfg = await (await fetch(`${s.base}/api/config`)).json();
    assert.equal(cfg.freeMode, true);
    const res = await fetch(`${s.base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'snipe', name: '무료', slots: 2, consents: CONSENTS }) });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).status, 'active');
  } finally {
    s.app.close();
  }
});

test('[디자인] CSP: Google Fonts(스타일·글꼴)와 종이 기울기용 인라인 스타일만 추가 허용, 스크립트는 여전히 self만', async () => {
  const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
  assert.match(csp, /script-src 'self';/);
});
