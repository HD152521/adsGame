// E2E 실행기(계획서 Step 7) — 실제 헤드리스 브라우저로 핵심 흐름을 돈다.
//   실행: apps/ad-dodge 안에서  node e2e/run.js
//   준비: Chrome 또는 Edge 설치(Node 22+ 내장 WebSocket 사용). 다른 경로의 브라우저는 E2E_BROWSER=경로
//   종료 코드: 0 통과 / 1 실패 / 2 건너뜀(브라우저 없음 — 실패와 구분)
//   하는 일: 임시 폴더 → 테스트 서버(FREE_MODE·auto-approve·임의 포트, 자식 프로세스) → 헤드리스 브라우저 →
//            e2e/flow.e2e.js 시나리오 → 브라우저·서버 종료 → 임시 폴더 삭제. 저장소 data/ 는 건드리지 않는다
//   기본 node --test(단위·통합)에는 들어가지 않는다 — 느리고 브라우저가 필요해서

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const cdpLib = require('./cdp.js');
const harness = require('./harness.js');

const EXIT = Object.freeze({ PASS: 0, FAIL: 1, SKIPPED: 2 });
const MIN_NODE_MAJOR = 22; // 내장 WebSocket
const LANDING_HOST = 'ad-landing.test'; // 테스트 광고 이동 주소용 가짜 도메인 — 브라우저 안에서 127.0.0.1 로 돌린다
const REPO_DATA = path.join(harness.APP_ROOT, 'data');

/** 저장소 data/ 의 파일 목록·크기·수정 시각 지문 — 전후가 같아야 한다(E2E 는 임시 폴더만 쓴다) */
function snapshotDir(dir) {
  if (!fs.existsSync(dir)) return 'none';
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else hash.update(`${path.relative(dir, full)}|${st.size}|${st.mtimeMs}\n`);
    }
  };
  walk(dir);
  return hash.digest('hex');
}

async function runWithBrowser({ exe, log, startServer, runFlow }) {
  const dirs = harness.createTempDirs();
  const adminToken = `e2e-admin-${crypto.randomBytes(12).toString('hex')}`;
  const before = snapshotDir(REPO_DATA);
  let server = null;
  let browser = null;
  try {
    server = await startServer({ dataDir: dirs.dataDir, adminToken, log });
    browser = await cdpLib.launchBrowser({ exe, profileDir: dirs.profileDir, mapHosts: [LANDING_HOST], log });
    await runFlow({ cdp: browser.cdp, base: server.base, port: server.port, adminToken, dirs, landingHost: LANDING_HOST, log });
    return EXIT.PASS;
  } catch (err) {
    log(`✖ 실패: ${err && err.stack ? err.stack : err}`);
    if (server) log(`── 테스트 서버 출력 ──\n${server.output().trim()}`);
    return EXIT.FAIL;
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
    try {
      await dirs.removeEventually();
    } catch (err) {
      log(`(임시 폴더를 지우지 못했습니다: ${dirs.root} — ${err.message})`);
    }
    const after = snapshotDir(REPO_DATA);
    log(before === after ? '✔ 저장소 data/ 변화 없음(임시 data 폴더만 사용)' : '✖ 저장소 data/ 가 바뀌었습니다!');
    if (before !== after) process.exitCode = EXIT.FAIL;
  }
}

/** 의존성 주입 가능한 진입점 — 단위 테스트는 findBrowser·startServer 를 갈아 끼운다 */
async function main({ findBrowser = cdpLib.findBrowser, startServer = harness.startServer, runFlow, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const exe = findBrowser();
  if (!exe) {
    log('⚠ E2E 건너뜀: Chrome·Edge 브라우저를 찾지 못했습니다. 설치하거나 E2E_BROWSER=브라우저 실행 파일 경로 로 지정하세요.');
    return EXIT.SKIPPED;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR || typeof WebSocket === 'undefined') {
    log(`⚠ E2E 건너뜀: Node ${MIN_NODE_MAJOR}+ 의 내장 WebSocket 이 필요합니다(지금 ${process.version}).`);
    return EXIT.SKIPPED;
  }
  const flow = runFlow || require('./flow.e2e.js').runFlow;
  const started = Date.now();
  log(`E2E 시작 — 브라우저 ${exe}`);
  const code = await runWithBrowser({ exe, log, startServer, runFlow: flow });
  log(`${code === EXIT.PASS && !process.exitCode ? '✔ E2E 통과' : '✖ E2E 실패'} (${((Date.now() - started) / 1000).toFixed(1)}초)`);
  return process.exitCode || code;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exit(EXIT.FAIL);
    },
  );
}

module.exports = { main, EXIT, snapshotDir };
