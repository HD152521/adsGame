// E2E 도구 단위 테스트(계획서 Step 7) — 브라우저 없이 도는 부분만 본다.
//   브라우저 찾기·DevTools 주소 읽기·서버 환경변수(임시 data 폴더·테스트 모드)·브라우저 없을 때 건너뛰기 종료 코드,
//   기본 node --test 에 E2E 시나리오가 섞이지 않는지, 실기기 체크리스트 문서·README 링크.
//   실제 헤드리스 브라우저 흐름은 node e2e/run.js 로 따로 돈다(느리고 브라우저 필요).
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findBrowser, parseDevToolsUrl, isIgnorableLogEntry } = require('./cdp.js');
const { buildServerEnv, parseServerPort, createTempDirs } = require('./harness.js');
const { main, EXIT } = require('./run.js');

const APP_ROOT = path.join(__dirname, '..');
const REPO_DATA = path.join(APP_ROOT, 'data');

test('[브라우저 찾기] E2E_BROWSER 로 준 경로가 있으면 그것을 쓴다', () => {
  const found = findBrowser({ env: { E2E_BROWSER: 'D:/x/chrome.exe' }, platform: 'win32', exists: (p) => p === 'D:/x/chrome.exe' });
  assert.equal(found, 'D:/x/chrome.exe');
});

test('[브라우저 찾기] Windows — Chrome 이 없으면 Edge, 둘 다 없으면 null', () => {
  const edgeOnly = findBrowser({ env: {}, platform: 'win32', exists: (p) => /msedge\.exe$/i.test(p) });
  assert.match(edgeOnly, /msedge\.exe$/i);
  const chromeAndEdge = findBrowser({ env: {}, platform: 'win32', exists: (p) => /(chrome|msedge)\.exe$/i.test(p) });
  assert.match(chromeAndEdge, /chrome\.exe$/i, 'Chrome 을 먼저 고른다');
  assert.equal(findBrowser({ env: {}, platform: 'win32', exists: () => false }), null);
  assert.equal(findBrowser({ env: {}, platform: 'linux', exists: () => false }), null);
});

test('[브라우저 찾기] E2E_BROWSER 경로가 없는 파일이면 다른 후보로 넘어가지 않고 null(엉뚱한 브라우저로 돌지 않게)', () => {
  assert.equal(findBrowser({ env: { E2E_BROWSER: 'D:/none/chrome.exe' }, platform: 'win32', exists: (p) => p !== 'D:/none/chrome.exe' }), null);
});

test('[DevTools 주소] 브라우저 stderr 에서 ws:// 주소를 읽는다', () => {
  const text = 'blah\r\n\r\nDevTools listening on ws://127.0.0.1:61234/devtools/browser/0b5e-41aa\r\nmore';
  assert.equal(parseDevToolsUrl(text), 'ws://127.0.0.1:61234/devtools/browser/0b5e-41aa');
  assert.equal(parseDevToolsUrl('아직 안 뜸'), null);
});

test('[콘솔 오류] 외부 글꼴(Google Fonts) 네트워크 실패만 무시하고 나머지는 센다', () => {
  assert.equal(isIgnorableLogEntry({ level: 'error', source: 'network', url: 'https://fonts.googleapis.com/css2?family=x' }), true);
  assert.equal(isIgnorableLogEntry({ level: 'error', source: 'network', url: 'https://fonts.gstatic.com/s/a.woff2' }), true);
  assert.equal(isIgnorableLogEntry({ level: 'error', source: 'network', url: 'http://127.0.0.1:5173/api/ledger' }), false);
  assert.equal(isIgnorableLogEntry({ level: 'error', source: 'javascript', url: 'https://fonts.googleapis.com/x' }), false);
});

test('[서버 환경] 테스트 모드·자동 승인·임시 data 폴더·임의 포트, 운영·결제·외부 백업 값은 물려받지 않는다', () => {
  const env = buildServerEnv(
    { PATH: '/bin', NODE_ENV: 'production', PAYMENT_PROVIDER: 'toss', TOSS_SECRET_KEY: 'live_sk_x', DEV_DEPOSIT: '1', BACKUP_S3_BUCKET: 'b', DATA_DIR: REPO_DATA, HOST: '0.0.0.0', TRUST_PROXY: '1', GOOGLE_VISION_API_KEY: 'k' },
    { dataDir: '/tmp/ad-dodge-e2e-1/data', adminToken: 'e2e-admin-token-0123456789' },
  );
  assert.equal(env.PATH, '/bin');
  assert.equal(env.FREE_MODE, '1');
  assert.equal(env.MODERATION_MODE, 'auto-approve');
  assert.equal(env.DATA_DIR, '/tmp/ad-dodge-e2e-1/data');
  assert.equal(env.PORT, '0');
  assert.equal(env.ADMIN_TOKEN, 'e2e-admin-token-0123456789');
  assert.ok(env.WEBHOOK_SECRET.length >= 16);
  for (const key of ['NODE_ENV', 'PAYMENT_PROVIDER', 'TOSS_SECRET_KEY', 'DEV_DEPOSIT', 'BACKUP_S3_BUCKET', 'HOST', 'TRUST_PROXY', 'GOOGLE_VISION_API_KEY']) {
    assert.equal(env[key], undefined, key);
  }
});

