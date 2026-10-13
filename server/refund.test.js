// 환불 완료 기록(계획서 Step 5) — orders.js 서비스 단위(HTTP 없이). 저장소는 메모리 모드.
//   규칙:
//   - refund_required → refunded 만 허용. 다른 상태에서 refunded 금지, 다시 처리·되돌리기 없음
//   - 처리 일시·메모를 주문에 남긴다(관리자 목록·CSV 에 보인다)
//   - refunded 주문은 장부에 들어가지 않는다
//   실제 돈을 돌려주는 일(PG 환불 API)은 하지 않는다 — 사람이 이체한 뒤 "기록"만 한다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createOrderService, ORDER_STATUS } = require('./orders.js');
const { createStore } = require('./store.js');
const { createMockProvider } = require('./payments.js');
const M = require('./moderation.js');

const CONSENTS = { rights: true, dilution: true, refund: true };
const T0 = Date.UTC(2026, 9, 13, 3, 0, 0);

function setup() {
  let t = T0;
  const now = () => t;
  const service = createOrderService({
    store: createStore({ file: null }),
    provider: createMockProvider({ secret: 's', now }),
    classifier: M.reviewAllClassifier(),
    saveImage: (id, img) => `/uploads/${id}.${img.ext}`,
    broadcast: () => {},
    now,
    seedLedger: [{ id: 'house', name: '하우스', slots: 10, logo: 'assets/logos/ad-wanted.svg', isHouse: true }],
  });
  return { service, advance: (ms) => { t += ms; } };
}

/** 입금 → 관리자 거절 → 환불 필요 상태의 주문 */
async function refundRequired(service, name = '민수') {
  const order = await service.createOrder({ kind: 'snipe', name, slots: 2, consents: CONSENTS });
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: order.amount });
  service.adminAction(order.advertiserId, 'reject');
  assert.equal(service.getOrder(order.orderId).status, ORDER_STATUS.REFUND_REQUIRED);
  return order;
}

test('[환불] ORDER_STATUS 에 refunded 가 있다', () => {
  assert.equal(ORDER_STATUS.REFUNDED, 'refunded');
});

test('[환불] refund_required → refunded, 처리 일시·메모가 저장되고 "환불 완료" 목록에 보인다', async () => {
  const { service, advance } = setup();
  const order = await refundRequired(service);
  advance(3600_000);
  const at = T0 + 1800_000;
  const done = service.markRefunded(order.orderId, { refundedAt: new Date(at).toISOString(), memo: '  국민 123-45 이체 완료  ' });
  assert.equal(done.status, ORDER_STATUS.REFUNDED);
  assert.equal(done.refundedAt, at);
  assert.equal(done.refundMemo, '국민 123-45 이체 완료');

  const list = service.listAdvertisers(ORDER_STATUS.REFUNDED);
  assert.equal(list.length, 1);
  assert.equal(list[0].refundedAt, at);
  assert.equal(list[0].refundMemo, '국민 123-45 이체 완료');
  assert.equal(service.listAdvertisers(ORDER_STATUS.REFUND_REQUIRED).length, 0);
});

test('[환불] 처리 일시를 안 주면 지금 시각, 메모는 비워도 된다', async () => {
  const { service } = setup();
  const order = await refundRequired(service);
  const done = service.markRefunded(order.orderId, {});
  assert.equal(done.refundedAt, T0);
  assert.equal(done.refundMemo, '');
});

