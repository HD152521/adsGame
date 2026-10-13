// E2E 준비물(계획서 Step 7) — 임시 폴더·테스트 서버(자식 프로세스)·업로드용 로고 PNG.
//   서버는 운영체제 임시 폴더의 data 로만 띄운다(저장소 data/ 를 건드리지 않음).
//   테스트 모드(FREE_MODE=1: 결제 없이 바로 출연, 127.0.0.1 전용) + MODERATION_MODE=auto-approve(로컬 데모 검수),
//   PORT=0(운영체제가 고른 빈 포트). 운영·결제·외부 백업 환경변수는 물려주지 않는다.
//   실행 검증: apps/ad-dodge 안에서 node --test (e2e/e2e-support.test.js)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const APP_ROOT = path.join(__dirname, '..');
const SERVER_START_TIMEOUT_MS = 15_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;
const REMOVE_RETRY_MS = 20_000;
const REMOVE_RETRY_GAP_MS = 500;
// 부모 셸에서 물려받으면 안 되는 값 — 운영 모드·실제 결제·외부 백업·이미지 검수 키·프록시·호스트·포트·데이터 폴더
const BLOCKED_ENV = /^(NODE_ENV|PAYMENT_PROVIDER|TOSS_.*|DEV_DEPOSIT|FREE_MODE|MODERATION_MODE|GOOGLE_VISION_API_KEY|BACKUP_S3_.*|BIZ_.*|HOSTING_PROVIDER|TRUST_PROXY|HOST|PORT|DATA_DIR|ADMIN_TOKEN|WEBHOOK_SECRET)$/;

/** 테스트 서버 환경변수 — 부모 환경에서 위험한 값을 빼고 테스트 모드 값만 넣는다 */
function buildServerEnv(baseEnv, { dataDir, adminToken }) {
  const kept = Object.fromEntries(Object.entries(baseEnv).filter(([key]) => !BLOCKED_ENV.test(key.toUpperCase())));
  return {
    ...kept,
    FREE_MODE: '1',
    MODERATION_MODE: 'auto-approve',
    DATA_DIR: dataDir,
    PORT: '0',
    ADMIN_TOKEN: adminToken,
    WEBHOOK_SECRET: `e2e-webhook-${crypto.randomBytes(8).toString('hex')}`,
  };
}

/** 서버 시작 줄 "[server] http://127.0.0.1:54321 (…" → 54321 | null */
function parseServerPort(line) {
  const m = /^\[server\] http:\/\/127\.0\.0\.1:(\d+)\b/m.exec(String(line));
  return m ? Number(m[1]) : null;
}

/** 운영체제 임시 폴더 아래 E2E 전용 폴더들 → { root, dataDir, profileDir, downloadDir, remove(), removeEventually() } */
function createTempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-e2e-'));
  const dirs = { root, dataDir: path.join(root, 'data'), profileDir: path.join(root, 'profile'), downloadDir: path.join(root, 'downloads') };
  for (const dir of [dirs.dataDir, dirs.profileDir, dirs.downloadDir]) fs.mkdirSync(dir);
  return {
    ...dirs,
    remove: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    /**
     * 브라우저가 끝난 직후에는 도우미 프로세스가 프로필 파일을 잠깐 더 잡고 있어 Windows 에서 지우기가 실패한다(Edge 에서 확인) —
     * REMOVE_RETRY_MS 동안 다시 시도한다. 끝내 실패하면 마지막 오류를 던진다
     */
    async removeEventually() {
      const deadline = Date.now() + REMOVE_RETRY_MS;
      for (;;) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
          return;
        } catch (err) {
          if (Date.now() > deadline) throw err;
          await new Promise((r) => setTimeout(r, REMOVE_RETRY_GAP_MS));
        }
      }
    },
  };
}

/** 테스트 서버를 자식 프로세스로 띄운다 → { base, port, output(), stop() } */
function startServer({ dataDir, adminToken, log = () => {} }) {
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'server', 'index.js')], {
    cwd: APP_ROOT,
    env: buildServerEnv(process.env, { dataDir, adminToken }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const collect = (chunk) => {
    output += chunk;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, SERVER_STOP_TIMEOUT_MS))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`테스트 서버가 ${SERVER_START_TIMEOUT_MS / 1000}초 안에 뜨지 않았습니다:\n${output}`));
    }, SERVER_START_TIMEOUT_MS);
    const onReady = () => {
      const port = parseServerPort(output);
      if (!port) return;
      child.stdout.off('data', onReady);
      clearTimeout(timer);
      log(`테스트 서버: http://127.0.0.1:${port} (data=${dataDir})`);
      resolve({ port, base: `http://127.0.0.1:${port}`, output: () => output, stop });
    };
    child.stdout.on('data', onReady);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`테스트 서버가 시작하자마자 끝났습니다(코드 ${code}):\n${output}`));
    });
  });
}

// ── 업로드할 로고(PNG) — 외부 파일 없이 내장 zlib 로 만든다 ─────────────────
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

/** size×size 체크무늬 RGB PNG 를 file 에 쓴다 */
function writeTestPng(file, size = 64) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8비트 RGB
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3); // 줄마다 필터 0
    for (let x = 0; x < size; x += 1) {
      const dark = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      row.set(dark ? [30, 30, 30] : [230, 60, 40], 1 + x * 3);
    }
    rows.push(row);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return file;
}

module.exports = { buildServerEnv, parseServerPort, createTempDirs, startServer, writeTestPng, APP_ROOT };
