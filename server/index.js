// 서버 진입점 — 환경변수를 읽어 검증하고 띄운다.
//   실행: apps/ad-dodge 안에서 node server/index.js  (또는 npm 없이 README의 예시)
//
//   PORT              기본 5173
//   DATA_DIR          기본 ./data (db.json + uploads/) — git에 올리지 않는다
//   ADMIN_TOKEN       관리자 페이지 토큰(필수, 16자 이상)
//   WEBHOOK_SECRET    모의 PG 웹훅 서명 비밀값(필수)
//   FREE_MODE=1       테스트 모드: 결제 없이 주문 즉시 출연(로컬 기능 테스트 전용)
//   DEV_DEPOSIT=1     "입금 시뮬레이션" 버튼·엔드포인트 켜기(로컬 전용 — 운영에서 켜면 공짜 광고가 된다)
//   MODERATION_MODE   review-all(기본) | auto-approve(로컬 데모 전용)
//   TRUST_PROXY=1     리버스 프록시 뒤에서 X-Forwarded-For로 IP 판별

const path = require('node:path');
const { createApp } = require('./app.js');
const M = require('./moderation.js');

const MIN_SECRET_LENGTH = 16;

function requireSecret(name) {
  const value = process.env[name];
  if (!value || value.length < MIN_SECRET_LENGTH) {
    console.error(`[config] ${name} 환경변수가 필요합니다(${MIN_SECRET_LENGTH}자 이상).`);
    process.exit(1);
  }
  return value;
}

const port = Number(process.env.PORT || 5173);
const devMode = process.env.DEV_DEPOSIT === '1';
const freeMode = process.env.FREE_MODE === '1';
const moderationMode = process.env.MODERATION_MODE || 'review-all';

// 모의 입금이 켜져 있으면 주문번호만 알면 누구나 공짜로 출연시킬 수 있다(보안 리뷰 M2) —
// 이 컴퓨터 밖에서 접속할 수 없게 루프백에만 묶는다.
const host = devMode || freeMode ? '127.0.0.1' : '0.0.0.0';
if (freeMode) console.warn('[config] ⚠ FREE_MODE=1 — 결제 없이 광고가 바로 추가됩니다(테스트 모드). 127.0.0.1 에만 엽니다.');
if (devMode) console.warn('[config] ⚠ DEV_DEPOSIT=1 — 모의 입금이 켜져 있습니다. 127.0.0.1 에만 열고, 운영에서는 절대 켜지 마세요.');

const app = createApp({
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  adminToken: requireSecret('ADMIN_TOKEN'),
  webhookSecret: requireSecret('WEBHOOK_SECRET'),
  devMode,
  freeMode,
  classifier: moderationMode === 'auto-approve' ? M.autoApproveClassifier() : M.reviewAllClassifier(),
  trustProxy: process.env.TRUST_PROXY === '1',
});

app.server.listen(port, host, () => {
  console.info(`[server] http://${devMode || freeMode ? "127.0.0.1" : "localhost"}:${port}  (테스트모드=${freeMode ? '켜짐' : '꺼짐'}, 모의입금=${devMode ? '켜짐' : '꺼짐'}, 검수=${moderationMode})`);
  console.info(`[server] 관리자: /admin.html`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.close();
    process.exit(0);
  });
}
