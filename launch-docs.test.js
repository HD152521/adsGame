// 런칭 문서 정합성(계획서 Step 8) — 문서가 코드와 어긋나지 않는지 기계로 본다.
//   · README 환경변수 표 = 코드가 읽는 환경변수 이름 전부(빠짐 없음) + 표의 이름은 코드에 실제로 있음(오기 없음)
//   · README 에 배포·복구 명령(fly 앱·볼륨·secrets·deploy·logs·스냅샷 목록/복구)·헬스체크가 있다
//   · 운영 매뉴얼(docs/operations.md)·런칭 체크리스트(docs/launch-checklist.md)가 있고 필요한 절이 있다
//   · 체크리스트: H1~H8 + 기술 점검, 미완료는 □, 완료(☑)는 증빙 칸이 비어 있지 않다
//   · README·계획서에서 두 문서로 가는 링크가 실제 파일을 가리킨다. 계획서 Step 1~8 완료 표시
//   · 문서에 실제 비밀값·키 모양 문자열이 없다
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { BUSINESS_FIELDS } = require('./server/business.js');
const { S3_ENV } = require('./server/sigv4.js');
const { ADMIN_GUARD_DEFAULTS } = require('./server/admin-guard.js');

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const README = 'README.md';
const OPERATIONS = 'docs/operations.md';
const CHECKLIST = 'docs/launch-checklist.md';
// 계획서는 앱 안 사본과 주차 기록 두 곳에 있다 — 둘 다 같은 규칙으로 본다
const PLAN_FILES = ['docs/launch-plan.md', '../../weeks/w13-ad-dodge/launch-plan.md'].filter(exists);

// 운영체제가 주는 값(E2E 브라우저 찾기용) — 운영 설정이 아니라 표에 넣지 않는다
const OS_PROVIDED_ENV = new Set(['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA', 'PATH']);

/** 테스트가 아닌 소스(.js) 목록 — 루트·server/·e2e/ */
function sourceFiles() {
  const dirs = ['.', 'server', 'e2e'];
  return dirs.flatMap((dir) =>
    fs.readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
      .map((f) => path.join(dir, f)),
  );
}

/** 코드가 읽는 환경변수 이름 — 직접 접근(env.X·env['X']·requireSecret('X')) + 표로 읽는 것(BUSINESS_FIELDS·S3_ENV) */
function envNamesReadByCode() {
  const names = new Set();
  for (const file of sourceFiles()) {
    const src = read(file);
    for (const m of src.matchAll(/\benv\??\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/\benv\[\s*'([A-Z][A-Z0-9_()]*)'\s*\]/g)) names.add(m[1]);
    for (const m of src.matchAll(/requireSecret\('([A-Z][A-Z0-9_]*)'\)/g)) names.add(m[1]);
  }
  for (const f of BUSINESS_FIELDS) names.add(f.env);
  for (const name of Object.values(S3_ENV)) names.add(name);
  return new Set([...names].filter((n) => !OS_PROVIDED_ENV.has(n)));
}

/** "## 환경변수" 절의 표 → [{ name, required, example, desc }] (첫 칸에 이름 하나) */
function readmeEnvTable() {
  const md = read(README);
  const start = md.search(/^## 환경변수/m);
  assert.ok(start >= 0, 'README 에 "## 환경변수" 절이 있어야 한다');
  const rest = md.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  return section.split('\n')
    .filter((line) => /^\|\s*`/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const names = [...cells[0].matchAll(/`([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);
      return { names, required: cells[1] || '', example: cells[2] || '', desc: cells[3] || '' };
    });
}

/** 마크다운 링크 중 대상 파일 이름이 target 으로 끝나는 것들 */
const linksTo = (md, target) => [...md.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((href) => href.endsWith(target));

test('코드가 읽는 환경변수 수집기가 알려진 이름을 놓치지 않는다(수집 정규식 회귀 방지)', () => {
  const found = envNamesReadByCode();
  for (const name of ['ADMIN_TOKEN', 'WEBHOOK_SECRET', 'PAYMENT_PROVIDER', 'TOSS_SECRET_KEY', 'NODE_ENV', 'DATA_DIR', 'BIZ_NAME', 'BACKUP_S3_SECRET_KEY', 'GOOGLE_VISION_API_KEY', 'TRUST_PROXY']) {
    assert.ok(found.has(name), `${name} 을 찾지 못했다`);
  }
});

test('README 환경변수 표 — 한 줄에 이름 하나, 필수 여부·예시 형식·설명 칸이 다 있다', () => {
  const rows = readmeEnvTable();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.names.length, 1, `한 줄에 이름 하나: ${row.names.join(', ')}`);
    assert.ok(row.required, `${row.names[0]} 필수 여부 칸이 비었다`);
    assert.ok(row.example, `${row.names[0]} 예시 칸이 비었다`);
    assert.ok(row.desc, `${row.names[0]} 설명 칸이 비었다`);
  }
});

