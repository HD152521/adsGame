// 운영 기능 HTTP 통합 테스트(계획서 Step 5) — 환불 완료 기록·CSV 내보내기·최근 문제(오류 링버퍼).
//   실제 서버를 포트 0에 띄우고 fetch로 두드린다. 토스 쪽은 가짜 fetch(실제 네트워크 호출 없음).
//   실행: apps/ad-dodge 안에서 node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('./app.js');
const M = require('./moderation.js');

const CONSENTS = { rights: true, dilution: true, refund: true };
const ADMIN = 'admin-token-for-ops-test';
const WEBHOOK_SECRET = 'whsec-ops-test-value';
const auth = { authorization: `Bearer ${ADMIN}` };

let app;
let base;

before(async () => {
  app = createApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-ops-')),
    adminToken: ADMIN,
    webhookSecret: WEBHOOK_SECRET,
    devMode: true,
    classifier: M.reviewAllClassifier(),
    limits: { orders: 100, kills: 100, reports: 20, windowMs: 60_000 },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });

/** 주문 → 모의 입금(검수 대기) → 관리자 거절 = 환불 필요 */
async function refundRequired(name) {
  const order = await (await post('/api/orders', { kind: 'snipe', name, slots: 2, consents: CONSENTS })).json();
  assert.equal((await post(`/api/dev/deposit/${order.orderId}`, {})).status, 200);
  assert.equal((await post(`/api/admin/advertisers/${order.advertiserId}/reject`, {}, auth)).status, 200);
  return order;
}

test('[환불 HTTP] POST /api/admin/orders/:orderId/refund — 토큰 없으면 401, 있으면 환불 완료(일시·메모 저장)', async () => {
  const order = await refundRequired('환불손님');
  assert.equal((await post(`/api/admin/orders/${order.orderId}/refund`, { memo: 'x' })).status, 401);
  assert.equal((await post(`/api/admin/orders/${order.orderId}/refund`, { memo: 'x' }, { authorization: 'Bearer wrong' })).status, 401);

  const at = new Date().toISOString(); // 주문 이후 ~ 지금 사이
  const res = await post(`/api/admin/orders/${order.orderId}/refund`, { refundedAt: at, memo: '신한 이체 완료' }, auth);
  assert.equal(res.status, 200);
  const done = await res.json();
  assert.equal(done.status, 'refunded');
  assert.equal(done.refundedAt, Date.parse(at));
  assert.equal(done.refundMemo, '신한 이체 완료');

  const list = await (await get('/api/admin/advertisers?status=refunded', auth)).json();
  assert.ok(list.some((o) => o.orderId === order.orderId && o.refundMemo === '신한 이체 완료'));
  // 다시 처리는 거부(400), 처음 기록 유지
  assert.equal((await post(`/api/admin/orders/${order.orderId}/refund`, { memo: '두 번' }, auth)).status, 400);
  // 없는 주문
  assert.equal((await post('/api/admin/orders/nope/refund', {}, auth)).status, 400);
});

test('[환불 HTTP] 환불 필요가 아닌 주문(붙어 있음)은 400', async () => {
  const order = await (await post('/api/orders', { kind: 'snipe', name: '대기손님', slots: 1, consents: CONSENTS })).json();
  await post(`/api/dev/deposit/${order.orderId}`, {});
  const res = await post(`/api/admin/orders/${order.orderId}/refund`, {}, auth);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /환불/);
});

test('[CSV HTTP] GET /api/admin/export.csv — 토큰 필요, BOM·CRLF·text/csv·첨부, 비밀값 없음', async () => {
  const order = await refundRequired('=CSV손님');
  assert.equal((await get('/api/admin/export.csv')).status, 401);

  const res = await get('/api/admin/export.csv', auth);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="ad-dodge-orders-\d{8}\.csv"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // UTF-8 BOM
  const text = bytes.toString('utf8').slice(1);
  assert.ok(text.startsWith('주문번호,광고 이름,'));
  assert.ok(text.includes('\r\n'));
  assert.ok(text.includes(`${order.orderId.slice(0, 8)},'=CSV손님,저격,2,2000,환불 필요,`));
  assert.equal(text.includes(order.orderId), false);
  assert.equal(/secret|paymentKey|whsec/i.test(text), false);
});

