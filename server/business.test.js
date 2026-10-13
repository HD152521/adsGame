// 사업자 정보(법정 표시) — 환경변수 읽기, 운영 모드 시작 거부, GET /api/business.
//   운영 모드 = NODE_ENV=production. 이때 필수 값이 비거나 FREE_MODE·DEV_DEPOSIT이 켜져 있거나,
//   관리자 토큰이 32자 미만이거나 모의 결제(PAYMENT_PROVIDER=mock)면 서버가 뜨지 않는다.
//   실제 서버 진입점(server/index.js)을 자식 프로세스로 띄워 "시작 거부/시작됨"을 확인한다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const B = require('./business.js');
const { createApp } = require('./app.js');
const M = require('./moderation.js');

const FULL_ENV = {
  BIZ_NAME: '주간실험실',
  BIZ_OWNER: '홍길동',
  BIZ_REG_NO: '123-45-67890',
  BIZ_ADDRESS: '서울특별시 어딘가 1',
  BIZ_PHONE: '02-000-0000',
  BIZ_EMAIL: 'help@example.com',
  BIZ_MAIL_ORDER_NO: '제2026-서울어딘가-0000호',
  HOSTING_PROVIDER: 'Fly.io',
};

// 운영 모드로 뜰 수 있는 최소 설정 — 사업자 정보 + 32자 이상 관리자 토큰 + 실제 PG(토스). 모의 결제는 운영 금지
const PROD_ADMIN_TOKEN = '9f3c1a7e5b2d8046c4e1f0a93b7d6e2c'; // 32자 무작위(openssl rand -hex 16 모양)
const PROD_READY = { ...FULL_ENV, NODE_ENV: 'production', ADMIN_TOKEN: PROD_ADMIN_TOKEN, PAYMENT_PROVIDER: 'toss', TOSS_SECRET_KEY: 'live_sk_fakeKeyForStartupTest00' };

test('readBusinessInfo: 환경변수 8개를 앞뒤 공백 없이 읽는다(없으면 빈 문자열)', () => {
  const info = B.readBusinessInfo({ ...FULL_ENV, BIZ_NAME: '  주간실험실  ' });
  assert.equal(info.name, '주간실험실');
  assert.equal(info.regNo, '123-45-67890');
  assert.equal(info.hostingProvider, 'Fly.io');
  assert.equal(B.readBusinessInfo({}).email, '');
  assert.deepEqual(Object.keys(B.readBusinessInfo({})).sort(), ['address', 'email', 'hostingProvider', 'mailOrderNo', 'name', 'owner', 'phone', 'regNo']);
});

test('isProductionMode: NODE_ENV=production 일 때만 운영 모드', () => {
  assert.equal(B.isProductionMode({ NODE_ENV: 'production' }), true);
  assert.equal(B.isProductionMode({}), false);
  assert.equal(B.isProductionMode({ NODE_ENV: 'development', FREE_MODE: '1' }), false);
});

test('checkStartupConfig: 로컬(운영 아님)은 사업자 정보가 비어도 통과', () => {
  assert.deepEqual(B.checkStartupConfig({ FREE_MODE: '1' }), []);
});

test('checkStartupConfig: 운영 모드에서 필수 값이 비면 이름을 짚어 거부', () => {
  const errors = B.checkStartupConfig({ ...PROD_READY, BIZ_REG_NO: '', BIZ_EMAIL: ' ' });
  assert.ok(errors.some((e) => e.includes('BIZ_REG_NO')));
  assert.ok(errors.some((e) => e.includes('BIZ_EMAIL')));
  assert.deepEqual(B.checkStartupConfig({ ...PROD_READY }), []);
});

test('checkStartupConfig: 통신판매업 신고번호는 신고 전이라 비어도 운영 시작 가능(PG 심사용 사이트가 먼저 떠야 함)', () => {
  assert.deepEqual(B.checkStartupConfig({ ...PROD_READY, BIZ_MAIL_ORDER_NO: '' }), []);
});

test('checkStartupConfig: 운영 모드에서 형식이 틀린 등록번호·이메일, 켜진 FREE_MODE·DEV_DEPOSIT 거부', () => {
  const prod = { ...PROD_READY };
  assert.ok(B.checkStartupConfig({ ...prod, BIZ_REG_NO: '12-34' }).some((e) => e.includes('BIZ_REG_NO')));
  assert.ok(B.checkStartupConfig({ ...prod, BIZ_EMAIL: 'not-mail' }).some((e) => e.includes('BIZ_EMAIL')));
  assert.ok(B.checkStartupConfig({ ...prod, FREE_MODE: '1' }).some((e) => e.includes('FREE_MODE')));
  assert.ok(B.checkStartupConfig({ ...prod, DEV_DEPOSIT: '1' }).some((e) => e.includes('DEV_DEPOSIT')));
});

