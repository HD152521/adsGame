// 결제 제공자 — PRD 결정: 개인사업자 + PG 가상계좌 + 웹훅.
//   인터페이스:
//     issueVirtualAccount({ orderId, amount }) → { bank, accountNumber, holder, dueAt }
//     verifyWebhook(headers, rawBody) → { orderId, status, amount }  (서명 검증 실패 시 throw)
//   사업자 등록·PG 가입 전이라 지금은 모의 PG만 있다. 실제 PG를 붙일 때는 이 인터페이스를 구현한
//   provider를 만들어 server/index.js에서 교체한다(PG 문서의 웹훅 검증 방식 그대로 — 추측으로 구현 금지).
//   실행 검증: apps/ad-dodge 안에서 node --test (server/payments.test.js)

const crypto = require('node:crypto');

const DEPOSIT_WINDOW_MS = 24 * 3600 * 1000;
const ACCOUNT_HOLDER = '이건광고입니다';

function createMockProvider({ secret, now = Date.now }) {
  if (!secret) throw new Error('모의 PG 웹훅 서명 비밀값(secret)이 필요합니다');
  const sign = (raw) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

  return {
    name: 'mock',
    sign,
    issueVirtualAccount({ orderId }) {
      if (!orderId) throw new Error('orderId가 필요합니다');
      const digits = Array.from(crypto.randomBytes(14), (b) => String(b % 10)).join('');
      return { bank: '모의은행', accountNumber: digits, holder: ACCOUNT_HOLDER, dueAt: now() + DEPOSIT_WINDOW_MS };
    },
    verifyWebhook(headers, rawBody) {
      const given = String(headers['x-mock-signature'] || '');
      const expected = sign(rawBody);
      const ok = given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
      if (!ok) throw new Error('웹훅 서명이 올바르지 않습니다');
      const { orderId, status, amount } = JSON.parse(rawBody);
      return { orderId, status, amount };
    },
  };
}

module.exports = { createMockProvider, DEPOSIT_WINDOW_MS };
