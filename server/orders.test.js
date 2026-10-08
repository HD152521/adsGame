// orders.js — 주문·입금 확정·검수·신고·킬 집계 서비스(HTTP 없이). 저장소는 메모리 모드.
//   PRD 핵심 불변식:
//   - 확정된 입금만 장부에 들어간다(추가 전용 장부의 유일한 기준)
//   - 같은 웹훅이 두 번 와도 한 번만 반영(멱등)
//   - 금액이 주문과 다르면 반영하지 않는다
//   - 권리침해 신고는 즉시 가림(정보통신망법 44조의2 임시조치)
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createOrderService, ORDER_STATUS, REPORT_HIDE_THRESHOLD } = require('./orders.js');
const { createStore } = require('./store.js');
const { createMockProvider } = require('./payments.js');
const M = require('./moderation.js');

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CONSENTS = { rights: true, dilution: true, refund: true };

function setup({ classifier = M.reviewAllClassifier(), now = () => 1_000 } = {}) {
  const events = [];
  const saved = [];
  const service = createOrderService({
    store: createStore({ file: null }),
    provider: createMockProvider({ secret: 's', now }),
    classifier,
    saveImage: (id, img) => { saved.push(id); return `/uploads/${id}.${img.ext}`; },
    broadcast: (type, data) => events.push({ type, data }),
    now,
    seedLedger: [{ id: 'house', name: '하우스', slots: 10, logo: 'assets/logos/ad-wanted.svg', isHouse: true }],
  });
  return { service, events, saved };
}

async function paidSnipe(service, name = '민수', slots = 1) {
  const order = await service.createOrder({ kind: 'snipe', name, slots, consents: CONSENTS });
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: order.amount });
  return order;
}

test('createOrder: 동의 3종이 모두 있어야 한다', async () => {
  const { service } = setup();
  await assert.rejects(service.createOrder({ kind: 'snipe', name: '민수', slots: 1, consents: { rights: true } }), /동의/);
});

test('createOrder: 칸 수는 1 이상 정수, 주문당 상한 이하', async () => {
  const { service } = setup();
  for (const slots of [0, 1.5, -3, 'x']) {
    await assert.rejects(service.createOrder({ kind: 'snipe', name: '민수', slots, consents: CONSENTS }), /칸/);
  }
});

test('createOrder: 금액 = 칸 × 1,000원, 가상계좌 발급, 아직 장부에 없음', async () => {
  const { service } = setup();
  const order = await service.createOrder({ kind: 'snipe', name: '민수', slots: 7, consents: CONSENTS });
  assert.equal(order.amount, 7000);
  assert.equal(order.status, ORDER_STATUS.AWAITING_DEPOSIT);
  assert.match(order.virtualAccount.accountNumber, /^\d{14}$/);
  assert.equal(service.getLedger().advertisers.some((a) => a.name === '민수'), false);
});

test('createOrder: 로고 광고는 이미지 필수, 욕설 이름은 계좌 발급 전에 거절', async () => {
  const { service } = setup();
  await assert.rejects(service.createOrder({ kind: 'logo', name: '치킨', slots: 1, consents: CONSENTS }), /이미지/);
  await assert.rejects(service.createOrder({ kind: 'snipe', name: '시발', slots: 1, consents: CONSENTS }), /사용할 수 없는/);
});

test('confirmDeposit: 텍스트 저격 광고는 입금 즉시 출연 + purchase 이벤트', async () => {
  const { service, events } = setup();
  const order = await paidSnipe(service, '민수', 3);
  const ledger = service.getLedger();
  const ad = ledger.advertisers.find((a) => a.name === '민수');
  assert.ok(ad);
  assert.equal(ledger.soldSlots, 3, '하우스 칸은 판매 칸에 안 센다');
  assert.equal(service.getOrder(order.orderId).status, ORDER_STATUS.ACTIVE);
  const ev = events.find((e) => e.type === 'purchase');
  assert.equal(ev.data.name, '민수');
  assert.equal(ev.data.slots, 3);
});

test('confirmDeposit: 같은 웹훅 두 번 → 한 번만 반영(멱등)', async () => {
  const { service } = setup();
  const order = await paidSnipe(service, '민수', 2);
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: order.amount });
  assert.equal(service.getLedger().soldSlots, 2);
});

