// 토스페이먼츠 가상계좌 provider — server/payments.js 인터페이스를 그대로 구현한다(모두 async).
//     issueVirtualAccount({ orderId, amount, customerName? }) → { bank, accountNumber, holder, dueAt, webhookSecret, paymentKey }
//     verifyWebhook(headers, rawBody) → { orderId, status, amount }  (검증 실패 시 throw)
//
// 근거 문서(2026-10 확인 — 추측 구현 금지 원칙):
//   · 가상계좌 발급   POST /v1/virtual-accounts   필수 amount·orderId·orderName·customerName·bank, 선택 validHours(기본 168)
//                    응답 = Payment 객체(status WAITING_FOR_DEPOSIT, virtualAccount{accountNumber, bankCode, dueDate}, secret)
//                    https://docs.tosspayments.com/reference#가상계좌-발급-요청
//   · 결제 조회      GET /v1/payments/orders/{orderId}
//                    https://docs.tosspayments.com/reference#orderid로-결제-조회
//   · 입금 웹훅      DEPOSIT_CALLBACK 본문 { createdAt, secret, status, transactionKey, orderId } — 서명 헤더가 없고,
//                    "결제 응답의 secret 과 웹훅 본문의 secret 이 같으면 정상 웹훅"이 공식 검증 방법이다.
//                    https://docs.tosspayments.com/reference/using-api/webhook-events#deposit_callback
//                    10초 안에 200 을 못 받으면 최대 7회 재전송 — https://docs.tosspayments.com/guides/v2/webhook
//   · 인증           Authorization: Basic base64("{시크릿 키}:")  — 콜론 포함
//   · 멱등 키        Idempotency-Key 헤더(최대 300자, 15일 유효) — 같은 키 재요청은 첫 응답을 그대로 돌려준다
//
// 검증 순서(웹훅 본문만 믿지 않는다):
//   1) 본문의 orderId 로 우리 주문에 저장해 둔 secret 을 찾는다 — 없으면 우리 주문이 아님(거부, PG 조회도 안 함)
//   2) secret 을 상수 시간 비교 — 다르면 위조(거부)
//   3) 결제 조회 API 로 상태·금액을 다시 받아 그 값을 돌려준다(입금 확정 여부·금액 비교는 orders.confirmDeposit 이 한다)
//   PG 에 닿지 못하면 err.code = 'PG_UNAVAILABLE' — 서버는 503 을 돌려 토스가 재전송하게 한다.
//   실행 검증: apps/ad-dodge 안에서 node --test (server/payments-toss.test.js, server/app-toss.test.js)

const crypto = require('node:crypto');

const TOSS_API_BASE = 'https://api.tosspayments.com';
const SECRET_KEY_RE = /^(test|live)_sk_[A-Za-z0-9_-]+$/;
const ORDER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/; // 문서: 영문 대소문자·숫자·-·_ 6~64자
const REQUEST_TIMEOUT_MS = 8000; // 웹훅 응답 제한(10초) 안에 끝나야 한다
const KST_OFFSET = '+09:00';
const DEFAULT_BANK = '20';
const DEFAULT_CUSTOMER_NAME = '광고주';
const CUSTOMER_NAME_MAX = 100;
const ORDER_NAME = '이건광고입니다 광고 칸';
const ISSUE_FAILED = '가상계좌 발급에 실패했어요. 잠시 후 다시 시도해 주세요';
const WEBHOOK_INVALID = '웹훅 검증에 실패했습니다';

// 문서의 은행 코드 중 "가상계좌 발급 가능" 은행만(https://docs.tosspayments.com/codes/org-codes)
const VA_BANKS = Object.freeze({
  '39': '경남은행',
  '34': '광주은행',
  '06': 'KB국민은행',
  '03': 'IBK기업은행',
  '11': 'NH농협은행',
  '31': 'iM뱅크(대구)',
  '32': '부산은행',
  '07': 'Sh수협은행',
  '88': '신한은행',
  '20': '우리은행',
  '71': '우체국',
  '37': '전북은행',
  '81': '하나은행',
});

function pgUnavailable(detail) {
  const err = new Error(`결제사(토스페이먼츠)에 연결하지 못했습니다: ${detail}`);
  err.code = 'PG_UNAVAILABLE';
  return err;
}

/** 문서의 dueDate 는 시간대 없는 한국 시각(yyyy-MM-dd'T'HH:mm:ss) — 시간대가 붙어 오면 그대로 쓴다 */
function parseKstDate(value) {
  const s = String(value || '');
  const hasZone = /([+-]\d{2}:\d{2}|Z)$/.test(s);
  const ms = Date.parse(hasZone ? s : `${s}${KST_OFFSET}`);
  if (!Number.isFinite(ms)) throw new Error(`입금 기한 형식이 올바르지 않습니다: ${s}`);
  return ms;
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a) === String(b);
}

