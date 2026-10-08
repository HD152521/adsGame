// buy.js — 광고 구매 화면의 순수 로직(예상 지분·금액·폼 검증·저격 링크).
//   서버(server/orders.js, moderation.js)가 최종 판정한다 — 여기는 즉시 피드백용 거울일 뿐이다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('./buy.js');

test('estimateShare: 지금 사면 내 칸 ÷ (현재 장부 전체 + 내 칸)', () => {
  assert.equal(B.estimateShare(10, 90), 0.1);
  assert.equal(B.estimateShare(1, 0), 1);
});

test('formatWon: 1,000원 단위 금액 표시', () => {
  assert.equal(B.formatWon(1000), '1,000원');
  assert.equal(B.formatWon(1234000), '1,234,000원');
});

test('validateBuyForm: 동의 3종·이름·칸·로고 이미지', () => {
  const ok = { kind: 'snipe', name: '민수', slots: 1, image: null, consents: { rights: true, dilution: true, refund: true } };
  assert.deepEqual(B.validateBuyForm(ok), []);
  assert.ok(B.validateBuyForm({ ...ok, name: '  ' }).length > 0);
  assert.ok(B.validateBuyForm({ ...ok, slots: 0 }).length > 0);
  assert.ok(B.validateBuyForm({ ...ok, slots: 2.5 }).length > 0);
  assert.ok(B.validateBuyForm({ ...ok, kind: 'logo' }).some((e) => /이미지/.test(e)));
  assert.ok(B.validateBuyForm({ ...ok, consents: { rights: true, dilution: true } }).some((e) => /동의/.test(e)));
});

test('buildSnipeUrl: 공개 광고 id로만 만든다', () => {
  assert.equal(B.buildSnipeUrl('https://ad.example', 'abc123'), 'https://ad.example/?snipe=abc123');
});

test('readSnipeId: URL의 snipe 파라미터(영숫자만)', () => {
  assert.equal(B.readSnipeId('?snipe=abc123'), 'abc123');
  assert.equal(B.readSnipeId('?snipe=<script>'), null);
  assert.equal(B.readSnipeId(''), null);
});

test('orderStatusMessage: 상태별 안내 문구', () => {
  assert.match(B.orderStatusMessage('awaiting_deposit'), /입금/);
  assert.match(B.orderStatusMessage('active'), /날아/);
  assert.match(B.orderStatusMessage('pending_review'), /검수/);
  assert.match(B.orderStatusMessage('refund_required'), /환불/);
  assert.match(B.orderStatusMessage('expired'), /기한/);
});

test('isFinalStatus: 더 기다릴 필요 없는 상태', () => {
  assert.equal(B.isFinalStatus('awaiting_deposit'), false);
  assert.equal(B.isFinalStatus('pending_review'), false);
  for (const s of ['active', 'refund_required', 'expired', 'hidden']) assert.equal(B.isFinalStatus(s), true);
});

test('purchaseBannerText: 실시간 광고 전쟁 배너', () => {
  assert.equal(B.purchaseBannerText({ name: '치킨집', slots: 50, share: 0.623 }), '치킨집 · 50칸 붙임 · 지분 62.3%');
});

test('[규칙] paidSlots: 예상 지분 분모는 하우스 제외 팔린 칸', () => {
  assert.equal(B.paidSlots({ advertisers: [{ slots: 40, isHouse: true }, { slots: 3, isHouse: false }] }), 3);
  assert.equal(B.estimateShare(1, B.paidSlots({ advertisers: [{ slots: 40, isHouse: true }] })), 1);
});

test('[테스트 모드] submitLabel: 결제 없이 바로 추가일 때 버튼 문구', () => {
  assert.match(B.submitLabel({ freeMode: true }), /바로 붙이기/);
  assert.match(B.submitLabel({ freeMode: false }), /가상계좌/);
});

test('[이동 주소] validateBuyForm: 이동 주소는 선택, 스크립트 주소는 즉시 오류', () => {
  const ok = { kind: 'snipe', name: '민수', slots: 1, image: null, landingUrl: '', consents: { rights: true, dilution: true, refund: true } };
  assert.deepEqual(B.validateBuyForm(ok), []);
  assert.deepEqual(B.validateBuyForm({ ...ok, landingUrl: 'https://a.kr' }), []);
  assert.ok(B.validateBuyForm({ ...ok, landingUrl: 'javascript:alert(1)' }).some((e) => /주소/.test(e)));
});