test('checkStartupConfig: 운영 모드에서 PAYMENT_PROVIDER=toss 인데 TOSS_SECRET_KEY 가 없으면 거부', () => {
  const prod = { ...PROD_READY };
  assert.ok(B.checkStartupConfig({ ...prod, PAYMENT_PROVIDER: 'toss', TOSS_SECRET_KEY: '' }).some((e) => e.includes('TOSS_SECRET_KEY')));
  assert.ok(B.checkStartupConfig({ ...prod, PAYMENT_PROVIDER: 'nope' }).some((e) => e.includes('PAYMENT_PROVIDER')));
  assert.deepEqual(B.checkStartupConfig({ ...prod, PAYMENT_PROVIDER: 'toss', TOSS_SECRET_KEY: 'live_sk_fake' }), []);
});

test('publicBusinessInfo: 필수 값이 다 있어야 ready, 비면 ready=false', () => {
  assert.equal(B.publicBusinessInfo(B.readBusinessInfo(FULL_ENV)).ready, true);
  assert.equal(B.publicBusinessInfo(B.readBusinessInfo({ ...FULL_ENV, BIZ_MAIL_ORDER_NO: '' })).ready, true);
  assert.equal(B.publicBusinessInfo(B.readBusinessInfo({})).ready, false);
  assert.equal(B.publicBusinessInfo(undefined).ready, false);
});

test('checkStartupConfig: 운영 모드에서 MODERATION_MODE=vision 인데 GOOGLE_VISION_API_KEY 가 없으면 거부', () => {
  const prod = { ...PROD_READY };
  assert.ok(B.checkStartupConfig({ ...prod, MODERATION_MODE: 'vision' }).some((e) => e.includes('GOOGLE_VISION_API_KEY')));
  assert.deepEqual(B.checkStartupConfig({ ...prod, MODERATION_MODE: 'vision', GOOGLE_VISION_API_KEY: 'AIzaFAKE-entry-key' }), []);
});

test('checkStartupConfig: 운영 모드에서 MODERATION_MODE=auto-approve 는 거부, 로컬에서는 허용', () => {
  assert.ok(B.checkStartupConfig({ ...PROD_READY, MODERATION_MODE: 'auto-approve' }).some((e) => e.includes('auto-approve')));
  assert.deepEqual(B.checkStartupConfig({ MODERATION_MODE: 'auto-approve', FREE_MODE: '1' }), []);
});