test('[환불] 다른 상태(입금 대기·검수 대기·붙어 있음·떼어 냄)에서는 환불 완료 처리할 수 없다', async () => {
  const { service } = setup();
  const awaiting = await service.createOrder({ kind: 'snipe', name: '대기', slots: 1, consents: CONSENTS });
  assert.throws(() => service.markRefunded(awaiting.orderId, {}), /환불/);

  const active = await service.createOrder({ kind: 'snipe', name: '붙음', slots: 1, consents: CONSENTS });
  service.confirmDeposit({ orderId: active.orderId, status: 'DONE', amount: active.amount });
  assert.equal(service.getOrder(active.orderId).status, ORDER_STATUS.ACTIVE); // 저격(이미지 없음)은 바로 붙는다
  assert.throws(() => service.markRefunded(active.orderId, {}), /환불/);
  // 검수 대기: 로고 광고는 reviewAll 이라 사람 검수를 기다린다
  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const pending = await service.createOrder({ kind: 'logo', name: '검수중', slots: 1, image: PNG_1PX, consents: CONSENTS });
  service.confirmDeposit({ orderId: pending.orderId, status: 'DONE', amount: pending.amount });
  assert.equal(service.getOrder(pending.orderId).status, ORDER_STATUS.PENDING_REVIEW);
  assert.throws(() => service.markRefunded(pending.orderId, {}), /환불/);
  service.adminAction(active.advertiserId, 'hide');
  assert.throws(() => service.markRefunded(active.orderId, {}), /환불/);
  assert.equal(service.getOrder(active.orderId).status, ORDER_STATUS.HIDDEN);
});

test('[환불] 이미 환불 완료된 주문은 다시 처리할 수 없고(처음 기록 유지), 없는 주문은 거부', async () => {
  const { service } = setup();
  const order = await refundRequired(service);
  service.markRefunded(order.orderId, { memo: '처음' });
  assert.throws(() => service.markRefunded(order.orderId, { memo: '두 번째' }), /이미 환불/);
  assert.equal(service.listAdvertisers(ORDER_STATUS.REFUNDED)[0].refundMemo, '처음');
  assert.throws(() => service.markRefunded('nope', {}), /주문/);
  assert.throws(() => service.markRefunded('__proto__', {}), /주문/);
});

test('[환불] 되돌리기 없음 — 관리자 작업(approve·restore·reject·hide)·입금 웹훅으로 refunded 에서 벗어나지 못한다', async () => {
  const { service } = setup();
  const order = await refundRequired(service);
  service.markRefunded(order.orderId, {});
  for (const action of ['approve', 'restore', 'reject', 'hide']) {
    assert.throws(() => service.adminAction(order.advertiserId, action));
    assert.equal(service.getOrder(order.orderId).status, ORDER_STATUS.REFUNDED);
  }
  service.confirmDeposit({ orderId: order.orderId, status: 'DONE', amount: order.amount });
  assert.equal(service.getOrder(order.orderId).status, ORDER_STATUS.REFUNDED);
  assert.throws(() => service.editAdvertiser(order.advertiserId, { name: '바꿈' }), /환불/);
});

test('[환불] refunded 주문은 장부에 들어가지 않는다', async () => {
  const { service } = setup();
  const order = await refundRequired(service, '환불됨');
  service.markRefunded(order.orderId, {});
  const ledger = service.getLedger();
  assert.equal(ledger.advertisers.some((a) => a.name === '환불됨'), false);
  assert.equal(ledger.soldSlots, 0);
});

test('[환불] 처리 일시·메모 검증 — 날짜가 아니거나 미래·주문 전이면 거부, 메모는 200자까지', async () => {
  const { service } = setup();
  const order = await refundRequired(service);
  assert.throws(() => service.markRefunded(order.orderId, { refundedAt: '어제쯤' }), /일시/);
  assert.throws(() => service.markRefunded(order.orderId, { refundedAt: new Date(T0 + 86400_000).toISOString() }), /일시/);
  assert.throws(() => service.markRefunded(order.orderId, { refundedAt: new Date(T0 - 86400_000).toISOString() }), /일시/);
  assert.throws(() => service.markRefunded(order.orderId, { memo: 'ㄱ'.repeat(201) }), /메모/);
  assert.throws(() => service.markRefunded(order.orderId, { memo: { x: 1 } }), /메모/);
  assert.equal(service.getOrder(order.orderId).status, ORDER_STATUS.REFUND_REQUIRED);
});
