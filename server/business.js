// 사업자 정보(전자상거래법 법정 표시) — 환경변수로만 받는다. 코드·장부에 실제 값을 적지 않는다.
//   운영 모드 = NODE_ENV=production. 운영 모드에서는
//     · 필수 값(상호·대표·사업자등록번호·주소·전화·이메일·호스팅)이 비거나 형식이 틀리면 서버를 띄우지 않는다
//     · FREE_MODE·DEV_DEPOSIT 이 켜져 있으면 띄우지 않는다(공짜 광고 방지)
//   통신판매업 신고번호(BIZ_MAIL_ORDER_NO)는 PG 구매안전서비스 확인증이 나온 뒤에야 신고할 수 있어서
//   (계획서 H3 → H4) 비어도 시작은 하고, 화면에는 "신고 준비 중"으로 적는다.
//   로컬 테스트 모드(start-test.cmd, NODE_ENV 없음)는 비어 있어도 뜨고 화면에 "사업자 정보 준비 중"이 나온다.
//   결제 설정(PAYMENT_PROVIDER·TOSS_SECRET_KEY·TOSS_VA_BANK)은 모드와 상관없이 점검한다 —
//   PAYMENT_PROVIDER=toss 인데 키가 없으면 결제가 안 되므로 운영이든 로컬이든 띄우지 않는다(server/payments.js).
//   검수 설정(MODERATION_MODE·GOOGLE_VISION_API_KEY)도 늘 점검한다 — vision 인데 키가 없으면 띄우지 않고,
//   auto-approve(전부 승인)는 운영 모드에서 띄우지 않는다(server/moderation.js checkModerationConfig).
//   운영 비밀값·결제(계획서 Step 4): 운영 모드에서는
//     · ADMIN_TOKEN 이 32자 미만이면 띄우지 않는다(로컬은 진입점에서 16자 규칙만)
//     · ADMIN_TOKEN 이 32자 이상이어도 문자 종류가 단조롭거나(같은 문자 반복 등, 서로 다른 문자 10종 미만)
//       로컬 기본값·자리표시 낱말(local-admin-token·changeme 등)이 들어 있으면 띄우지 않는다(계획서 Step 6)
//     · 모의 결제(PAYMENT_PROVIDER 없음·mock)면 띄우지 않는다 — 모의 PG는 실제 입금을 받지 못하고 웹훅 비밀값 하나로 입금이 확정된다
//   오류 문구에 비밀값 자체는 절대 넣지 않는다(로그로 새지 않게).

const { checkPaymentConfig, readPaymentConfig } = require('./payments.js');
const { checkModerationConfig } = require('./moderation.js');

const BUSINESS_FIELDS = [
  { env: 'BIZ_NAME', key: 'name', required: true },
  { env: 'BIZ_OWNER', key: 'owner', required: true },
  { env: 'BIZ_REG_NO', key: 'regNo', required: true },
  { env: 'BIZ_ADDRESS', key: 'address', required: true },
  { env: 'BIZ_PHONE', key: 'phone', required: true },
  { env: 'BIZ_EMAIL', key: 'email', required: true },
  { env: 'BIZ_MAIL_ORDER_NO', key: 'mailOrderNo', required: false },
  { env: 'HOSTING_PROVIDER', key: 'hostingProvider', required: true },
];

const FIELD_MAX_LENGTH = 200;
const REG_NO_DIGITS = 10; // 사업자등록번호 000-00-00000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRODUCTION_ADMIN_TOKEN_MIN = 32;
const ADMIN_TOKEN_MIN_DISTINCT = 10; // openssl rand -hex 32 는 16종을 거의 다 쓴다 — 10종 미만이면 사람이 지은 값
// 로컬 기본값(start-test.cmd)·흔한 자리표시 낱말 — 대소문자 무시
const WEAK_TOKEN_WORDS = ['local-admin-token', 'admin-token', 'changeme', 'change-me', 'password', 'example', 'placeholder'];

function isProductionMode(env) {
  return env.NODE_ENV === 'production';
}

/** 광고 접수(판매) 여부 — SALES_OPEN=0 이면 "광고 접수 준비 중": 주문·칸 추가·웹훅을 받지 않고 게임만 연다.
 *  돈을 받지 않으므로 사업자 정보·결제 키 없이도 운영 모드로 띄울 수 있다(사업자 등록·PG 심사 전 공개용) */
function isSalesOpen(env) {
  return String(env.SALES_OPEN ?? '1').trim() !== '0';
}

