// 주문·입금 확정·검수·신고·킬 집계 서비스 — HTTP와 분리된 비즈니스 규칙.
//
// 상태 흐름:
//   createOrder ─(이름·이미지 1차 검수 통과)→ AWAITING_DEPOSIT (가상계좌 발급)
//   confirmDeposit ─(검수 승인)→ ACTIVE          ← 장부에 들어가는 유일한 상태
//                  ─(검수 대기)→ PENDING_REVIEW ─(관리자 approve)→ ACTIVE
//                  ─(기한 초과·한도 초과)→ REFUND_REQUIRED
//   ACTIVE ─(권리침해 신고 즉시 / 일반 신고 누적)→ HIDDEN ─(관리자 restore)→ ACTIVE
//   관리자 reject → REFUND_REQUIRED ─(관리자가 직접 돌려준 뒤 "환불 완료" 기록)→ REFUNDED (끝 — 되돌리기 없음)
//
// 불변식(server/orders.test.js):
//   - 장부 = ACTIVE 주문(하나도 없을 때만 하우스 광고). 확정되지 않은 돈은 확률에 영향을 주지 않는다
//   - 같은 웹훅이 두 번 와도 한 번만 반영, 금액이 다르면 반영하지 않는다
//   - orderId는 추측 불가능한 비밀 토큰(주문 조회 권한), advertiserId는 공개 id — 둘을 섞지 않는다
//   - PG 웹훅 검증값(payment.webhookSecret)·paymentKey는 주문에만 저장하고 공개 응답(publicView)에 넣지 않는다
//   - REFUNDED 는 REFUND_REQUIRED 에서만 들어갈 수 있고 빠져나가는 길이 없다(server/refund.test.js).
//     PG 환불 API 는 부르지 않는다 — 사람이 이체한 뒤 처리 일시·메모를 "기록"만 한다

const crypto = require('node:crypto');
const { SLOT_PRICE, MAX_SLOTS, computeShares, findBossId, SNIPE_RATE } = require('../shares.js');
const { BOSS_SIZE_MULTIPLIER } = require('../game.js');
const { validateName, decodeImage, validateLandingUrl } = require('./moderation.js');
const { createStatsService } = require('./stats.js');

const ORDER_STATUS = Object.freeze({
  AWAITING_DEPOSIT: 'awaiting_deposit',
  PENDING_REVIEW: 'pending_review',
  ACTIVE: 'active',
  HIDDEN: 'hidden',
  REFUND_REQUIRED: 'refund_required',
  REFUNDED: 'refunded',
});
const REFUND_MEMO_MAX = 200;
const REFUND_CLOCK_SKEW_MS = 60_000; // 관리자 PC 시계가 조금 빨라도 "미래"로 거부하지 않게
const MAX_SLOTS_PER_ORDER = 100000; // 1억 원 — 오입력 방지
const REPORT_HIDE_THRESHOLD = 3;
const REPORT_REASONS = new Set(['rights', 'obscene', 'hate', 'other']);
const KINDS = new Set(['logo', 'snipe']);

const randomId = (bytes) => crypto.randomBytes(bytes).toString('hex');

/** PG에 가상계좌를 받는다 → { virtualAccount(공개), payment(비공개: 웹훅 검증값·결제 키) } */
async function issueAccount(provider, { orderId, amount, customerName }) {
  const { webhookSecret, paymentKey, ...virtualAccount } = await provider.issueVirtualAccount({ orderId, amount, customerName });
  return { virtualAccount, payment: webhookSecret ? { webhookSecret, paymentKey: paymentKey || null } : null };
}

/** 환불 처리 일시(ISO 문자열·ms, 없으면 지금) → ms. 주문 전·미래는 거부 */
function parseRefundedAt(value, { createdAt, nowMs }) {
  if (value === undefined || value === null || value === '') return nowMs;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ms) || ms < createdAt || ms > nowMs + REFUND_CLOCK_SKEW_MS) throw new Error('환불 처리 일시가 올바르지 않아요(주문 이후 ~ 지금 사이)');
  return ms;
}

/** 환불 메모 → 앞뒤 공백·제어 문자를 뺀 문자열(200자까지) */
function parseRefundMemo(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('환불 메모는 글자로 적어 주세요');
  const memo = Array.from(value, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c)).join('').trim();
  if (memo.length > REFUND_MEMO_MAX) throw new Error(`환불 메모는 ${REFUND_MEMO_MAX}자까지예요`);
  return memo;
}

