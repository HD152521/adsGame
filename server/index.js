// 서버 진입점 — 환경변수를 읽어 검증하고 띄운다.
//   실행: apps/ad-dodge 안에서 node server/index.js  (또는 npm 없이 README의 예시)
//
//   PORT              기본 5173
//   HOST              기본 0.0.0.0 (FREE_MODE·DEV_DEPOSIT 이면 늘 127.0.0.1)
//   DATA_DIR          기본 ./data (db.json + uploads/) — git에 올리지 않는다
//   ADMIN_TOKEN       관리자 페이지 토큰(필수, 16자 이상)
//   PAYMENT_PROVIDER  mock(기본) | toss — 결제 제공자(server/payments.js)
//   WEBHOOK_SECRET    모의 PG 웹훅 서명 비밀값(PAYMENT_PROVIDER=mock 일 때 필수)
//   TOSS_SECRET_KEY   토스페이먼츠 시크릿 키 test_sk_… / live_sk_… (PAYMENT_PROVIDER=toss 일 때 필수)
//   TOSS_VA_BANK      가상계좌 은행 코드(선택, 기본 20 우리은행)
//   FREE_MODE=1       테스트 모드: 결제 없이 주문 즉시 출연(로컬 기능 테스트 전용)
//   DEV_DEPOSIT=1     "입금 시뮬레이션" 버튼·엔드포인트 켜기(로컬 전용 — 운영에서 켜면 공짜 광고가 된다)
//   MODERATION_MODE   review-all(기본) | vision(Google Vision SafeSearch + 얼굴 감지) | auto-approve(로컬 데모 전용 — 운영 모드 금지)
//   GOOGLE_VISION_API_KEY  Google Cloud Vision API 키(MODERATION_MODE=vision 일 때 필수, 로그에 찍지 않는다)
//   TRUST_PROXY=1     리버스 프록시 뒤에서 X-Forwarded-For로 IP 판별
//   NODE_ENV=production  운영 모드 — 사업자 정보(BIZ_*·HOSTING_PROVIDER) 필수, FREE_MODE·DEV_DEPOSIT 금지(server/business.js)
//   BIZ_NAME · BIZ_OWNER · BIZ_REG_NO · BIZ_ADDRESS · BIZ_PHONE · BIZ_EMAIL · BIZ_MAIL_ORDER_NO · HOSTING_PROVIDER
//                     사업자 정보 — 시작 화면·신청서·약관·개인정보처리방침 하단에 표시

const path = require('node:path');
const { createApp } = require('./app.js');
const { startBackups } = require('./backup.js');
const M = require('./moderation.js');
const { checkStartupConfig, readBusinessInfo, isProductionMode } = require('./business.js');
const { readPaymentConfig } = require('./payments.js');

const MIN_SECRET_LENGTH = 16;

function requireSecret(name) {
  const value = process.env[name];
  if (!value || value.length < MIN_SECRET_LENGTH) {
    console.error(`[config] ${name} 환경변수가 필요합니다(${MIN_SECRET_LENGTH}자 이상).`);
    process.exit(1);
  }
  return value;
}

// 운영 모드에서 법정 표시(사업자 정보)가 빠졌거나 공짜 광고 스위치가 켜져 있으면 아예 띄우지 않는다.
// 결제 설정(PAYMENT_PROVIDER=toss 인데 키 없음 등)이 틀려도 띄우지 않는다.
const startupErrors = checkStartupConfig(process.env);
if (startupErrors.length > 0) {
  for (const msg of startupErrors) console.error(`[config] ${msg}`);
  console.error('[config] 설정이 맞지 않아 서버를 시작하지 않습니다. README의 환경변수 표를 확인하세요.');
  process.exit(1);
}
const payment = readPaymentConfig(process.env);
if (isProductionMode(process.env) && payment.provider === 'mock') console.warn('[config] ⚠ 운영 모드인데 PAYMENT_PROVIDER=mock — 실제 입금을 받을 수 없습니다.');
if (payment.provider === 'toss' && payment.tossSecretKey.startsWith('test_')) console.warn('[config] 토스 테스트 키(test_sk_) — 실제 돈은 오가지 않습니다.');

const port = Number(process.env.PORT || 5173);
const devMode = process.env.DEV_DEPOSIT === '1';
const freeMode = process.env.FREE_MODE === '1';
const moderationMode = M.readModerationMode(process.env);

// 모의 입금이 켜져 있으면 주문번호만 알면 누구나 공짜로 출연시킬 수 있다(보안 리뷰 M2) —
// 이 컴퓨터 밖에서 접속할 수 없게 루프백에만 묶는다.
const host = devMode || freeMode ? '127.0.0.1' : process.env.HOST || '0.0.0.0';
if (freeMode) console.warn('[config] ⚠ FREE_MODE=1 — 결제 없이 광고가 바로 추가됩니다(테스트 모드). 127.0.0.1 에만 엽니다.');
if (devMode) console.warn('[config] ⚠ DEV_DEPOSIT=1 — 모의 입금이 켜져 있습니다. 127.0.0.1 에만 열고, 운영에서는 절대 켜지 마세요.');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const app = createApp({
  dataDir,
  adminToken: requireSecret('ADMIN_TOKEN'),
  webhookSecret: payment.provider === 'mock' ? requireSecret('WEBHOOK_SECRET') : undefined,
  payment,
  devMode,
  freeMode,
  classifier: M.createClassifier(process.env),
  trustProxy: process.env.TRUST_PROXY === '1',
  business: readBusinessInfo(process.env),
});

startBackups({ dataDir }); // 1시간마다 data/backups/ 에 장부 사본(이틀치 보관)

app.server.listen(port, host, () => {
  console.info(`[server] http://${devMode || freeMode ? "127.0.0.1" : "localhost"}:${port}  (운영모드=${isProductionMode(process.env) ? '켜짐' : '꺼짐'}, 테스트모드=${freeMode ? '켜짐' : '꺼짐'}, 결제=${payment.provider}, 모의입금=${devMode && payment.provider === 'mock' ? '켜짐' : '꺼짐'}, 검수=${moderationMode})`);
  console.info(`[server] 관리자: /admin.html`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.close(); // 밀린 놀이 기록(lazy)도 여기서 디스크에 쓴다
    process.exit(0);
  });
}