test('confirmDeposit: 금액 불일치·미완료 상태·없는 주문은 반영하지 않는다', async () => {
  const { service } = setup();
  const order = await service.createOrder({ kind: 'snipe', name: '민수', slots: 2, consents: CONSENTS });
  assert.throws(() => service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: 1000 }), /금액/);
  service.confirmDeposit({ orderId: order.orderId, status: 'WAITING', amount: 2000 });
  assert.equal(service.getLedger().soldSlots, 0);
  assert.throws(() => service.confirmDeposit({ orderId: 'nope', status: 'DONE', amount: 1 }), /주문/);
});

test('로고 광고: 입금 후 검토 대기 → 관리자 승인 시 출연', async () => {
  const { service, saved } = setup();
  const order = await service.createOrder({ kind: 'logo', name: '치킨집', slots: 5, image: PNG_1PX, consents: CONSENTS });
  assert.equal(order.review, true);
  assert.equal(saved.length, 1);
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: 5000 });
  assert.equal(service.getOrder(order.orderId).status, ORDER_STATUS.PENDING_REVIEW);
  assert.equal(service.getLedger().soldSlots, 0);
  service.adminAction(order.advertiserId, 'approve');
  assert.equal(service.getLedger().soldSlots, 5);
  assert.ok(service.getLedger().advertisers.find((a) => a.id === order.advertiserId).logoUrl.startsWith('/uploads/'));
});

test('관리자 거절 → 환불 필요 상태, 장부에 없음', async () => {
  const { service } = setup();
  const order = await service.createOrder({ kind: 'logo', name: '치킨집', slots: 5, image: PNG_1PX, consents: CONSENTS });
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: 5000 });
  service.adminAction(order.advertiserId, 'reject');
  assert.equal(service.getOrder(order.orderId).status, ORDER_STATUS.REFUND_REQUIRED);
  assert.equal(service.getLedger().soldSlots, 0);
});

test('자동 승인 분류기면 로고 광고도 입금 즉시 출연', async () => {
  const { service } = setup({ classifier: M.autoApproveClassifier() });
  const order = await service.createOrder({ kind: 'logo', name: '치킨집', slots: 5, image: PNG_1PX, consents: CONSENTS });
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: 5000 });
  assert.equal(service.getLedger().soldSlots, 5);
});

test('입금 기한이 지난 주문은 입금이 와도 반영하지 않고 환불 필요로 둔다', async () => {
  let t = 0;
  const { service } = setup({ now: () => t });
  const order = await service.createOrder({ kind: 'snipe', name: '민수', slots: 1, consents: CONSENTS });
  t = 25 * 3600 * 1000;
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: 1000 });
  assert.equal(service.getOrder(order.orderId).status, ORDER_STATUS.REFUND_REQUIRED);
  assert.equal(service.getLedger().soldSlots, 0);
});

test('권리침해 신고 1건 → 즉시 가림 + takedown 이벤트, 관리자 복구 가능', async () => {
  const { service, events } = setup();
  const order = await paidSnipe(service);
  service.report({ advId: order.advertiserId, reason: 'rights', reporter: 'ip-a' });
  assert.equal(service.getLedger().soldSlots, 0);
  assert.ok(events.some((e) => e.type === 'takedown'));
  service.adminAction(order.advertiserId, 'restore');
  assert.equal(service.getLedger().soldSlots, 1);
});

test(`일반 신고는 서로 다른 신고자 ${REPORT_HIDE_THRESHOLD}명부터 가림, 같은 신고자 중복은 1명`, async () => {
  const { service } = setup();
  const order = await paidSnipe(service);
  for (let i = 0; i < REPORT_HIDE_THRESHOLD + 2; i += 1) service.report({ advId: order.advertiserId, reason: 'obscene', reporter: 'same' });
  assert.equal(service.getLedger().soldSlots, 1);
  for (let i = 1; i < REPORT_HIDE_THRESHOLD; i += 1) service.report({ advId: order.advertiserId, reason: 'obscene', reporter: `ip-${i}` });
  assert.equal(service.getLedger().soldSlots, 0);
});

test('하우스 광고는 신고로 가려지지 않는다(운영자 관리)', () => {
  const { service } = setup();
  service.report({ advId: 'house', reason: 'rights', reporter: 'x' });
  assert.ok(service.getLedger().advertisers.some((a) => a.id === 'house'));
});