function assertConsents(consents) {
  const c = consents || {};
  if (!(c.rights === true && c.dilution === true && c.refund === true)) {
    throw new Error('필수 동의 3가지(권리 보유·지분 희석·환불 규정)에 모두 동의해 주세요');
  }
}

function assertSlots(slots) {
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS_PER_ORDER) {
    throw new Error(`칸 수는 1~${MAX_SLOTS_PER_ORDER.toLocaleString('ko-KR')} 사이 정수여야 해요`);
  }
}

// instantActivate: 테스트 모드(FREE_MODE) — 결제 단계 없이 주문 즉시 입금 확정 처리. 검수 규칙은 그대로 적용된다.
// 관리자 상태 바꾸기 작업 — 이름을 늘리면 server/audit-log.js 의 AUDIT_ACTIONS 에도 넣어야 한다
//   (app.js 가 시작할 때 둘을 맞춰 보고, 어긋나면 서버를 띄우지 않는다)
const ADMIN_TRANSITIONS = Object.freeze({
  approve: { from: [ORDER_STATUS.PENDING_REVIEW], to: ORDER_STATUS.ACTIVE },
  reject: { from: [ORDER_STATUS.PENDING_REVIEW, ORDER_STATUS.ACTIVE, ORDER_STATUS.HIDDEN], to: ORDER_STATUS.REFUND_REQUIRED },
  hide: { from: [ORDER_STATUS.ACTIVE], to: ORDER_STATUS.HIDDEN },
  restore: { from: [ORDER_STATUS.HIDDEN], to: ORDER_STATUS.ACTIVE },
});
const ADMIN_ACTIONS = Object.freeze(Object.keys(ADMIN_TRANSITIONS));

