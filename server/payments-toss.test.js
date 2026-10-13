// payments-toss.js — 토스페이먼츠 가상계좌 provider 단위 테스트. 실제 네트워크 호출 없음(fetch를 가짜로 주입).
//   샘플 요청·응답은 토스페이먼츠 공식 문서(2026-10 확인)의 형식을 그대로 옮겼다:
//     · 가상계좌 발급  POST /v1/virtual-accounts          https://docs.tosspayments.com/reference#가상계좌-발급-요청
//     · 결제 조회      GET  /v1/payments/orders/{orderId}  https://docs.tosspayments.com/reference#orderid로-결제-조회
//     · 입금 웹훅      DEPOSIT_CALLBACK 본문 { createdAt, secret, status, transactionKey, orderId }
//                     https://docs.tosspayments.com/reference/using-api/webhook-events#deposit_callback
//     · 인증           Authorization: Basic base64("{시크릿 키}:")
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTossProvider, TOSS_API_BASE, VA_BANKS } = require('./payments-toss.js');

const SECRET_KEY = 'test_sk_zXLkKEypNArWmo50nX3lmeaxYG5R'; // 문서 예시 형식의 가짜 키(실제 키 아님)
const ORDER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const WEBHOOK_SECRET = 'ps_Z1aOwX7K8mYJ1XjaEo5Jr2ywm9qW';

/** 문서 샘플: 가상계좌 발급 응답(Payment 객체) */
function sampleIssueResponse(overrides = {}) {
  return {
    version: '2022-11-16',
    paymentKey: 'tvPAQN3pE8L2zrqN2w3w',
    orderId: ORDER_ID,
    orderName: '이건광고입니다 광고 칸',
    mId: 'tosspayments',
    currency: 'KRW',
    method: '가상계좌',
    totalAmount: 5000,
    balanceAmount: 5000,
    status: 'WAITING_FOR_DEPOSIT',
    requestedAt: '2026-10-13T10:09:26+09:00',
    approvedAt: null,
    useEscrow: false,
    secret: WEBHOOK_SECRET,
    virtualAccount: {
      accountType: '일반',
      accountNumber: 'X6505636518308',
      bankCode: '20',
      customerName: '민수',
      dueDate: '2026-10-14T10:09:26',
      refundStatus: 'NONE',
      expired: false,
      settlementStatus: 'INCOMPLETED',
    },
    ...overrides,
  };
}

/** 문서 샘플: 결제 조회 응답 — 입금 완료 뒤 */
function sampleLookupResponse(overrides = {}) {
  return sampleIssueResponse({ status: 'DONE', approvedAt: '2026-10-13T11:00:00+09:00', ...overrides });
}

/** 문서 샘플: DEPOSIT_CALLBACK 본문 */
function sampleDepositCallback(overrides = {}) {
  return JSON.stringify({
    createdAt: '2026-10-13T11:00:00.000000',
    secret: WEBHOOK_SECRET,
    status: 'DONE',
    transactionKey: '9FF15E1A29D0E77C218F57262BFA4986',
    orderId: ORDER_ID,
    ...overrides,
  });
}

/** 가짜 fetch — 호출을 기록하고 routes[`${method} ${path}`] 응답을 돌려준다 */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ url: String(url), key, init, body: init.body ? JSON.parse(init.body) : null });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ code: 'NOT_FOUND_PAYMENT', message: '존재하지 않는 결제 정보 입니다.' }), { status: 404 });
    if (route instanceof Error) throw route;
    return new Response(JSON.stringify(route.body), { status: route.status || 200 });
  };
  fn.calls = calls;
  return fn;
}

const ISSUE = 'POST /v1/virtual-accounts';
const LOOKUP = `GET /v1/payments/orders/${ORDER_ID}`;

function provider({ routes = {}, secrets = { [ORDER_ID]: WEBHOOK_SECRET }, ...rest } = {}) {
  const fetch = fakeFetch(routes);
  const p = createTossProvider({ secretKey: SECRET_KEY, fetch, lookupWebhookSecret: (id) => secrets[id] || null, bank: '20', ...rest });
  return { p, fetch };
}