async function getBusiness(business) {
  const app = createApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-biz-')),
    adminToken: 'admin-token-for-test',
    webhookSecret: 'whsec',
    classifier: M.reviewAllClassifier(),
    business,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/business`);
    return { status: res.status, body: await res.json() };
  } finally {
    app.close();
  }
}

test('GET /api/business: 서버에 설정된 사업자 정보를 돌려준다', async () => {
  const { status, body } = await getBusiness(B.readBusinessInfo(FULL_ENV));
  assert.equal(status, 200);
  assert.equal(body.ready, true);
  assert.equal(body.name, '주간실험실');
  assert.equal(body.regNo, '123-45-67890');
  assert.equal(body.mailOrderNo, '제2026-서울어딘가-0000호');
});

test('GET /api/business: 설정이 없으면(로컬 테스트 모드) ready=false', async () => {
  const { status, body } = await getBusiness(undefined);
  assert.equal(status, 200);
  assert.equal(body.ready, false);
});

// ── 실제 진입점(server/index.js) 기동 ───────────────────────────────────────────
const ENTRY = path.join(__dirname, 'index.js');
const BASE_ENV = { ADMIN_TOKEN: 'local-admin-token-1234', WEBHOOK_SECRET: 'local-webhook-secret-1234', PORT: '0', HOST: '127.0.0.1' }; // 운영 모드 기동도 루프백에만(테스트 중 방화벽 창 방지)
const START_TIMEOUT_MS = 15000; // 전체 테스트가 병렬로 돌 때 느린 PC에서도 넉넉하게

/** 진입점을 띄워 { started, code, output } — "[server]" 로그가 나오면 시작된 것으로 보고 끈다 */
function runEntry(env) {
  const childEnv = { ...process.env, ...BASE_ENV, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-entry-')), ...env };
  for (const k of ['NODE_ENV', 'FREE_MODE', 'DEV_DEPOSIT', 'PAYMENT_PROVIDER', 'TOSS_SECRET_KEY', 'TOSS_VA_BANK', 'MODERATION_MODE', 'GOOGLE_VISION_API_KEY', ...Object.keys(FULL_ENV)]) if (!(k in env)) delete childEnv[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let started = false;
    const timer = setTimeout(() => child.kill(), START_TIMEOUT_MS);
    const onData = (chunk) => {
      output += chunk;
      if (!started && output.includes('[server] http://')) {
        started = true;
        child.kill();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ started, code, output });
    });
  });
}

test('[진입점] 운영 모드(NODE_ENV=production)에서 사업자 정보가 비면 시작을 거부한다', async () => {
  const r = await runEntry({ NODE_ENV: 'production' });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /BIZ_NAME/);
});

test('[진입점] 운영 모드에서 사업자 정보가 다 있으면 시작된다', async () => {
  const r = await runEntry({ ...PROD_READY });
  assert.equal(r.started, true, r.output);
});

test('[진입점] 로컬 테스트 모드(start-test.cmd 와 같은 FREE_MODE=1)는 사업자 정보 없이도 시작된다', async () => {
  const r = await runEntry({ FREE_MODE: '1', MODERATION_MODE: 'auto-approve' });
  assert.equal(r.started, true, r.output);
});

test('[진입점] 운영 모드에서 PAYMENT_PROVIDER=toss 인데 TOSS_SECRET_KEY 가 없으면 시작을 거부한다', async () => {
  const r = await runEntry({ ...PROD_READY, PAYMENT_PROVIDER: 'toss', TOSS_SECRET_KEY: '' });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /TOSS_SECRET_KEY/);
});

test('[진입점] 운영 모드 + 토스 키가 있으면 시작된다(시작 시 PG 호출 없음, WEBHOOK_SECRET 불필요)', async () => {
  const r = await runEntry({ ...PROD_READY, PAYMENT_PROVIDER: 'toss', TOSS_SECRET_KEY: 'test_sk_fakeKeyForEntryTest0000', WEBHOOK_SECRET: '' });
  assert.equal(r.started, true, r.output);
  assert.match(r.output, /결제=toss/);
});

test('[진입점] 운영 모드에서 MODERATION_MODE=vision 인데 GOOGLE_VISION_API_KEY 가 없으면 시작을 거부한다', async () => {
  const r = await runEntry({ ...PROD_READY, MODERATION_MODE: 'vision' });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /GOOGLE_VISION_API_KEY/);
});

test('[진입점] 운영 모드에서 MODERATION_MODE=auto-approve 면 시작을 거부한다', async () => {
  const r = await runEntry({ ...PROD_READY, MODERATION_MODE: 'auto-approve' });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /auto-approve/);
});

test('[진입점] 운영 모드 + vision 키가 있으면 시작된다(시작 시 Vision 호출 없음, 키는 로그에 안 나옴)', async () => {
  const key = 'AIzaFAKE-entry-key-should-not-leak';
  const r = await runEntry({ ...PROD_READY, MODERATION_MODE: 'vision', GOOGLE_VISION_API_KEY: key });
  assert.equal(r.started, true, r.output);
  assert.match(r.output, /검수=vision/);
  assert.ok(!r.output.includes(key));
});

// ── Step 4: 운영 필수 비밀값·결제 설정 ─────────────────────────────────────────
test('checkStartupConfig: 운영 모드에서 ADMIN_TOKEN 이 32자 미만이면 거부(값은 메시지에 안 나옴)', () => {
  const short = 'short-admin-token-31-characters';
  assert.equal(short.length, 31);
  const errors = B.checkStartupConfig({ ...PROD_READY, ADMIN_TOKEN: short });
  assert.ok(errors.some((e) => e.includes('ADMIN_TOKEN') && e.includes('32')), errors.join(' / '));
  assert.ok(errors.every((e) => !e.includes(short)));
  assert.ok(B.checkStartupConfig({ ...PROD_READY, ADMIN_TOKEN: '' }).some((e) => e.includes('ADMIN_TOKEN')));
  assert.deepEqual(B.checkStartupConfig({ ...PROD_READY, ADMIN_TOKEN: PROD_ADMIN_TOKEN }), []);
});

test('checkStartupConfig: 로컬은 ADMIN_TOKEN 32자 규칙을 적용하지 않는다(16자 규칙은 진입점에서)', () => {
  assert.deepEqual(B.checkStartupConfig({ ADMIN_TOKEN: 'local-admin-token-1234' }), []);
});

test('checkStartupConfig: 운영 모드에서 모의 결제(PAYMENT_PROVIDER 없음·mock)는 거부', () => {
  const { PAYMENT_PROVIDER, TOSS_SECRET_KEY, ...noProvider } = PROD_READY;
  assert.ok(B.checkStartupConfig(noProvider).some((e) => e.includes('mock')));
  assert.ok(B.checkStartupConfig({ ...PROD_READY, PAYMENT_PROVIDER: 'mock', WEBHOOK_SECRET: 'w'.repeat(32) }).some((e) => e.includes('mock')));
  assert.deepEqual(B.checkStartupConfig({ PAYMENT_PROVIDER: 'mock' }), [], '로컬은 모의 결제 허용');
});

test('[진입점] 운영 모드에서 DEV_DEPOSIT=1 이면 시작을 거부한다', async () => {
  const r = await runEntry({ ...PROD_READY, DEV_DEPOSIT: '1' });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /DEV_DEPOSIT/);
});

test('[진입점] 운영 모드에서 FREE_MODE=1 이면 시작을 거부한다', async () => {
  const r = await runEntry({ ...PROD_READY, FREE_MODE: '1' });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /FREE_MODE/);
});

test('[진입점] 운영 모드에서 모의 결제(PAYMENT_PROVIDER=mock)면 시작을 거부한다', async () => {
  const r = await runEntry({ ...PROD_READY, PAYMENT_PROVIDER: 'mock', TOSS_SECRET_KEY: '', WEBHOOK_SECRET: 'local-webhook-secret-1234' });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /mock/);
});

test('[진입점] 운영 모드에서 ADMIN_TOKEN 이 32자 미만이면 시작을 거부한다(토큰 값은 로그에 안 나옴)', async () => {
  const short = 'local-admin-token-1234';
  const r = await runEntry({ ...PROD_READY, ADMIN_TOKEN: short });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /ADMIN_TOKEN/);
  assert.ok(!r.output.includes(short));
});

// ── Step 6: 관리자 토큰 강도 ─────────────────────────────────────────────────
test('adminTokenWeakness: 32자 이상이어도 같은 문자 반복·문자 종류가 적거나 로컬 기본값이면 약하다', () => {
  assert.match(B.adminTokenWeakness('x'.repeat(40)), /단조/);
  assert.match(B.adminTokenWeakness('abab'.repeat(10)), /단조/);
  assert.match(B.adminTokenWeakness('0123012301230123012301230123012301'), /단조/);
  assert.match(B.adminTokenWeakness('local-admin-token-1234-local-admin-token'), /기본값/);
  assert.match(B.adminTokenWeakness('CHANGEME-please-9f3c1a7e5b2d8046c4e1'), /기본값/);
  assert.match(B.adminTokenWeakness('short'), /32/);
  assert.equal(B.adminTokenWeakness(PROD_ADMIN_TOKEN), null);
  assert.equal(B.adminTokenWeakness('b5d0Qz-7Lw_Kp3Rx9Vt2Yh8Nc4Mj6Fg1'), null);
});

test('checkStartupConfig: 운영 모드에서 약한 ADMIN_TOKEN(반복·로컬 기본값)은 거부, 메시지에 값은 없음', () => {
  for (const weak of ['x'.repeat(32), 'local-admin-token-1234-local-admin-token']) {
    const errors = B.checkStartupConfig({ ...PROD_READY, ADMIN_TOKEN: weak });
    assert.ok(errors.some((e) => e.includes('ADMIN_TOKEN')), weak);
    assert.ok(errors.every((e) => !e.includes(weak)));
  }
  assert.deepEqual(B.checkStartupConfig({ ADMIN_TOKEN: 'x'.repeat(32), FREE_MODE: '1' }), [], '로컬은 강도 규칙 없음');
});

test('[진입점] 운영 모드에서 ADMIN_TOKEN 이 같은 문자 반복이면 시작을 거부한다(로그에 값 없음)', async () => {
  const weak = 'a'.repeat(48);
  const r = await runEntry({ ...PROD_READY, ADMIN_TOKEN: weak });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /ADMIN_TOKEN/);
  assert.ok(!r.output.includes(weak));
});
