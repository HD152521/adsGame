// 주문·입금 확정·검수·신고·킬 집계 서비스 — HTTP와 분리된 비즈니스 규칙.
//
// 상태 흐름:
//   createOrder ─(이름·이미지 1차 검수 통과)→ AWAITING_DEPOSIT (가상계좌 발급)
//   confirmDeposit ─(검수 승인)→ ACTIVE          ← 장부에 들어가는 유일한 상태
//                  ─(검수 대기)→ PENDING_REVIEW ─(관리자 approve)→ ACTIVE
//                  ─(기한 초과·한도 초과)→ REFUND_REQUIRED
//   ACTIVE ─(권리침해 신고 즉시 / 일반 신고 누적)→ HIDDEN ─(관리자 restore)→ ACTIVE
//   관리자 reject → REFUND_REQUIRED
//
// 불변식(server/orders.test.js):
//   - 장부 = ACTIVE 주문(하나도 없을 때만 하우스 광고). 확정되지 않은 돈은 확률에 영향을 주지 않는다
//   - 같은 웹훅이 두 번 와도 한 번만 반영, 금액이 다르면 반영하지 않는다
//   - orderId는 추측 불가능한 비밀 토큰(주문 조회 권한), advertiserId는 공개 id — 둘을 섞지 않는다

const crypto = require('node:crypto');
const { SLOT_PRICE, MAX_SLOTS, computeShares, findBossId, SNIPE_RATE } = require('../shares.js');
const { BOSS_SIZE_MULTIPLIER } = require('../game.js');
const { validateName, decodeImage, validateLandingUrl } = require('./moderation.js');

const ORDER_STATUS = Object.freeze({
  AWAITING_DEPOSIT: 'awaiting_deposit',
  PENDING_REVIEW: 'pending_review',
  ACTIVE: 'active',
  HIDDEN: 'hidden',
  REFUND_REQUIRED: 'refund_required',
});
const MAX_SLOTS_PER_ORDER = 100000; // 1억 원 — 오입력 방지
const REPORT_HIDE_THRESHOLD = 3;
const REPORT_REASONS = new Set(['rights', 'obscene', 'hate', 'other']);
const KILL_RANKING_SIZE = 10;
const KST_OFFSET_MS = 9 * 3600 * 1000;
const KINDS = new Set(['logo', 'snipe']);