function createTossProvider({ secretKey, fetch = globalThis.fetch, lookupWebhookSecret, bank = DEFAULT_BANK, holder = '이건광고입니다', validHours = 24, apiBase = TOSS_API_BASE }) {
  if (!SECRET_KEY_RE.test(String(secretKey || ''))) throw new Error('TOSS_SECRET_KEY(시크릿 키 test_sk_… / live_sk_…)가 필요합니다');
  if (!VA_BANKS[bank]) throw new Error(`가상계좌를 발급할 수 없는 은행 코드입니다: ${bank}`);
  if (typeof lookupWebhookSecret !== 'function') throw new Error('lookupWebhookSecret(orderId → 저장된 웹훅 secret)이 필요합니다');
  if (typeof fetch !== 'function') throw new Error('fetch 가 필요합니다(Node 18+)');
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;

  /** 토스 API 호출 → { status, body }. 연결 실패·5xx 는 PG_UNAVAILABLE */
  async function call(method, pathname, { body, idempotencyKey } = {}) {
    const headers = { Authorization: authorization };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await fetch(`${apiBase}${pathname}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw pgUnavailable(err.message);
    }
    const parsed = await res.json().catch(() => null);
    if (res.status >= 500) throw pgUnavailable(`HTTP ${res.status} ${(parsed && parsed.code) || ''}`);
    return { status: res.status, body: parsed };
  }

  async function issueVirtualAccount({ orderId, amount, customerName }) {
    if (!ORDER_ID_RE.test(String(orderId || ''))) throw new Error('orderId 형식이 올바르지 않습니다');
    if (!Number.isInteger(amount) || amount < 1) throw new Error('금액이 올바르지 않습니다');
    const request = {
      amount,
      orderId,
      orderName: ORDER_NAME,
      customerName: String(customerName || DEFAULT_CUSTOMER_NAME).slice(0, CUSTOMER_NAME_MAX),
      bank,
      validHours,
    };
    let result;
    try {
      result = await call('POST', '/v1/virtual-accounts', { body: request, idempotencyKey: `va-${orderId}` });
    } catch (err) {
      console.error('[toss] 가상계좌 발급 요청 실패', err.message);
      throw new Error(ISSUE_FAILED);
    }
    const p = result.body || {};
    const va = p.virtualAccount;
    const ok = result.status === 200 && p.orderId === orderId && p.totalAmount === amount && p.status === 'WAITING_FOR_DEPOSIT' && va && va.accountNumber && p.secret;
    if (!ok) {
      console.error('[toss] 가상계좌 발급 응답 이상', result.status, p.code || p.status, p.message || '');
      throw new Error(ISSUE_FAILED);
    }
    let dueAt;
    try {
      dueAt = parseKstDate(va.dueDate);
    } catch (err) {
      // 다른 응답 이상과 똑같이 쉬운 말로 — PG 원문(날짜 문자열)을 사용자 오류 메시지로 흘리지 않는다
      console.error('[toss] 가상계좌 입금 기한 형식 이상', err.message);
      throw new Error(ISSUE_FAILED);
    }
    return {
      bank: VA_BANKS[va.bankCode] || VA_BANKS[bank],
      accountNumber: String(va.accountNumber),
      holder,
      dueAt,
      webhookSecret: String(p.secret),
      paymentKey: String(p.paymentKey || ''),
    };
  }

  async function verifyWebhook(_headers, rawBody) {
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      throw new Error(`${WEBHOOK_INVALID}(본문 형식)`);
    }
    const orderId = String((event && event.orderId) || '');
    const given = String((event && event.secret) || '');
    if (!ORDER_ID_RE.test(orderId) || !given) throw new Error(`${WEBHOOK_INVALID}(DEPOSIT_CALLBACK 형식 아님)`);
    const expected = lookupWebhookSecret(orderId);
    if (!expected) throw new Error(`${WEBHOOK_INVALID}(없는 주문)`);
    if (!safeEqual(given, expected)) throw new Error(`${WEBHOOK_INVALID}(secret 불일치)`);

    const { status, body: p } = await call('GET', `/v1/payments/orders/${encodeURIComponent(orderId)}`);
    if (status !== 200 || !p) throw new Error(`${WEBHOOK_INVALID}(결제 조회 HTTP ${status})`);
    if (p.orderId !== orderId) throw new Error(`${WEBHOOK_INVALID}(조회 주문번호 불일치)`);
    if (p.secret !== undefined && !safeEqual(p.secret, expected)) throw new Error(`${WEBHOOK_INVALID}(조회 secret 불일치)`);
    return { orderId, status: String(p.status || ''), amount: p.totalAmount };
  }

  return { name: 'toss', issueVirtualAccount, verifyWebhook };
}

module.exports = { createTossProvider, TOSS_API_BASE, VA_BANKS, SECRET_KEY_RE };
