// 토스페이먼츠 provider로 띄운 서버 통합 테스트 — 실제 서버를 포트 0에 띄우고, PG(토스) 쪽은 가짜 fetch로 흉내 낸다.
//   인수 조건(계획서 Step 2):
//   - 위조 웹훅(secret 불일치)·조회 결과와 금액/상태 불일치·없는 주문은 반영되지 않는다
//   - 같은 웹훅 2회는 한 번만 반영(멱등)
//   - 웹훅 검증값(secret)·paymentKey는 공개 API로 새지 않는다
//   실제 네트워크 호출 없음. 실행: apps/ad-dodge 안에서 node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createApp } = require('./app.js');
const M = require('./moderation.js');

const CONSENTS = { rights: true, dilution: true, refund: true };
const ADMIN = 'admin-token-for-test';
const SECRET_KEY = 'test_sk_fakeKeyForUnitTestsOnly000'; // 가짜 키

/** 가짜 토스 API — 발급한 결제를 기억하고, 조회는 tossState 를 돌려준다(입금은 deposit()으로 흉내) */
function createFakeToss() {
  const payments = new Map();
  let down = false;
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (down) throw new TypeError('fetch failed');
    if ((init.method || 'GET') === 'POST' && u.pathname === '/v1/virtual-accounts') {
      const req = JSON.parse(init.body);
      const payment = {
        paymentKey: `pk_${crypto.randomBytes(8).toString('hex')}`,
        orderId: req.orderId,
        orderName: req.orderName,
        method: '가상계좌',
        totalAmount: req.amount,
        balanceAmount: req.amount,
        status: 'WAITING_FOR_DEPOSIT',
        secret: `ps_${crypto.randomBytes(12).toString('hex')}`,
        virtualAccount: { accountType: '일반', accountNumber: String(Date.now()).slice(-12), bankCode: req.bank, customerName: req.customerName, dueDate: '2099-01-01T00:00:00', expired: false },
      };
      payments.set(req.orderId, payment);
      return json(200, payment);
    }
    const m = u.pathname.match(/^\/v1\/payments\/orders\/(.+)$/);
    if (m && payments.has(decodeURIComponent(m[1]))) return json(200, payments.get(decodeURIComponent(m[1])));
    return json(404, { code: 'NOT_FOUND_PAYMENT', message: '존재하지 않는 결제 정보 입니다.' });
  };
  return {
    fetch,
    payments,
    deposit(orderId, patch = {}) {
      payments.set(orderId, { ...payments.get(orderId), status: 'DONE', ...patch });
    },
    setDown(v) { down = v; },
  };
}

let app;
let base;
let toss;

