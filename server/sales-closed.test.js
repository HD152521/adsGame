// 광고 접수 준비 중(SALES_OPEN=0) — 사업자 등록·PG 심사 전에 게임만 운영 모드로 여는 길.
//   돈을 받지 않으므로 사업자 정보·결제 키 없이 뜨고, 주문·칸 추가·결제 웹훅은 503 으로 닫는다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const B = require('./business.js');
const { createApp } = require('./app.js');

const PROD_ADMIN_TOKEN = '9f3c1a7e5b2d8046c4e1f0a93b7d6e2c';
// fly.toml 그대로(NODE_ENV·PAYMENT_PROVIDER=toss·SALES_OPEN=0) + 관리자 토큰만 — 사업자 정보·토스 키 없음
const CLOSED_PROD = { NODE_ENV: 'production', PAYMENT_PROVIDER: 'toss', SALES_OPEN: '0', HOSTING_PROVIDER: 'Fly.io', ADMIN_TOKEN: PROD_ADMIN_TOKEN };

test('isSalesOpen: 기본은 열림, SALES_OPEN=0 일 때만 준비 중', () => {
  assert.equal(B.isSalesOpen({}), true);
  assert.equal(B.isSalesOpen({ SALES_OPEN: '1' }), true);
  assert.equal(B.isSalesOpen({ SALES_OPEN: ' 0 ' }), false);
});

test('checkStartupConfig: 접수 준비 중이면 사업자 정보·결제 키 없이 운영 모드 통과', () => {
  assert.deepEqual(B.checkStartupConfig(CLOSED_PROD), []);
  // 접수를 열면 다시 사업자 정보·토스 키를 요구한다
  const opened = B.checkStartupConfig({ ...CLOSED_PROD, SALES_OPEN: '1' });
  assert.ok(opened.some((e) => e.includes('BIZ_NAME')));
  assert.ok(opened.some((e) => e.includes('TOSS_SECRET_KEY')));
});

test('checkStartupConfig: 접수 준비 중이어도 관리자 토큰 강도·공짜 스위치·전부 승인은 그대로 막는다', () => {
  assert.ok(B.checkStartupConfig({ ...CLOSED_PROD, ADMIN_TOKEN: 'short' }).some((e) => e.includes('ADMIN_TOKEN')));
  assert.ok(B.checkStartupConfig({ ...CLOSED_PROD, FREE_MODE: '1' }).some((e) => e.includes('FREE_MODE')));
  assert.ok(B.checkStartupConfig({ ...CLOSED_PROD, MODERATION_MODE: 'auto-approve' }).length > 0);
});

test('[HTTP] 접수 준비 중: 주문·칸 추가·웹훅 503, 게임(장부·설정·헬스)은 열림', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-closed-'));
  const app = createApp({ dataDir, adminToken: PROD_ADMIN_TOKEN, webhookSecret: 'x'.repeat(32), salesOpen: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.salesOpen, false);
    assert.equal((await fetch(`${base}/api/ledger`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    for (const p of ['/api/orders', '/api/orders/abcdef123456/topup', '/api/payments/webhook']) {
      const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 503, p);
      assert.match((await res.json()).error, /접수 준비 중/);
    }
  } finally {
    app.close ? await app.close() : app.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('[진입점] fly.toml 설정 + 관리자 토큰만으로 운영 모드 서버가 뜬다(사업자 정보·토스 키 없음)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-closed-entry-'));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...CLOSED_PROD, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir };
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`시작 안 됨:\n${out}`)), 10_000);
      const onData = (d) => {
        out += d;
        const m = out.match(/\[server\] http:\/\/\S+:(\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`종료(${code}):\n${out}`)); });
    });
    assert.match(out, /광고접수=준비 중/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/orders`, { method: 'POST', body: '{}' })).status, 503);
  } finally {
    child.removeAllListeners('exit');
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
