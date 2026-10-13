// 사업자 정보(법정 표시) — 환경변수 읽기, 운영 모드 시작 거부, GET /api/business.
//   운영 모드 = NODE_ENV=production. 이때 필수 값이 비거나 FREE_MODE·DEV_DEPOSIT이 켜져 있으면 서버가 뜨지 않는다.
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
  const errors = B.checkStartupConfig({ ...FULL_ENV, NODE_ENV: 'production', BIZ_REG_NO: '', BIZ_EMAIL: ' ' });
  assert.ok(errors.some((e) => e.includes('BIZ_REG_NO')));
  assert.ok(errors.some((e) => e.includes('BIZ_EMAIL')));
  assert.deepEqual(B.checkStartupConfig({ ...FULL_ENV, NODE_ENV: 'production' }), []);
});

test('checkStartupConfig: 통신판매업 신고번호는 신고 전이라 비어도 운영 시작 가능(PG 심사용 사이트가 먼저 떠야 함)', () => {
  assert.deepEqual(B.checkStartupConfig({ ...FULL_ENV, NODE_ENV: 'production', BIZ_MAIL_ORDER_NO: '' }), []);
});

test('checkStartupConfig: 운영 모드에서 형식이 틀린 등록번호·이메일, 켜진 FREE_MODE·DEV_DEPOSIT 거부', () => {
  const prod = { ...FULL_ENV, NODE_ENV: 'production' };
  assert.ok(B.checkStartupConfig({ ...prod, BIZ_REG_NO: '12-34' }).some((e) => e.includes('BIZ_REG_NO')));
  assert.ok(B.checkStartupConfig({ ...prod, BIZ_EMAIL: 'not-mail' }).some((e) => e.includes('BIZ_EMAIL')));
  assert.ok(B.checkStartupConfig({ ...prod, FREE_MODE: '1' }).some((e) => e.includes('FREE_MODE')));
  assert.ok(B.checkStartupConfig({ ...prod, DEV_DEPOSIT: '1' }).some((e) => e.includes('DEV_DEPOSIT')));
});

test('checkStartupConfig: 운영 모드에서 PAYMENT_PROVIDER=toss 인데 TOSS_SECRET_KEY 가 없으면 거부', () => {
  const prod = { ...FULL_ENV, NODE_ENV: 'production' };
  assert.ok(B.checkStartupConfig({ ...prod, PAYMENT_PROVIDER: 'toss' }).some((e) => e.includes('TOSS_SECRET_KEY')));
  assert.ok(B.checkStartupConfig({ ...prod, PAYMENT_PROVIDER: 'nope' }).some((e) => e.includes('PAYMENT_PROVIDER')));
  assert.deepEqual(B.checkStartupConfig({ ...prod, PAYMENT_PROVIDER: 'toss', TOSS_SECRET_KEY: 'live_sk_fake' }), []);
});

test('publicBusinessInfo: 필수 값이 다 있어야 ready, 비면 ready=false', () => {
  assert.equal(B.publicBusinessInfo(B.readBusinessInfo(FULL_ENV)).ready, true);
  assert.equal(B.publicBusinessInfo(B.readBusinessInfo({ ...FULL_ENV, BIZ_MAIL_ORDER_NO: '' })).ready, true);
  assert.equal(B.publicBusinessInfo(B.readBusinessInfo({})).ready, false);
  assert.equal(B.publicBusinessInfo(undefined).ready, false);
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
  for (const k of ['NODE_ENV', 'FREE_MODE', 'DEV_DEPOSIT', 'PAYMENT_PROVIDER', 'TOSS_SECRET_KEY', 'TOSS_VA_BANK', ...Object.keys(FULL_ENV)]) if (!(k in env)) delete childEnv[k];
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
  const r = await runEntry({ NODE_ENV: 'production', ...FULL_ENV });
  assert.equal(r.started, true, r.output);
});

test('[진입점] 로컬 테스트 모드(start-test.cmd 와 같은 FREE_MODE=1)는 사업자 정보 없이도 시작된다', async () => {
  const r = await runEntry({ FREE_MODE: '1', MODERATION_MODE: 'auto-approve' });
  assert.equal(r.started, true, r.output);
});

test('[진입점] 운영 모드에서 PAYMENT_PROVIDER=toss 인데 TOSS_SECRET_KEY 가 없으면 시작을 거부한다', async () => {
  const r = await runEntry({ NODE_ENV: 'production', ...FULL_ENV, PAYMENT_PROVIDER: 'toss' });
  assert.equal(r.started, false, r.output);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /TOSS_SECRET_KEY/);
});

test('[진입점] 운영 모드 + 토스 키가 있으면 시작된다(시작 시 PG 호출 없음, WEBHOOK_SECRET 불필요)', async () => {
  const r = await runEntry({ NODE_ENV: 'production', ...FULL_ENV, PAYMENT_PROVIDER: 'toss', TOSS_SECRET_KEY: 'test_sk_fakeKeyForEntryTest0000', WEBHOOK_SECRET: '' });
  assert.equal(r.started, true, r.output);
  assert.match(r.output, /결제=toss/);
});