function createOrderService({ store, provider, classifier, saveImage, broadcast, now, seedLedger, instantActivate = false }) {
  const orders = () => store.read().orders;
  // 주소에서 온 orderId(__proto__·constructor 등)로 프로토타입 속성을 주문으로 착각하지 않게 — 자기 키만 본다
  const ownOrder = (orderId) => (Object.prototype.hasOwnProperty.call(orders(), String(orderId)) ? orders()[orderId] : null);
  // 칸 추가 구매로 한 광고(advertiserId)가 주문 여러 건으로 나뉠 수 있다 — 가림·복구는 언제나 함께
  const ordersOf = (advId) => Object.values(orders()).filter((o) => o.advertiserId === advId);
  const findByAdvertiser = (advId) => ordersOf(advId).sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  const putOrder = (order) => store.update((s) => ({ ...s, orders: { ...s.orders, [order.orderId]: order } }));
  const activeOrders = () => Object.values(orders()).filter((o) => o.status === ORDER_STATUS.ACTIVE);
  const soldSlots = () => activeOrders().reduce((sum, o) => sum + o.slots, 0);
  const stats = createStatsService({ store, now, getLedger: () => getLedger() });

  // 확률 분모 = "팔린" 칸(PRD 핵심 규칙). 하우스 광고는 유료 광고가 하나도 없을 때만 빈 화면을 채운다 —
  // 유료가 생기는 순간 빠진다. (하우스를 섞으면 첫 광고주 1칸이 100%가 아니라 1%가 된다.)
  function getLedger() {
    const paid = activeOrders()
      .sort((a, b) => a.paidAt - b.paidAt)
      .map((o) => ({ id: o.advertiserId, name: o.name, slots: o.slots, logoUrl: o.logoUrl, landingUrl: o.landingUrl || null, isHouse: false, kind: o.kind, firstPaidAt: o.paidAt }));
    const house = seedLedger.map((e) => ({ id: e.id, name: e.name, slots: e.slots, logoUrl: e.logo, landingUrl: null, isHouse: true, kind: 'logo' }));
    const entries = paid.length > 0 ? paid : house;
    const shares = computeShares(entries);
    return {
      slotPrice: SLOT_PRICE,
      maxSlots: MAX_SLOTS,
      soldSlots: soldSlots(),
      bossId: findBossId(shares),
      rules: { snipeRate: SNIPE_RATE, bossSizeMultiplier: BOSS_SIZE_MULTIPLIER, reportHideThreshold: REPORT_HIDE_THRESHOLD },
      advertisers: shares,
    };
  }

  function publicView(o) {
    if (!o) return null;
    const expired = o.status === ORDER_STATUS.AWAITING_DEPOSIT && now() > o.virtualAccount.dueAt;
    return {
      orderId: o.orderId,
      advertiserId: o.advertiserId,
      kind: o.kind,
      name: o.name,
      slots: o.slots,
      amount: o.amount,
      status: expired ? 'expired' : o.status,
      review: o.review,
      virtualAccount: o.virtualAccount,
      logoUrl: o.logoUrl,
      landingUrl: o.landingUrl || null,
      topup: Boolean(o.parentOrderId),
      stats: stats.statsFor(o.advertiserId),
      snipeUrl: `/?snipe=${o.advertiserId}`,
    };
  }

  function announceActive(order) {
    const ad = getLedger().advertisers.find((a) => a.id === order.advertiserId);
    broadcast('purchase', { advertiserId: order.advertiserId, name: order.name, slots: order.slots, share: ad ? ad.share : 0, soldSlots: soldSlots() });
  }

  async function createOrder({ kind, name: rawName, slots, image, landingUrl: rawLandingUrl, consents }) {
    if (!KINDS.has(kind)) throw new Error('광고 종류를 골라 주세요');
    assertConsents(consents);
    assertSlots(slots);
    if (soldSlots() + slots > MAX_SLOTS) throw new Error('남은 칸보다 많이 살 수 없어요');
    const { name, error } = validateName(rawName);
    if (error) throw new Error(error);
    const landing = validateLandingUrl(rawLandingUrl);
    if (landing.error) throw new Error(landing.error);

    let decoded = null;
    if (kind === 'logo') {
      if (!image) throw new Error('로고 광고는 이미지가 필요해요');
      decoded = decodeImage(image);
      if (decoded.error) throw new Error(decoded.error);
    }
    const verdict = await classifier.classify({ image: decoded, landingUrl: landing.url });
    if (verdict === 'reject') throw new Error('사용할 수 없는 이미지예요');

    const orderId = randomId(16);
    const advertiserId = randomId(6);
    const amount = slots * SLOT_PRICE;
    // 계좌를 먼저 받는다 — PG가 실패하면 이미지도 저장하지 않고 주문도 남기지 않는다
    const { virtualAccount, payment } = await issueAccount(provider, { orderId, amount, customerName: name });
    const order = {
      orderId,
      advertiserId,
      kind,
      name,
      slots,
      amount,
      status: ORDER_STATUS.AWAITING_DEPOSIT,
      review: verdict === 'review',
      logoUrl: decoded ? saveImage(advertiserId, decoded) : null,
      landingUrl: landing.url,
      virtualAccount,
      payment,
      createdAt: now(),
      paidAt: null,
    };
    putOrder(order);
    if (instantActivate) return confirmDeposit({ orderId, status: 'DONE', amount });
    return publicView(order);
  }

  /** 칸 추가: 붙어 있는 내 광고(orderId = 소유 증명)에 칸만 더한다. 이미 검수된 내용이라 다시 검수하지 않는다 */
  async function createTopup(parentOrderId, { slots, consents }) {
    const parent = ownOrder(parentOrderId);
    if (!parent) throw new Error('주문을 찾을 수 없습니다');
    if (parent.status !== ORDER_STATUS.ACTIVE) throw new Error('붙어 있는 광고에만 칸을 더할 수 있어요');
    assertConsents(consents);
    assertSlots(slots);
    if (soldSlots() + slots > MAX_SLOTS) throw new Error('남은 칸보다 많이 살 수 없어요');
    const orderId = randomId(16);
    const amount = slots * SLOT_PRICE;
    const { virtualAccount, payment } = await issueAccount(provider, { orderId, amount, customerName: parent.name });
    const order = {
      ...parent,
      orderId,
      parentOrderId,
      slots,
      amount,
      status: ORDER_STATUS.AWAITING_DEPOSIT,
      review: false,
      virtualAccount,
      payment, // 부모 주문의 검증값을 물려받지 않는다 — 주문마다 PG가 따로 준다
      createdAt: now(),
      paidAt: null,
    };
    putOrder(order);
    if (instantActivate) return confirmDeposit({ orderId, status: 'DONE', amount });
    return publicView(order);
  }

  function confirmDeposit({ orderId, status, amount }) {
    const order = ownOrder(orderId);
    if (!order) throw new Error('주문을 찾을 수 없습니다');
    if (status !== 'DONE' || order.status !== ORDER_STATUS.AWAITING_DEPOSIT) return publicView(order); // 멱등
    if (amount !== order.amount) throw new Error(`입금 금액이 주문과 다릅니다 (주문 ${order.amount}, 입금 ${amount})`);

    const paidAt = now();
    const late = paidAt > order.virtualAccount.dueAt;
    const overflow = soldSlots() + order.slots > MAX_SLOTS;
    // 칸 추가 입금 사이에 원래 광고가 가려지거나 내려갔으면 붙이지 않고 환불
    const parentGone = order.parentOrderId && (orders()[order.parentOrderId] || {}).status !== ORDER_STATUS.ACTIVE;
    let next = ORDER_STATUS.ACTIVE;
    if (late || overflow || parentGone) next = ORDER_STATUS.REFUND_REQUIRED;
    else if (order.review) next = ORDER_STATUS.PENDING_REVIEW;

    const updated = { ...order, status: next, paidAt };
    putOrder(updated);
    if (next === ORDER_STATUS.ACTIVE) announceActive(updated);
    if (next === ORDER_STATUS.PENDING_REVIEW) broadcast('review', { count: listAdvertisers(ORDER_STATUS.PENDING_REVIEW).length });
    return publicView(updated);
  }

  /**
   * 관리자 수정: 이름·이동 주소·로고만(칸 수·금액은 돈이라 거절·환불 흐름으로). 보낸 항목만 바꾸고,
   * 구매 때와 같은 검증을 거친다. 칸 추가로 나뉜 주문 전체에 함께 적용하고, 화면들에 장부를 새로 받게 알린다.
   */
  function editAdvertiser(advId, { name: rawName, landingUrl: rawUrl, image } = {}) {
    const list = ordersOf(advId);
    if (list.length === 0) throw new Error('광고를 찾을 수 없습니다');
    const editable = list.filter((o) => o.status !== ORDER_STATUS.REFUND_REQUIRED && o.status !== ORDER_STATUS.REFUNDED);
    if (editable.length === 0) throw new Error('환불 대상 광고는 고칠 수 없어요');
    const patch = {};
    if (rawName !== undefined) {
      const { name, error } = validateName(rawName);
      if (error) throw new Error(error);
      patch.name = name;
    }
    if (rawUrl !== undefined) {
      const landing = validateLandingUrl(rawUrl);
      if (landing.error) throw new Error(landing.error);
      patch.landingUrl = landing.url;
    }
    if (image) {
      const decoded = decodeImage(image);
      if (decoded.error) throw new Error(decoded.error);
      patch.logoUrl = `${saveImage(advId, decoded)}?v=${now()}`; // 같은 파일 경로 — ?v로 브라우저 캐시를 끊는다
    }
    for (const o of editable) putOrder({ ...o, ...patch });
    broadcast('ledger', { advertiserId: advId });
    return publicView(orders()[editable[0].orderId]);
  }

  /** 한 광고의 주문들 중 fromStatuses에 있는 것을 전부 status로 — 알림은 광고당 한 번 */
  function setAdvertiserStatus(advId, fromStatuses, status) {
    const targets = ordersOf(advId).filter((o) => fromStatuses.includes(o.status));
    const wasActive = targets.some((o) => o.status === ORDER_STATUS.ACTIVE);
    for (const o of targets) putOrder({ ...o, status });
    if (wasActive && status !== ORDER_STATUS.ACTIVE) broadcast('takedown', { advertiserId: advId });
    if (!wasActive && status === ORDER_STATUS.ACTIVE && targets.length > 0) announceActive(targets[0]);
    return targets;
  }

  function adminAction(advId, action) {
    const rule = Object.prototype.hasOwnProperty.call(ADMIN_TRANSITIONS, action) ? ADMIN_TRANSITIONS[action] : null;
    if (!rule) throw new Error(`알 수 없는 작업: ${action}`);
    const order = findByAdvertiser(advId);
    if (!order) throw new Error('광고를 찾을 수 없습니다');
    if (!rule.from.includes(order.status)) throw new Error(`${order.status} 상태에서는 ${action} 할 수 없습니다`);
    if (action === 'restore') store.update((s) => ({ ...s, reports: { ...s.reports, [advId]: { reporters: [], rights: false } } }));
    setAdvertiserStatus(advId, rule.from, rule.to);
    return publicView(orders()[order.orderId]);
  }

  /** 관리자 "환불 완료" 기록 — 주문 하나 단위(칸 추가 주문은 따로 돈을 냈으니 따로 돌려준다) */
  function markRefunded(orderId, { refundedAt, memo } = {}) {
    const order = ownOrder(orderId);
    if (!order) throw new Error('주문을 찾을 수 없습니다');
    if (order.status === ORDER_STATUS.REFUNDED) throw new Error('이미 환불 완료된 주문입니다');
    if (order.status !== ORDER_STATUS.REFUND_REQUIRED) throw new Error(`${order.status} 상태에서는 환불 완료 처리할 수 없습니다(환불 필요 주문만)`);
    const updated = {
      ...order,
      status: ORDER_STATUS.REFUNDED,
      refundedAt: parseRefundedAt(refundedAt, { createdAt: order.createdAt, nowMs: now() }),
      refundMemo: parseRefundMemo(memo),
    };
    putOrder(updated);
    return adminView(updated, store.read().reports);
  }

  function report({ advId, reason, reporter }) {
    if (!REPORT_REASONS.has(reason)) throw new Error('신고 사유를 골라 주세요');
    const order = findByAdvertiser(advId);
    if (!order) return { hidden: false }; // 하우스·없는 광고 — 운영자 관리 대상
    const prev = store.read().reports[advId] || { reporters: [], rights: false };
    const reporters = prev.reporters.includes(reporter) ? prev.reporters : [...prev.reporters, reporter];
    const next = { reporters, rights: prev.rights || reason === 'rights' };
    store.update((s) => ({ ...s, reports: { ...s.reports, [advId]: next } }));
    const shouldHide = next.rights || reporters.length >= REPORT_HIDE_THRESHOLD;
    if (shouldHide && ordersOf(advId).some((o) => o.status === ORDER_STATUS.ACTIVE)) {
      setAdvertiserStatus(advId, [ORDER_STATUS.ACTIVE], ORDER_STATUS.HIDDEN);
      return { hidden: true };
    }
    return { hidden: false };
  }

  function adminView(o, reports) {
    const r = reports[o.advertiserId] || { reporters: [] };
    return { ...publicView(o), createdAt: o.createdAt, paidAt: o.paidAt, refundedAt: o.refundedAt || null, refundMemo: o.refundMemo || '', reports: r.reporters.length, rightsReport: Boolean(r.rights) };
  }

  const ordersByStatus = (status) => Object.values(orders())
    .filter((o) => !status || o.status === status)
    .sort((a, b) => b.createdAt - a.createdAt);

  function listAdvertisers(status) {
    const reports = store.read().reports;
    return ordersByStatus(status).map((o) => adminView(o, reports));
  }

  /** CSV 내보내기용 — 허용한 필드만 골라 담는다(결제 secret·paymentKey·가상계좌는 처음부터 빠진다) */
  function exportRows(status) {
    return ordersByStatus(status).map((o) => ({
      orderId: o.orderId,
      name: o.name,
      kind: o.kind,
      slots: o.slots,
      amount: o.amount,
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      refundedAt: o.refundedAt || null,
      refundMemo: o.refundMemo || '',
    }));
  }

  return {
    createOrder,
    createTopup,
    confirmDeposit,
    getOrder: (orderId) => publicView(ownOrder(orderId)),
    /** PG 웹훅 검증용 — 발급 때 저장한 secret(없으면 null). 공개 API로 내보내지 않는다 */
    getWebhookSecret: (orderId) => {
      const o = ownOrder(orderId);
      return (o && o.payment && o.payment.webhookSecret) || null;
    },
    getLedger,
    adminAction,
    editAdvertiser,
    report,
    listAdvertisers,
    markRefunded,
    exportRows,
    recordKill: stats.recordKill,
    recordRun: stats.recordRun,
    getKillRanking: stats.getKillRanking,
    createChallenge: stats.createChallenge,
    getChallenge: stats.getChallenge,
  };
}

module.exports = { createOrderService, ORDER_STATUS, ADMIN_ACTIONS, REPORT_HIDE_THRESHOLD, MAX_SLOTS_PER_ORDER, REFUND_MEMO_MAX };