const randomId = (bytes) => crypto.randomBytes(bytes).toString('hex');

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
function createOrderService({ store, provider, classifier, saveImage, broadcast, now, seedLedger, instantActivate = false }) {
  const orders = () => store.read().orders;
  const findByAdvertiser = (advId) => Object.values(orders()).find((o) => o.advertiserId === advId) || null;
  const putOrder = (order) => store.update((s) => ({ ...s, orders: { ...s.orders, [order.orderId]: order } }));
  const activeOrders = () => Object.values(orders()).filter((o) => o.status === ORDER_STATUS.ACTIVE);
  const soldSlots = () => activeOrders().reduce((sum, o) => sum + o.slots, 0);

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
      virtualAccount: provider.issueVirtualAccount({ orderId, amount }),
      createdAt: now(),
      paidAt: null,
    };
    putOrder(order);
    if (instantActivate) return confirmDeposit({ orderId, status: 'DONE', amount });
    return publicView(order);
  }

  function confirmDeposit({ orderId, status, amount }) {
    const order = orders()[orderId];
    if (!order) throw new Error('주문을 찾을 수 없습니다');
    if (status !== 'DONE' || order.status !== ORDER_STATUS.AWAITING_DEPOSIT) return publicView(order); // 멱등
    if (amount !== order.amount) throw new Error(`입금 금액이 주문과 다릅니다 (주문 ${order.amount}, 입금 ${amount})`);

    const paidAt = now();
    const late = paidAt > order.virtualAccount.dueAt;
    const overflow = soldSlots() + order.slots > MAX_SLOTS;
    let next = ORDER_STATUS.ACTIVE;
    if (late || overflow) next = ORDER_STATUS.REFUND_REQUIRED;
    else if (order.review) next = ORDER_STATUS.PENDING_REVIEW;

    const updated = { ...order, status: next, paidAt };
    putOrder(updated);
    if (next === ORDER_STATUS.ACTIVE) announceActive(updated);
    if (next === ORDER_STATUS.PENDING_REVIEW) broadcast('review', { count: listAdvertisers(ORDER_STATUS.PENDING_REVIEW).length });
    return publicView(updated);
  }

  const ADMIN_TRANSITIONS = {
    approve: { from: [ORDER_STATUS.PENDING_REVIEW], to: ORDER_STATUS.ACTIVE },
    reject: { from: [ORDER_STATUS.PENDING_REVIEW, ORDER_STATUS.ACTIVE, ORDER_STATUS.HIDDEN], to: ORDER_STATUS.REFUND_REQUIRED },
    hide: { from: [ORDER_STATUS.ACTIVE], to: ORDER_STATUS.HIDDEN },
    restore: { from: [ORDER_STATUS.HIDDEN], to: ORDER_STATUS.ACTIVE },
  };

  function setStatus(order, status) {
    const wasActive = order.status === ORDER_STATUS.ACTIVE;
    const updated = { ...order, status };
    putOrder(updated);
    if (wasActive && status !== ORDER_STATUS.ACTIVE) broadcast('takedown', { advertiserId: order.advertiserId });
    if (!wasActive && status === ORDER_STATUS.ACTIVE) announceActive(updated);
    return updated;
  }

  function adminAction(advId, action) {
    const rule = ADMIN_TRANSITIONS[action];
    if (!rule) throw new Error(`알 수 없는 작업: ${action}`);
    const order = findByAdvertiser(advId);
    if (!order) throw new Error('광고를 찾을 수 없습니다');
    if (!rule.from.includes(order.status)) throw new Error(`${order.status} 상태에서는 ${action} 할 수 없습니다`);
    if (action === 'restore') store.update((s) => ({ ...s, reports: { ...s.reports, [advId]: { reporters: [], rights: false } } }));
    return publicView(setStatus(order, rule.to));
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
    if (shouldHide && order.status === ORDER_STATUS.ACTIVE) {
      setStatus(order, ORDER_STATUS.HIDDEN);
      return { hidden: true };
    }
    return { hidden: false };
  }

  const todayKey = () => new Date(now() + KST_OFFSET_MS).toISOString().slice(0, 10);

  function recordKill(advId) {
    if (!getLedger().advertisers.some((a) => a.id === advId)) throw new Error('장부에 없는 광고입니다');
    const day = todayKey();
    store.update((s) => {
      const counts = s.kills[day] || {};
      return { ...s, kills: { [day]: { ...counts, [advId]: (counts[advId] || 0) + 1 } } }; // 오늘 것만 유지
    });
  }

  function getKillRanking() {
    const counts = store.read().kills[todayKey()] || {};
    const byId = new Map(getLedger().advertisers.map((a) => [a.id, a]));
    return Object.entries(counts)
      .filter(([id]) => byId.has(id))
      .map(([id, kills]) => ({ id, name: byId.get(id).name, isHouse: byId.get(id).isHouse, kills }))
      .sort((a, b) => b.kills - a.kills)
      .slice(0, KILL_RANKING_SIZE);
  }

  function listAdvertisers(status) {
    const reports = store.read().reports;
    return Object.values(orders())
      .filter((o) => !status || o.status === status)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((o) => ({ ...publicView(o), createdAt: o.createdAt, paidAt: o.paidAt, reports: (reports[o.advertiserId] || { reporters: [] }).reporters.length, rightsReport: Boolean((reports[o.advertiserId] || {}).rights) }));
  }

  return {
    createOrder,
    confirmDeposit,
    getOrder: (orderId) => publicView(orders()[orderId]),
    getLedger,
    adminAction,
    report,
    recordKill,
    getKillRanking,
    listAdvertisers,
  };
}

module.exports = { createOrderService, ORDER_STATUS, REPORT_HIDE_THRESHOLD, MAX_SLOTS_PER_ORDER };