// ── 생성 ────────────────────────────────────────────────────────────────────
test('createTossProvider: 시크릿 키가 없거나 형식이 틀리면 만들지 않는다(하드코딩 대신 환경변수)', () => {
  const base = { fetch: fakeFetch({}), lookupWebhookSecret: () => null };
  assert.throws(() => createTossProvider({ ...base }), /TOSS_SECRET_KEY/);
  assert.throws(() => createTossProvider({ ...base, secretKey: 'test_ck_client-key' }), /TOSS_SECRET_KEY/);
  assert.throws(() => createTossProvider({ ...base, secretKey: SECRET_KEY, bank: '90' }), /은행/);
  assert.throws(() => createTossProvider({ secretKey: SECRET_KEY, fetch: fakeFetch({}) }), /lookupWebhookSecret/);
  assert.equal(createTossProvider({ ...base, secretKey: SECRET_KEY }).name, 'toss');
});

test('VA_BANKS: 문서의 가상계좌 발급 가능 은행 코드만', () => {
  assert.equal(VA_BANKS['20'], '우리은행');
  assert.equal(VA_BANKS['88'], '신한은행');
  assert.equal(VA_BANKS['90'], undefined, '카카오뱅크는 가상계좌 발급 불가');
});

// ── 가상계좌 발급 ───────────────────────────────────────────────────────────
test('issueVirtualAccount: 문서 형식으로 요청(Basic 인증·멱등 키)하고 샘플 응답을 인터페이스 형태로 바꾼다', async () => {
  const { p, fetch } = provider({ routes: { [ISSUE]: { body: sampleIssueResponse() } } });
  const va = await p.issueVirtualAccount({ orderId: ORDER_ID, amount: 5000, customerName: '민수' });

  const call = fetch.calls[0];
  assert.equal(call.url, `${TOSS_API_BASE}/v1/virtual-accounts`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, `Basic ${Buffer.from(`${SECRET_KEY}:`).toString('base64')}`);
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  assert.ok(call.init.headers['Idempotency-Key'].includes(ORDER_ID), '같은 주문 재시도는 같은 계좌(멱등 키)');
  assert.deepEqual(call.body, { amount: 5000, orderId: ORDER_ID, orderName: '이건광고입니다 광고 칸', customerName: '민수', bank: '20', validHours: 24 });

  assert.equal(va.bank, '우리은행');
  assert.equal(va.accountNumber, 'X6505636518308');
  assert.equal(va.holder, '이건광고입니다');
  assert.equal(va.dueAt, Date.parse('2026-10-14T10:09:26+09:00'), '문서의 dueDate는 시간대 없는 한국 시각');
  assert.equal(va.webhookSecret, WEBHOOK_SECRET, '웹훅 검증값은 따로 돌려준다(주문에 비공개로 저장)');
  assert.equal(va.paymentKey, 'tvPAQN3pE8L2zrqN2w3w');
});

test('issueVirtualAccount: 구매자명이 없으면 기본값으로 채운다(customerName은 필수 항목)', async () => {
  const { p, fetch } = provider({ routes: { [ISSUE]: { body: sampleIssueResponse() } } });
  await p.issueVirtualAccount({ orderId: ORDER_ID, amount: 5000 });
  assert.equal(fetch.calls[0].body.customerName, '광고주');
});

test('issueVirtualAccount: PG 오류 응답은 쉬운 말로 실패(키·원문을 사용자에게 노출하지 않음)', async () => {
  const { p } = provider({ routes: { [ISSUE]: { status: 400, body: { code: 'INVALID_REQUEST', message: '잘못된 요청입니다.' } } } });
  await assert.rejects(p.issueVirtualAccount({ orderId: ORDER_ID, amount: 5000 }), (err) => {
    assert.match(err.message, /가상계좌 발급/);
    assert.ok(!err.message.includes(SECRET_KEY));
    return true;
  });
});

test('issueVirtualAccount: 응답의 주문번호·금액·상태가 요청과 다르면 쓰지 않는다', async () => {
  for (const bad of [{ orderId: 'other-order' }, { totalAmount: 1000 }, { status: 'DONE' }, { secret: undefined }, { virtualAccount: null }]) {
    const { p } = provider({ routes: { [ISSUE]: { body: sampleIssueResponse(bad) } } });
    await assert.rejects(p.issueVirtualAccount({ orderId: ORDER_ID, amount: 5000 }), /가상계좌 발급/, JSON.stringify(bad));
  }
});