test('[서버 환경] 서버 시작 줄에서 실제로 열린 포트를 읽는다', () => {
  assert.equal(parseServerPort('[server] http://127.0.0.1:54321  (운영모드=꺼짐, 테스트모드=켜짐)'), 54321);
  assert.equal(parseServerPort('[config] ⚠ FREE_MODE=1'), null);
});

test('[임시 폴더] E2E 는 운영체제 임시 폴더만 쓰고 저장소 data/ 는 건드리지 않는다', () => {
  const dirs = createTempDirs();
  try {
    for (const dir of [dirs.root, dirs.dataDir, dirs.profileDir, dirs.downloadDir]) {
      assert.ok(fs.existsSync(dir), dir);
      assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())), `${dir} 는 임시 폴더 안`);
      assert.equal(path.resolve(dir).startsWith(path.resolve(REPO_DATA)), false);
    }
  } finally {
    dirs.remove();
  }
  assert.equal(fs.existsSync(dirs.root), false, '끝나면 지운다');
});

test('[실행] 브라우저를 못 찾으면 안내를 남기고 "건너뜀" 종료 코드(서버도 띄우지 않음)', async () => {
  const lines = [];
  let started = false;
  const code = await main({ findBrowser: () => null, log: (l) => lines.push(l), startServer: () => { started = true; } });
  assert.equal(code, EXIT.SKIPPED);
  assert.notEqual(EXIT.SKIPPED, EXIT.PASS);
  assert.notEqual(EXIT.SKIPPED, EXIT.FAIL);
  assert.equal(started, false);
  assert.match(lines.join('\n'), /브라우저.*(찾지 못|없)/);
  assert.match(lines.join('\n'), /E2E_BROWSER/);
});

// Node 기본 node --test 파일 패턴(**/*.test.*, **/*-test.*, **/*_test.*, **/test-*.*, **/test/**) — E2E 시나리오·실행기는 여기 걸리면 안 된다
const DEFAULT_TEST_PATTERNS = [/\.test\.[cm]?js$/, /-test\.[cm]?js$/, /_test\.[cm]?js$/, /(^|\/)test-[^/]*\.[cm]?js$/, /(^|\/)test\//];

test('[분리] 브라우저가 필요한 E2E 파일은 기본 node --test 에 잡히지 않는다', () => {
  const browserFiles = ['e2e/run.js', 'e2e/flow.e2e.js', 'e2e/cdp.js', 'e2e/harness.js'];
  for (const rel of browserFiles) {
    assert.ok(fs.existsSync(path.join(APP_ROOT, rel)), `${rel} 있음`);
    assert.equal(DEFAULT_TEST_PATTERNS.some((re) => re.test(rel)), false, `${rel} 는 기본 테스트 패턴 밖`);
  }
});

test('[배포 제외] E2E 폴더는 컨테이너 이미지·Vercel 에 올라가지 않는다', () => {
  for (const file of ['.dockerignore', '.vercelignore']) {
    const lines = fs.readFileSync(path.join(APP_ROOT, file), 'utf8').split(/\r?\n/).map((l) => l.trim());
    assert.ok(lines.includes('e2e') || lines.includes('e2e/'), `${file} 에 e2e`);
  }
});

// ── 실기기 체크리스트 문서 ─────────────────────────────────────────────
const CHECKLIST = path.join(APP_ROOT, 'docs', 'device-checklist.md');

test('[체크리스트] docs/device-checklist.md — 기기 4종 각각 항목·기대 결과·확인 칸(□)', () => {
  const doc = fs.readFileSync(CHECKLIST, 'utf8');
  const sections = doc.split(/^## /m).slice(1);
  const devices = [/인스타그램 인앱.*iOS/, /인스타그램 인앱.*안드로이드/, /iOS 사파리/, /안드로이드 크롬/];
  for (const device of devices) {
    const section = sections.find((s) => device.test(s.split('\n')[0]));
    assert.ok(section, `${device} 절`);
    assert.match(section, /\|\s*항목\s*\|\s*기대 결과\s*\|\s*확인\s*\|/, `${device} 표 머리`);
    const rows = section.split('\n').filter((l) => /^\|.*□\s*\|\s*$/.test(l));
    assert.ok(rows.length >= 7, `${device} 확인 칸 7개 이상(지금 ${rows.length})`);
    for (const topic of [/멀티터치/, /무음/, /사망 카드/, /광고.*(이동|주소)/, /가상계좌/, /(노치|안전 영역)/, /가로/, /(프레임|저사양)/]) {
      assert.match(section, topic, `${device} — ${topic}`);
    }
  }
});

test('[체크리스트] README 에서 체크리스트와 E2E 실행 명령을 안내한다', () => {
  const readme = fs.readFileSync(path.join(APP_ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\]\(docs\/device-checklist\.md\)/);
  assert.match(readme, /node e2e\/run\.js/);
});