/** 환경변수 → { name, owner, regNo, address, phone, email, mailOrderNo, hostingProvider } (없으면 '') */
function readBusinessInfo(env) {
  return Object.fromEntries(BUSINESS_FIELDS.map((f) => [f.key, String(env[f.env] || '').trim().slice(0, FIELD_MAX_LENGTH)]));
}

function formatErrors(env, info) {
  const errors = [];
  if (info.regNo && info.regNo.replace(/-/g, '').length !== REG_NO_DIGITS) errors.push('BIZ_REG_NO 형식이 올바르지 않습니다(000-00-00000).');
  if (info.regNo && !/^[0-9-]+$/.test(info.regNo)) errors.push('BIZ_REG_NO 에는 숫자와 - 만 쓸 수 있습니다.');
  if (info.email && !EMAIL_RE.test(info.email)) errors.push('BIZ_EMAIL 형식이 올바르지 않습니다.');
  for (const name of ['FREE_MODE', 'DEV_DEPOSIT']) {
    if (env[name] === '1') errors.push(`${name}=1 은 운영 모드에서 켤 수 없습니다(결제 없이 광고가 붙습니다).`);
  }
  return errors;
}

/** 관리자 토큰 강도 → 약한 이유(문구, 값 자체는 넣지 않음) | null(통과) */
function adminTokenWeakness(token) {
  const value = String(token || '');
  if (value.length < PRODUCTION_ADMIN_TOKEN_MIN) return `${PRODUCTION_ADMIN_TOKEN_MIN}자 이상이어야 합니다`;
  const lower = value.toLowerCase();
  if (WEAK_TOKEN_WORDS.some((w) => lower.includes(w))) return '로컬 기본값·자리표시 낱말이 들어 있습니다';
  if (new Set(value).size < ADMIN_TOKEN_MIN_DISTINCT) return `문자 종류가 단조롭습니다(서로 다른 문자 ${ADMIN_TOKEN_MIN_DISTINCT}종 이상)`;
  return null;
}

/** 운영 모드 전용 — 관리자 토큰 강도·모의 결제 금지 */
function productionSecretErrors(env) {
  const errors = [];
  const weakness = adminTokenWeakness(env.ADMIN_TOKEN);
  if (weakness) errors.push(`ADMIN_TOKEN 이 약합니다 — 운영 모드에서는 ${weakness}(무작위 값 권장: openssl rand -hex 32).`);
  if (isSalesOpen(env) && readPaymentConfig(env).provider === 'mock') errors.push('운영 모드에서는 모의 결제(PAYMENT_PROVIDER=mock)를 쓸 수 없습니다 — PAYMENT_PROVIDER=toss 와 TOSS_SECRET_KEY 를 넣으세요.');
  return errors;
}

/** 서버 시작 전 점검 → 문제 목록(비었으면 통과). 사업자 정보는 운영 모드에서만, 결제·검수 설정은 늘 점검 */
function checkStartupConfig(env) {
  const production = isProductionMode(env);
  const salesOpen = isSalesOpen(env);
  // 접수 준비 중이면 결제를 쓰지 않으므로 결제 설정은 보지 않는다
  const commonErrors = [...(salesOpen ? checkPaymentConfig(env) : []), ...checkModerationConfig(env, { production })];
  if (!production) return commonErrors;
  const info = readBusinessInfo(env);
  // 사업자 정보 법정 표시는 판매(통신판매)를 할 때의 의무 — 접수 준비 중이면 비어도 띄운다(화면엔 "준비 중")
  const missing = salesOpen ? BUSINESS_FIELDS.filter((f) => f.required && !info[f.key]).map((f) => `${f.env} 환경변수가 필요합니다(사업자 정보 법정 표시).`) : [];
  return [...missing, ...formatErrors(env, info), ...productionSecretErrors(env), ...commonErrors];
}

/** GET /api/business 응답 — 필수 값이 다 있어야 ready */
function publicBusinessInfo(info) {
  const safe = info || readBusinessInfo({});
  const ready = BUSINESS_FIELDS.every((f) => !f.required || Boolean(safe[f.key]));
  return { ready, ...Object.fromEntries(BUSINESS_FIELDS.map((f) => [f.key, safe[f.key] || ''])) };
}

module.exports = { BUSINESS_FIELDS, PRODUCTION_ADMIN_TOKEN_MIN, adminTokenWeakness, isProductionMode, isSalesOpen, readBusinessInfo, checkStartupConfig, publicBusinessInfo };
