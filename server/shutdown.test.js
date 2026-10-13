// 종료 시그널(SIGTERM·SIGINT) — 배포·재시작 때 호스팅이 SIGTERM 을 보낸다.
//   lazy 로 모아 두던 놀이 기록(판 기록)을 디스크에 쓴 뒤 종료 코드 0 으로 끝나야 한다.
//   Windows 는 다른 프로세스에 SIGTERM 핸들러를 부를 수 없어서(강제 종료됨) 가짜 process 로 확인하고,
//   POSIX(리눅스 컨테이너·CI)에서는 실제 진입점에 진짜 SIGTERM 을 보내 확인한다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const { createApp } = require('./app.js');
const { installShutdown } = require('./shutdown.js');
const M = require('./moderation.js');

const dbOf = (dataDir) => path.join(dataDir, 'db.json');
const runsOnDisk = (dataDir) => {
  if (!fs.existsSync(dbOf(dataDir))) return 0;
  const runs = JSON.parse(fs.readFileSync(dbOf(dataDir), 'utf8')).runs || {};
  return Object.values(runs).reduce((sum, d) => sum + d.total, 0);
};
const silent = { info() {}, warn() {}, error() {} };

function fakeProcess() {
  const proc = new EventEmitter();
  proc.exitCodes = [];
  proc.exit = (code) => proc.exitCodes.push(code);
  return proc;
}

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-shutdown-'));
  const app = createApp({ dataDir, adminToken: 'shutdown-test-admin', webhookSecret: 'whsec', classifier: M.reviewAllClassifier() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, dataDir, base: `http://127.0.0.1:${app.server.address().port}` };
}

const postRun = (base) => fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: 12.3 }) });

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal}: 밀린 lazy 판 기록을 디스크에 쓰고 코드 0 으로 종료`, async () => {
    const { app, dataDir, base } = await startApp();
    const proc = fakeProcess();
    installShutdown({ app, proc, logger: silent });
    assert.equal((await postRun(base)).status, 200);
    assert.equal(runsOnDisk(dataDir), 0, '아직 모아 두는 중(lazy) — 디스크에 없음');

    proc.emit(signal);

    assert.equal(runsOnDisk(dataDir), 1, '종료 직전에 flush 됨');
    assert.deepEqual(proc.exitCodes, [0]);
  });
}

test('시그널이 두 번 와도 한 번만 정리한다', async () => {
  const { app } = await startApp();
  const proc = fakeProcess();
  let closes = 0;
  installShutdown({ app: { close: () => { closes += 1; app.close(); } }, proc, logger: silent });
  proc.emit('SIGTERM');
  proc.emit('SIGINT');
  assert.equal(closes, 1);
  assert.deepEqual(proc.exitCodes, [0]);
});

test('정리 중 쓰기가 실패하면 코드 1 로 종료(실패를 숨기지 않는다)', () => {
  const proc = fakeProcess();
  const errors = [];
  installShutdown({ app: { close: () => { throw new Error('disk full'); } }, proc, logger: { ...silent, error: (...a) => errors.push(a.join(' ')) } });
  proc.emit('SIGTERM');
  assert.deepEqual(proc.exitCodes, [1]);
  assert.ok(errors.some((e) => e.includes('disk full')));
});

// ── 실제 진입점 + 진짜 SIGTERM (POSIX 전용) ───────────────────────────────────
test('[진입점] SIGTERM 을 받으면 lazy 판 기록을 flush 하고 코드 0 으로 끝난다', { skip: process.platform === 'win32' && 'Windows 는 SIGTERM 핸들러를 외부에서 부를 수 없음(위 가짜 process 테스트로 대신 확인)' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-sigterm-'));
  const env = { PATH: process.env.PATH, ADMIN_TOKEN: 'local-admin-token-1234', WEBHOOK_SECRET: 'local-webhook-secret-1234', PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir };
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`시작 안 됨: ${output}`)), 15000);
    const onData = (chunk) => {
      output += chunk;
      const m = /\[server\] http:\/\/[^:\s]+:(\d+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
  assert.equal((await postRun(`http://127.0.0.1:${port}`)).status, 200);
  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 0, output);
  assert.equal(runsOnDisk(dataDir), 1);
});