before(async () => {
  toss = createFakeToss();
  app = createApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-toss-')),
    adminToken: ADMIN,
    devMode: true, // 토스 provider에서는 모의 입금 엔드포인트가 동작하지 않아야 한다
    classifier: M.reviewAllClassifier(),
    limits: { orders: 100, kills: 100, reports: 20, windowMs: 60_000 },
    payment: { provider: 'toss', tossSecretKey: SECRET_KEY, tossBank: '88' },
    fetch: toss.fetch,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => app.close());

const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const getOrder = async (orderId) => (await fetch(`${base}/api/orders/${orderId}`)).json();
const webhookBody = (orderId, overrides = {}) => JSON.stringify({ createdAt: '2026-10-13T11:00:00.000000', secret: toss.payments.get(orderId)?.secret, status: 'DONE', transactionKey: 'tx-1', orderId, ...overrides });

async function order(name = '민수', slots = 1) {
  const res = await post('/api/orders', { kind: 'snipe', name, slots, consents: CONSENTS });
  assert.equal(res.status, 201);
  return res.json();
}

test('[토스] 주문하면 토스에서 발급한 가상계좌가 보이고, 웹훅 검증값·paymentKey는 공개되지 않는다', async () => {
  const o = await order('영희', 2);
  assert.equal(o.status, 'awaiting_deposit');
  assert.equal(o.virtualAccount.bank, '신한은행');
  assert.equal(o.virtualAccount.accountNumber, toss.payments.get(o.orderId).virtualAccount.accountNumber);
  assert.equal(o.virtualAccount.holder, '이건광고입니다');
  const secret = toss.payments.get(o.orderId).secret;
  const adminList = await (await fetch(`${base}/api/admin/advertisers`, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
  for (const text of [JSON.stringify(o), JSON.stringify(await getOrder(o.orderId)), adminList]) {
    assert.ok(!text.includes(secret), 'secret 노출');
    assert.ok(!text.includes(toss.payments.get(o.orderId).paymentKey), 'paymentKey 노출');
  }
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.equal(config.provider, 'toss');
  assert.equal(config.devDeposit, false, '토스 provider에서는 모의 입금 버튼을 숨긴다');
});

test('[토스] 정상 입금 웹훅 → 결제 조회로 재확인 후 장부 반영', async () => {
  const o = await order('철수', 3);
  toss.deposit(o.orderId);
  const res = await post('/api/payments/webhook', webhookBody(o.orderId));
  assert.equal(res.status, 200);
  assert.equal((await getOrder(o.orderId)).status, 'active');
});

test('[토스] 같은 웹훅 2회 → 한 번만 반영(멱등), 두 번째도 200(토스 재전송 멈춤)', async () => {
  const o = await order('두번', 4);
  toss.deposit(o.orderId);
  const before = (await (await fetch(`${base}/api/ledger`)).json()).soldSlots;
  const [a, b] = await Promise.all([post('/api/payments/webhook', webhookBody(o.orderId)), post('/api/payments/webhook', webhookBody(o.orderId))]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const third = await post('/api/payments/webhook', webhookBody(o.orderId));
  assert.equal(third.status, 200);
  const after = (await (await fetch(`${base}/api/ledger`)).json()).soldSlots;
  assert.equal(after - before, 4, '4칸이 한 번만 더해진다');
});

test('[토스] 위조 웹훅(secret 불일치·없음) → 401, 반영 안 됨', async () => {
  const o = await order('위조', 1);
  toss.deposit(o.orderId); // 실제로 입금됐더라도 검증값이 틀린 요청은 받아들이지 않는다
  assert.equal((await post('/api/payments/webhook', webhookBody(o.orderId, { secret: 'ps_forged000000000000000000' }))).status, 401);
  assert.equal((await post('/api/payments/webhook', webhookBody(o.orderId, { secret: undefined }))).status, 401);
  assert.equal((await post('/api/payments/webhook', '{broken')).status, 401);
  assert.equal((await getOrder(o.orderId)).status, 'awaiting_deposit');
});

test('[토스] 웹훅은 DONE이라 해도 결제 조회가 입금 대기면 반영 안 됨(본문만 믿지 않기)', async () => {
  const o = await order('본문만', 1);
  const res = await post('/api/payments/webhook', webhookBody(o.orderId, { status: 'DONE' }));
  assert.equal(res.status, 200);
  assert.equal((await getOrder(o.orderId)).status, 'awaiting_deposit');
});

test('[토스] 결제 조회 금액이 주문과 다르면 반영 안 됨', async () => {
  const o = await order('금액', 2);
  toss.deposit(o.orderId, { totalAmount: 1000 });
  const res = await post('/api/payments/webhook', webhookBody(o.orderId));
  assert.equal(res.status, 400);
  assert.equal((await getOrder(o.orderId)).status, 'awaiting_deposit');
});

test('[토스] 없는 주문의 웹훅 → 401, 토스 조회도 하지 않는다', async () => {
  const res = await post('/api/payments/webhook', JSON.stringify({ createdAt: 'x', secret: 'ps_whatever00000000000000', status: 'DONE', transactionKey: 't', orderId: 'no-such-order-123' }));
  assert.equal(res.status, 401);
});

test('[토스] 결제 조회가 안 되면(PG 장애) 503 → 토스가 재전송, 반영은 나중에', async () => {
  const o = await order('장애', 1);
  toss.deposit(o.orderId);
  toss.setDown(true);
  try {
    assert.equal((await post('/api/payments/webhook', webhookBody(o.orderId))).status, 503);
  } finally {
    toss.setDown(false);
  }
  assert.equal((await getOrder(o.orderId)).status, 'awaiting_deposit');
  assert.equal((await post('/api/payments/webhook', webhookBody(o.orderId))).status, 200);
  assert.equal((await getOrder(o.orderId)).status, 'active');
});

test('[토스] 가상계좌 발급 실패(PG 장애) → 주문 실패, 주문이 남지 않는다', async () => {
  toss.setDown(true);
  try {
    const res = await post('/api/orders', { kind: 'snipe', name: '발급실패', slots: 1, consents: CONSENTS });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /가상계좌 발급/);
  } finally {
    toss.setDown(false);
  }
  const list = await (await fetch(`${base}/api/admin/advertisers`, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
  assert.ok(!list.some((a) => a.name === '발급실패'));
});

test('[토스] 모의 입금 엔드포인트는 토스 provider에서 쓸 수 없다(공짜 광고 방지)', async () => {
  const o = await order('공짜', 1);
  assert.equal((await post(`/api/dev/deposit/${o.orderId}`, {})).status, 404);
  assert.equal((await getOrder(o.orderId)).status, 'awaiting_deposit');
});

test('[토스] 칸 추가도 토스 가상계좌로 발급', async () => {
  const o = await order('추가', 1);
  toss.deposit(o.orderId);
  await post('/api/payments/webhook', webhookBody(o.orderId));
  const res = await post(`/api/orders/${o.orderId}/topup`, { slots: 2, consents: CONSENTS });
  assert.equal(res.status, 201);
  const topup = await res.json();
  assert.ok(toss.payments.has(topup.orderId));
  assert.equal(toss.payments.get(topup.orderId).totalAmount, 2000);
  toss.deposit(topup.orderId);
  assert.equal((await post('/api/payments/webhook', webhookBody(topup.orderId))).status, 200);
  assert.equal((await getOrder(topup.orderId)).status, 'active');
});