test('issueVirtualAccount: 네트워크 오류도 쉬운 말로 실패', async () => {
  const { p } = provider({ routes: { [ISSUE]: new TypeError('fetch failed') } });
  await assert.rejects(p.issueVirtualAccount({ orderId: ORDER_ID, amount: 5000 }), /가상계좌 발급/);
});

// ── 웹훅 검증 + 결제 조회 재확인 ─────────────────────────────────────────────
test('verifyWebhook: secret 일치 → 결제 조회 API로 재확인한 상태·금액을 돌려준다', async () => {
  const { p, fetch } = provider({ routes: { [LOOKUP]: { body: sampleLookupResponse() } } });
  const result = await p.verifyWebhook({ 'content-type': 'application/json' }, sampleDepositCallback());
  assert.deepEqual(result, { orderId: ORDER_ID, status: 'DONE', amount: 5000 });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, `${TOSS_API_BASE}/v1/payments/orders/${ORDER_ID}`);
  assert.match(fetch.calls[0].init.headers.Authorization, /^Basic /);
});

test('verifyWebhook: 금액·상태는 웹훅 본문이 아니라 조회 결과를 쓴다', async () => {
  const { p } = provider({ routes: { [LOOKUP]: { body: sampleLookupResponse({ status: 'WAITING_FOR_DEPOSIT', totalAmount: 5000 }) } } });
  const result = await p.verifyWebhook({}, sampleDepositCallback({ status: 'DONE' }));
  assert.equal(result.status, 'WAITING_FOR_DEPOSIT', '본문은 DONE이라 해도 조회가 입금 대기면 입금 대기');
});

test('verifyWebhook: secret이 다르거나 없으면 거부하고 조회도 하지 않는다(위조 웹훅)', async () => {
  const { p, fetch } = provider({ routes: { [LOOKUP]: { body: sampleLookupResponse() } } });
  await assert.rejects(p.verifyWebhook({}, sampleDepositCallback({ secret: 'ps_forged_secret_value_000000000' })), /검증/);
  await assert.rejects(p.verifyWebhook({}, sampleDepositCallback({ secret: undefined })), /검증/);
  await assert.rejects(p.verifyWebhook({}, sampleDepositCallback({ secret: '' })), /검증/);
  assert.equal(fetch.calls.length, 0);
});

test('verifyWebhook: 우리 주문이 아니거나(저장된 secret 없음) 본문이 깨졌으면 거부', async () => {
  const { p, fetch } = provider({ routes: {} });
  await assert.rejects(p.verifyWebhook({}, sampleDepositCallback({ orderId: 'unknown-order-0001' })), /검증/);
  await assert.rejects(p.verifyWebhook({}, sampleDepositCallback({ orderId: '../admin' })), /검증/);
  await assert.rejects(p.verifyWebhook({}, '{not json'), /검증/);
  await assert.rejects(p.verifyWebhook({}, JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: {} })), /검증/);
  assert.equal(fetch.calls.length, 0);
});

test('verifyWebhook: 조회 결과의 주문번호·secret이 다르면 거부', async () => {
  for (const bad of [{ orderId: 'someone-else-order' }, { secret: 'ps_other_secret_value_0000000000' }]) {
    const { p } = provider({ routes: { [LOOKUP]: { body: sampleLookupResponse(bad) } } });
    await assert.rejects(p.verifyWebhook({}, sampleDepositCallback()), /검증/, JSON.stringify(bad));
  }
});

test('verifyWebhook: 결제 조회가 안 되면(PG 장애) 재시도할 수 있게 PG_UNAVAILABLE로 실패', async () => {
  for (const route of [new TypeError('fetch failed'), { status: 500, body: { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: '내부 오류' } }]) {
    const { p } = provider({ routes: { [LOOKUP]: route } });
    await assert.rejects(p.verifyWebhook({}, sampleDepositCallback()), (err) => err.code === 'PG_UNAVAILABLE');
  }
});

test('verifyWebhook: 조회 결과 결제가 없으면(404) 거부', async () => {
  const { p } = provider({ routes: {} });
  await assert.rejects(p.verifyWebhook({}, sampleDepositCallback()), (err) => err.code !== 'PG_UNAVAILABLE' && /검증/.test(err.message));
});
