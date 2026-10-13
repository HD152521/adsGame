// 결제 제공자 — PRD 결정: 개인사업자 + PG 가상계좌 + 웹훅.
//   인터페이스:
//     issueVirtualAccount({ orderId, amount }) → { bank, accountNumber, holder, dueAt }
//     verifyWebhook(headers, rawBody) → { orderId, status, amount }  (서명 검증 실패 시 throw)
//   두 메서드는 동기·비동기 어느 쪽이어도 된다 — 호출부(orders.js·app.js)는 늘 await 한다.
//   제공자 선택: PAYMENT_PROVIDER=mock(기본) | toss
//     · mock — 모의 PG(아래). 로컬 기능 테스트용. WEBHOOK_SECRET 필요
//     · toss — 토스페이먼츠 가상계좌(server/payments-toss.js). TOSS_SECRET_KEY 필요, TOSS_VA_BANK 선택(기본 20 우리은행)
//   시크릿은 환경변수로만 받는다 — 코드·장부·저장소에 적지 않는다.
//   실행 검증: apps/ad-dodge 안에서 node --test (server/payments.test.js, server/payments-toss.test.js)

const crypto = require('node:crypto');
const { createTossProvider, SECRET_KEY_RE, VA_BANKS } = require('./payments-toss.js');

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

const PROVIDERS = ['mock', 'toss'];
const DEPOSIT_WINDOW_HOURS = DEPOSIT_WINDOW_MS / 3600 / 1000;

/** 환경변수 → { provider, tossSecretKey, tossBank } (PAYMENT_PROVIDER 기본 mock) */
function readPaymentConfig(env) {
  return {
    provider: String(env.PAYMENT_PROVIDER || 'mock').trim().toLowerCase(),
    tossSecretKey: String(env.TOSS_SECRET_KEY || '').trim(),
    tossBank: String(env.TOSS_VA_BANK || '').trim(),
  };
}

/** 결제 설정 점검 → 문제 목록(비었으면 통과). 키 값 자체는 메시지에 넣지 않는다 */
function checkPaymentConfig(env) {
  const c = readPaymentConfig(env);
  if (!PROVIDERS.includes(c.provider)) return [`PAYMENT_PROVIDER 는 ${PROVIDERS.join(' | ')} 중 하나여야 합니다.`];
  if (c.provider !== 'toss') return [];
  const errors = [];
  if (!c.tossSecretKey) errors.push('PAYMENT_PROVIDER=toss 이면 TOSS_SECRET_KEY 환경변수가 필요합니다(토스페이먼츠 시크릿 키).');
  else if (!SECRET_KEY_RE.test(c.tossSecretKey)) errors.push('TOSS_SECRET_KEY 형식이 올바르지 않습니다(test_sk_… 또는 live_sk_… — 클라이언트 키 아님).');
  if (c.tossBank && !VA_BANKS[c.tossBank]) errors.push(`TOSS_VA_BANK 는 가상계좌 발급 은행 코드여야 합니다(${Object.keys(VA_BANKS).join(', ')}).`);
  return errors;
}

/** 설정대로 제공자를 만든다. toss 는 lookupWebhookSecret(orderId → 발급 때 저장한 secret)이 필요 */
function createPaymentProvider({ provider = 'mock', webhookSecret, tossSecretKey, tossBank, fetch, lookupWebhookSecret, now = Date.now }) {
  if (provider === 'mock') return createMockProvider({ secret: webhookSecret, now });
  if (provider === 'toss') {
    return createTossProvider({ secretKey: tossSecretKey, bank: tossBank || undefined, fetch, lookupWebhookSecret, holder: ACCOUNT_HOLDER, validHours: DEPOSIT_WINDOW_HOURS });
  }
  throw new Error(`PAYMENT_PROVIDER 를 알 수 없습니다: ${provider}`);
}

module.exports = { createMockProvider, createPaymentProvider, readPaymentConfig, checkPaymentConfig, DEPOSIT_WINDOW_MS };
