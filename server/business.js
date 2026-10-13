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

const { checkPaymentConfig } = require('./payments.js');
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

function isProductionMode(env) {
  return env.NODE_ENV === 'production';
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

/** 서버 시작 전 점검 → 문제 목록(비었으면 통과). 사업자 정보는 운영 모드에서만, 결제·검수 설정은 늘 점검 */
function checkStartupConfig(env) {
  const production = isProductionMode(env);
  const commonErrors = [...checkPaymentConfig(env), ...checkModerationConfig(env, { production })];
  if (!production) return commonErrors;
  const info = readBusinessInfo(env);
  const missing = BUSINESS_FIELDS.filter((f) => f.required && !info[f.key]).map((f) => `${f.env} 환경변수가 필요합니다(사업자 정보 법정 표시).`);
  return [...missing, ...formatErrors(env, info), ...commonErrors];
}

/** GET /api/business 응답 — 필수 값이 다 있어야 ready */
function publicBusinessInfo(info) {
  const safe = info || readBusinessInfo({});
  const ready = BUSINESS_FIELDS.every((f) => !f.required || Boolean(safe[f.key]));
  return { ready, ...Object.fromEntries(BUSINESS_FIELDS.map((f) => [f.key, safe[f.key] || ''])) };
}

module.exports = { BUSINESS_FIELDS, isProductionMode, readBusinessInfo, checkStartupConfig, publicBusinessInfo };