test('[CSV HTTP] ?status= 로 거르고, 모르는 상태는 400', async () => {
  const res = await get('/api/admin/export.csv?status=refunded', auth);
  assert.equal(res.status, 200);
  const rows = (await res.text()).replace(/^\ufeff/, '').split('\r\n').filter(Boolean).slice(1);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.includes(',환불 완료,')));
  assert.equal((await get('/api/admin/export.csv?status=bogus', auth)).status, 400);
});

test('[최근 문제] 웹훅 검증 실패·500 오류가 쌓이고, 관리자만 GET /api/admin/errors 로 본다(비밀값·본문 없음)', async () => {
  const body = JSON.stringify({ orderId: 'deadbeefdeadbeefdeadbeefdeadbeef', status: 'DONE', amount: 1000, note: 'BODY_SHOULD_NOT_APPEAR' });
  assert.equal((await post('/api/payments/webhook', body, { 'x-mock-signature': 'forged' })).status, 401);

  const original = app.service.getLedger;
  app.service.getLedger = () => { throw new Error(`장부 계산 실패 ${ADMIN} ${WEBHOOK_SECRET}`); };
  try {
    assert.equal((await get('/api/ledger?token=QUERY_SECRET')).status, 500);
  } finally {
    app.service.getLedger = original;
  }

  assert.equal((await get('/api/admin/errors')).status, 401);
  const res = await get('/api/admin/errors', auth);
  assert.equal(res.status, 200);
  const { errors, max } = await res.json();
  assert.equal(max, 50);
  assert.ok(errors.some((e) => e.kind === 'webhook'));
  assert.ok(errors.some((e) => e.kind === 'server' && /GET \/api\/ledger/.test(e.message)));
  const text = JSON.stringify(errors);
  for (const leaked of [ADMIN, WEBHOOK_SECRET, 'BODY_SHOULD_NOT_APPEAR', 'QUERY_SECRET', 'forged']) assert.equal(text.includes(leaked), false, leaked);
});

test('[최근 문제] PG 장애(토스 조회 실패)도 pg 로 기록된다', async () => {
  const secrets = new Map();
  let down = false;
  const tossFetch = async (url, init = {}) => {
    if (down) throw new TypeError('fetch failed');
    const req = JSON.parse(init.body || '{}');
    const secret = `ps_${req.orderId}`;
    secrets.set(req.orderId, secret);
    return new Response(JSON.stringify({ orderId: req.orderId, totalAmount: req.amount, status: 'WAITING_FOR_DEPOSIT', secret, paymentKey: 'pk_x', virtualAccount: { accountNumber: '123', bankCode: '88', dueDate: '2099-01-01T00:00:00' } }), { status: 200 });
  };
  const toss = createApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-ops-toss-')),
    adminToken: ADMIN,
    classifier: M.reviewAllClassifier(),
    payment: { provider: 'toss', tossSecretKey: 'test_sk_fakeKeyForOpsTest000', tossBank: '88' },
    fetch: tossFetch,
  });
  await new Promise((r) => toss.server.listen(0, '127.0.0.1', r));
  const tbase = `http://127.0.0.1:${toss.server.address().port}`;
  try {
    const order = await (await fetch(`${tbase}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'snipe', name: '토스손님', slots: 1, consents: CONSENTS }) })).json();
    down = true;
    const hook = await fetch(`${tbase}/api/payments/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: order.orderId, secret: secrets.get(order.orderId), status: 'DONE' }) });
    assert.equal(hook.status, 503);
    // 주문 때 가상계좌 발급 실패도 PG 장애로 기록
    assert.equal((await fetch(`${tbase}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'snipe', name: '토스손님2', slots: 1, consents: CONSENTS }) })).status, 400);
    const { errors } = await (await fetch(`${tbase}/api/admin/errors`, { headers: auth })).json();
    const pg = errors.filter((e) => e.kind === 'pg');
    assert.equal(pg.length, 2);
    assert.equal(JSON.stringify(errors).includes(secrets.get(order.orderId)), false);
    assert.equal(JSON.stringify(errors).includes('test_sk_fakeKeyForOpsTest000'), false);
  } finally {
    toss.close();
  }
});

test('[최근 문제] 외부에서 넘긴 errorLog 를 쓴다(백업 실패를 index.js 가 같은 곳에 기록)', () => {
  assert.equal(typeof app.errorLog.record, 'function');
  app.errorLog.record('backup', '외부 백업 업로드 실패: HTTP 403');
  assert.ok(app.errorLog.list().some((e) => e.kind === 'backup'));
});