test('README 환경변수 표 = 코드가 읽는 환경변수(빠짐·오기·중복 없음)', () => {
  const inTable = readmeEnvTable().map((r) => r.names[0]);
  const inCode = envNamesReadByCode();
  const missing = [...inCode].filter((n) => !inTable.includes(n));
  const unknown = inTable.filter((n) => !inCode.has(n));
  const dupes = inTable.filter((n, i) => inTable.indexOf(n) !== i);
  assert.deepEqual(missing, [], `표에 빠진 환경변수: ${missing.join(', ')}`);
  assert.deepEqual(unknown, [], `코드가 읽지 않는 이름(오기?): ${unknown.join(', ')}`);
  assert.deepEqual(dupes, [], `표에 두 번 나온 이름: ${dupes.join(', ')}`);
});

test('fly.toml [env] 의 이름은 모두 README 표에 있다', () => {
  const toml = read('fly.toml');
  const envBlock = toml.split(/^\[env\]/m)[1].split(/^\[/m)[0];
  const names = [...envBlock.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]);
  const inTable = readmeEnvTable().map((r) => r.names[0]);
  assert.ok(names.length > 0);
  for (const name of names) assert.ok(inTable.includes(name), `fly.toml ${name} 이 README 표에 없다`);
});

test('README 만으로 배포·복구 — fly 명령·헬스체크·백업 복구 세 갈래가 있다', () => {
  const md = read(README);
  const commands = [
    'fly apps create', 'fly volumes create', 'fly secrets set', 'fly deploy', 'fly logs',
    'fly volumes snapshots list', 'fly volumes snapshots create', '--snapshot-id', 'fly machine clone', '--attach-volume',
    'fly machine update', 'fly ssh console', 'fly status',
  ];
  for (const cmd of commands) assert.ok(md.includes(cmd), `README 에 "${cmd}" 가 없다`);
  assert.match(md, /\/api\/health/);
  assert.match(md, /^### .*복구/m, '복구 절이 있어야 한다');
  for (const route of ['backups/', '스냅샷', 'S3']) assert.ok(md.includes(route), `복구 갈래 "${route}" 가 없다`);
});

test('운영 매뉴얼 — 검수·신고·환불·장애 대응·토큰 교체 절과 최근 문제 종류별 조치', () => {
  assert.ok(exists(OPERATIONS), `${OPERATIONS} 가 있어야 한다`);
  const md = read(OPERATIONS);
  for (const heading of ['검수', '신고', '환불', '장애 대응', '토큰 교체']) {
    assert.match(md, new RegExp(`^## .*${heading}`, 'm'), `"${heading}" 절이 없다`);
  }
  for (const kind of ['server', 'webhook', 'pg', 'backup', 'admin', 'audit']) {
    assert.match(md, new RegExp(`\`${kind}\``), `최근 문제 종류 ${kind} 조치가 없다`);
  }
  for (const mode of ['review-all', 'vision']) assert.ok(md.includes(mode), `검수 모드 ${mode} 설명이 없다`);
  const blockMinutes = ADMIN_GUARD_DEFAULTS.blockMs / 60_000;
  assert.ok(md.includes(`${blockMinutes}분`), `관리자 차단 시간(${blockMinutes}분)이 코드와 같아야 한다`);
});

test('런칭 체크리스트 — H1~H8, 기술 점검, 미완료 □ / 완료 ☑ + 증빙', () => {
  assert.ok(exists(CHECKLIST), `${CHECKLIST} 가 있어야 한다`);
  const md = read(CHECKLIST);
  const rows = md.split('\n').filter((l) => /^\|\s*[□☑]/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  for (let h = 1; h <= 8; h += 1) {
    assert.ok(rows.some((cells) => cells.some((c) => c.startsWith(`H${h}`))), `H${h} 항목이 없다`);
  }
  for (const keyword of ['FREE_MODE', '운영 시작 점검', 'PAYMENT_PROVIDER=toss', '테스트 결제', '웹훅', '백업', 'E2E', '실기기', '사업자 정보']) {
    assert.ok(rows.some((cells) => cells.join(' ').includes(keyword)), `기술 점검 "${keyword}" 항목이 없다`);
  }
  assert.ok(rows.some((cells) => cells[0].startsWith('□')), '미완료 항목(□)이 보여야 한다');
  for (const cells of rows.filter((c) => c[0].startsWith('☑'))) {
    const evidence = cells[2] || '';
    assert.match(evidence, /`[0-9a-f]{7}`|[^\s_—-]/, `완료(☑) 항목에 증빙이 없다: ${cells[1]}`);
  }
  // 코드 쪽에서 끝난 것은 근거 커밋이 붙는다
  assert.ok(rows.some((cells) => cells[0].startsWith('☑') && /`[0-9a-f]{7}`/.test(cells[2] || '')), '☑ + 근거 커밋 항목이 있어야 한다');
});

test('README·계획서에서 운영 매뉴얼·런칭 체크리스트로 가는 링크가 실제 파일을 가리킨다', () => {
  for (const file of [README, ...PLAN_FILES]) {
    const md = read(file);
    for (const target of ['operations.md', 'launch-checklist.md']) {
      const hrefs = linksTo(md, target);
      assert.ok(hrefs.length > 0, `${file} 에 ${target} 링크가 없다`);
      for (const href of hrefs) {
        const resolved = path.resolve(ROOT, path.dirname(file), href);
        assert.ok(fs.existsSync(resolved), `${file} 의 링크 ${href} 가 없는 파일을 가리킨다`);
      }
    }
  }
});

test('계획서 Step 1~8 완료 표시(Step 1~7 은 커밋 해시 포함)', () => {
  const hashes = { 1: ['cb8ce23'], 2: ['2c3838c', '10bd97d'], 3: ['49efd6c'], 4: ['5fcf862', '6f7e476'], 5: ['9837446'], 6: ['bb469e9'], 7: ['f7f32e3'], 8: [] };
  assert.ok(PLAN_FILES.length > 0);
  for (const file of PLAN_FILES) {
    const md = read(file);
    for (const [step, list] of Object.entries(hashes)) {
      // "Step N"(N 다음이 숫자·~ 가 아닌) + 완료 + 그 단계 커밋 해시가 모두 한 줄에 있어야 한다
      const ok = md.split('\n').some((l) => new RegExp(`Step ${step}(?![0-9~])`).test(l) && l.includes('완료') && list.every((hash) => l.includes(hash)));
      assert.ok(ok, `${file}: Step ${step} 완료 표시(${list.join(', ') || '해시 없음'})가 한 줄에 없다`);
    }
  }
});

test('문서에 실제 비밀값·키 모양 문자열이 없다', () => {
  const files = [README, OPERATIONS, CHECKLIST, 'docs/device-checklist.md', ...PLAN_FILES].filter(exists);
  const patterns = [
    /\b(?:test|live)_(?:sk|ck|gsk)_[A-Za-z0-9]{4,}/, // 토스 키
    /\bAKIA[0-9A-Z]{16}\b/, // AWS 액세스 키
    /\bAIza[0-9A-Za-z_-]{30,}/, // Google API 키
    /\b[a-f0-9]{32,}\b/i, // openssl rand -hex 32 같은 긴 hex(토큰)
  ];
  for (const file of files) {
    const md = read(file);
    for (const re of patterns) assert.doesNotMatch(md, re, `${file} 에 비밀값 모양 문자열(${re})`);
  }
});