test('recordKill: 장부에 있는 광고만, 오늘 순위는 킬 내림차순', async () => {
  const { service } = setup();
  const a = await paidSnipe(service, '민수');
  const b = await paidSnipe(service, '영희');
  service.recordKill(b.advertiserId);
  service.recordKill(b.advertiserId);
  service.recordKill(a.advertiserId);
  assert.throws(() => service.recordKill('nope'), /광고/);
  const ranking = service.getKillRanking();
  assert.deepEqual(ranking.map((r) => [r.name, r.kills]), [['영희', 2], ['민수', 1]]);
});

test('getLedger: 보스 = 하우스 제외 최다 칸, 공개 규칙 포함', async () => {
  const { service } = setup();
  await paidSnipe(service, '민수', 1);
  const big = await paidSnipe(service, '영희', 4);
  const ledger = service.getLedger();
  assert.equal(ledger.bossId, big.advertiserId);
  assert.equal(ledger.maxSlots, 1000000);
  assert.ok(ledger.rules.snipeRate > 0);
});

test('판매 한도 초과 주문은 거절', async () => {
  const { service } = setup();
  await assert.rejects(service.createOrder({ kind: 'snipe', name: '민수', slots: 1000001, consents: CONSENTS }), /칸/);
});

test('getOrder: 모르는 주문은 null, 응답에 내부 필드(서명·이미지 버퍼) 없음', async () => {
  const { service } = setup();
  assert.equal(service.getOrder('nope'), null);
  const order = await paidSnipe(service);
  const view = service.getOrder(order.orderId);
  assert.equal(view.snipeUrl, `/?snipe=${order.advertiserId}`);
  assert.equal('image' in view, false);
});

test('[규칙] 확률 분모는 "팔린" 칸 — 유료 광고가 있으면 하우스 광고는 장부에서 빠진다', async () => {
  const { service } = setup();
  assert.ok(service.getLedger().advertisers.every((a) => a.isHouse), '유료 0개면 하우스만');
  const order = await paidSnipe(service, '첫손님', 1);
  const ledger = service.getLedger();
  assert.deepEqual(ledger.advertisers.map((a) => a.id), [order.advertiserId]);
  assert.equal(ledger.advertisers[0].share, 1, '첫 광고주 1칸 = 100%');
});

// ── 테스트 모드(결제 없이 바로 추가) ─────────────────────────────
test('[테스트 모드] instantActivate: 주문 즉시 출연(입금 단계 없음), 로고도 자동승인 분류기면 바로', async () => {
  const events = [];
  const service = createOrderService({
    store: createStore({ file: null }),
    provider: createMockProvider({ secret: 's', now: () => 1 }),
    classifier: M.autoApproveClassifier(),
    saveImage: (id, img) => `/uploads/${id}.${img.ext}`,
    broadcast: (type, data) => events.push({ type, data }),
    now: () => 1,
    seedLedger: [],
    instantActivate: true,
  });
  const snipe = await service.createOrder({ kind: 'snipe', name: '바로', slots: 3, consents: CONSENTS });
  assert.equal(snipe.status, ORDER_STATUS.ACTIVE);
  const logo = await service.createOrder({ kind: 'logo', name: '로고', slots: 2, image: PNG_1PX, consents: CONSENTS });
  assert.equal(logo.status, ORDER_STATUS.ACTIVE);
  assert.equal(service.getLedger().soldSlots, 5);
  assert.equal(events.filter((e) => e.type === 'purchase').length, 2);
});

test('[이동 주소] 주문에 저장되고 장부에 공개, 잘못된 주소는 계좌 발급 전 거절', async () => {
  const { service } = setup({ classifier: M.autoApproveClassifier() });
  await assert.rejects(service.createOrder({ kind: 'snipe', name: '민수', slots: 1, landingUrl: 'javascript:alert(1)', consents: CONSENTS }), /주소/);
  const order = await service.createOrder({ kind: 'snipe', name: '민수', slots: 1, landingUrl: 'https://minsu.example', consents: CONSENTS });
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: order.amount });
  const ad = service.getLedger().advertisers.find((a) => a.id === order.advertiserId);
  assert.equal(ad.landingUrl, 'https://minsu.example/');
});

test('[이동 주소] 기본 검수(review-all)에서는 텍스트 광고도 이동 주소가 있으면 승인 대기', async () => {
  const { service } = setup();
  const order = await service.createOrder({ kind: 'snipe', name: '민수', slots: 1, landingUrl: 'https://minsu.example', consents: CONSENTS });
  assert.equal(order.review, true);
});
