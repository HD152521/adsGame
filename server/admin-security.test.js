// 관리자 보안 HTTP 통합 테스트(계획서 Step 6) — 무차별 대입 차단(429)·감사 로그 조회·본문 형식 400·내부 오류 문구 비노출.
//   실제 서버를 포트 0에 띄우고 fetch로 두드린다. 시간은 now 주입으로 넘긴다(기다리지 않음).
//   실행: apps/ad-dodge 안에서 node --test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('./app.js');
const M = require('./moderation.js');
const { ADMIN_GUARD_DEFAULTS } = require('./admin-guard.js');
const { tokenFingerprint } = require('./audit-log.js');

const CONSENTS = { rights: true, dilution: true, refund: true };
const ADMIN = 'admin-token-for-security-test-9f3c1a7e';
const WEBHOOK_SECRET = 'whsec-security-test-value';
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const auth = { authorization: `Bearer ${ADMIN}` };
const wrong = { authorization: 'Bearer not-the-admin-token' };

async function start(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-sec-'));
  const app = createApp({
    dataDir,
    adminToken: ADMIN,
    webhookSecret: WEBHOOK_SECRET,
    devMode: true,
    classifier: M.reviewAllClassifier(),
    limits: { orders: 100, kills: 100, reports: 20, windowMs: 60_000 },
    ...overrides,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (p, headers = {}) => fetch(`${base}${p}`, { headers });
  const post = (p, body, headers = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { app, dataDir, base, get, post };
}

// ── 1) 무차별 대입 ──────────────────────────────────────────────────────────────
test('[무차별 대입] 기본값: 5분에 실패 10회 허용, 넘으면 15분 차단 / 분당 120회', () => {
  assert.equal(ADMIN_GUARD_DEFAULTS.failures, 10);
  assert.equal(ADMIN_GUARD_DEFAULTS.failureWindowMs, 5 * 60_000);
  assert.equal(ADMIN_GUARD_DEFAULTS.blockMs, 15 * 60_000);
  assert.equal(ADMIN_GUARD_DEFAULTS.requests, 120);
});

test('[무차별 대입] 틀린 토큰 반복 → 429, 차단 동안은 올바른 토큰도 429, 차단이 풀리면 다시 200', async () => {
  let clock = 1_000_000;
  const s = await start({ now: () => clock });
  try {
    for (let i = 0; i < ADMIN_GUARD_DEFAULTS.failures; i += 1) assert.equal((await s.get('/api/admin/errors', wrong)).status, 401, `실패 ${i + 1}회째`);
    const blocked = await s.get('/api/admin/advertisers', wrong);
    assert.equal(blocked.status, 429);
    assert.match((await blocked.json()).error, /잠시 후/);
    assert.equal((await s.get('/api/admin/advertisers', auth)).status, 429);
    assert.equal((await s.post('/api/admin/advertisers/abc/approve', {}, auth)).status, 429);
    assert.equal((await s.get('/api/admin/audit', auth)).status, 429);
    clock += ADMIN_GUARD_DEFAULTS.blockMs - 1000;
    assert.equal((await s.get('/api/admin/advertisers', auth)).status, 429, '아직 차단 중');
    clock += 2000;
    assert.equal((await s.get('/api/admin/advertisers', auth)).status, 200, '차단이 풀림');
    // 공개 API 는 관리자 차단과 무관
    assert.equal((await s.get('/api/ledger')).status, 200);
    // 차단은 최근 문제에 남는다(가린 IP, 토큰 원문 없음)
    const { errors } = await (await s.get('/api/admin/errors', auth)).json();
    const note = errors.find((e) => e.kind === 'admin');
    assert.ok(note, JSON.stringify(errors));
    assert.match(note.message, /127\.0\.0\.\*/);
    assert.equal(JSON.stringify(errors).includes('not-the-admin-token'), false);
  } finally {
    s.app.close();
  }
});

test('[무차별 대입] 실패 횟수 창(5분)이 지나면 실패가 다시 0부터 센다', async () => {
  let clock = 5_000_000;
  const s = await start({ now: () => clock });
  try {
    for (let i = 0; i < ADMIN_GUARD_DEFAULTS.failures; i += 1) assert.equal((await s.get('/api/admin/errors', wrong)).status, 401);
    clock += ADMIN_GUARD_DEFAULTS.failureWindowMs;
    assert.equal((await s.get('/api/admin/errors', wrong)).status, 401);
    assert.equal((await s.get('/api/admin/errors', auth)).status, 200);
  } finally {
    s.app.close();
  }
});

test('[무차별 대입] X-Forwarded-For 앞쪽을 바꿔 가며 보내도(TRUST_PROXY) 같은 접속 IP로 묶여 차단된다', async () => {
  const s = await start({ trustProxy: true });
  try {
    const via = (i, extra) => ({ 'x-forwarded-for': `10.0.${i}.${i}, 198.51.100.7`, ...extra });
    for (let i = 0; i < ADMIN_GUARD_DEFAULTS.failures; i += 1) assert.equal((await s.get('/api/admin/errors', via(i, wrong))).status, 401);
    assert.equal((await s.get('/api/admin/errors', via(99, wrong))).status, 429);
    assert.equal((await s.get('/api/admin/errors', via(42, auth))).status, 429);
    // 다른 접속 IP(다른 사람)는 막히지 않는다
    assert.equal((await s.get('/api/admin/errors', { 'x-forwarded-for': '203.0.113.9', ...auth })).status, 200);
  } finally {
    s.app.close();
  }
});

test('[무차별 대입] 정상 사용(목록 새로고침 수십 번 + 오타 몇 번)은 막히지 않는다', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await s.get('/api/admin/errors', wrong)).status, 401);
    for (let i = 0; i < 30; i += 1) {
      // 관리자 화면 한 번 불러오기 = 목록 + 최근 문제 + 관리 기록
      for (const p of ['/api/admin/advertisers?status=pending_review', '/api/admin/errors', '/api/admin/audit']) assert.equal((await s.get(p, auth)).status, 200, `${i}: ${p}`);
    }
  } finally {
    s.app.close();
  }
});

test('[무차별 대입] 관리자 경로 전체에 IP별 요청 버킷 — 토큰 검사 전에 센다(올바른 토큰도 상한을 넘으면 429)', async () => {
  let clock = 9_000_000;
  const s = await start({ now: () => clock, adminGuard: { requests: 5 } });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await s.get('/api/admin/errors', auth)).status, 200);
    assert.equal((await s.get('/api/admin/nope')).status, 401);
    assert.equal((await s.get('/api/admin/errors', auth)).status, 200);
    assert.equal((await s.get('/api/admin/errors', auth)).status, 429);
    clock += 60_000;
    assert.equal((await s.get('/api/admin/errors', auth)).status, 200);
  } finally {
    s.app.close();
  }
});

// ── 2) 감사 로그 ────────────────────────────────────────────────────────────────
let shared;
before(async () => {
  shared = await start();
});
after(() => shared.app.close());

async function paidSnipe(name) {
  const order = await (await shared.post('/api/orders', { kind: 'snipe', name, slots: 1, consents: CONSENTS })).json();
  assert.equal((await shared.post(`/api/dev/deposit/${order.orderId}`, {})).status, 200);
  return order;
}

async function paidLogo(name) {
  const order = await (await shared.post('/api/orders', { kind: 'logo', name, slots: 1, image: PNG_1PX, consents: CONSENTS })).json();
  assert.equal((await shared.post(`/api/dev/deposit/${order.orderId}`, {})).status, 200);
  return order;
}

test('[감사 HTTP] 승인·가림·복구·수정·거절·환불·CSV 내보내기가 기록되고, 관리자만 GET /api/admin/audit 로 본다', async () => {
  const a = await paidLogo('감사로고');
  const adv = (action) => shared.post(`/api/admin/advertisers/${a.advertiserId}/${action}`, {}, auth);
  assert.equal((await adv('approve')).status, 200);
  assert.equal((await adv('hide')).status, 200);
  assert.equal((await adv('restore')).status, 200);
  assert.equal((await shared.post(`/api/admin/advertisers/${a.advertiserId}/edit`, { name: '감사수정', landingUrl: 'fixed.example' }, auth)).status, 200);
  assert.equal((await adv('reject')).status, 200);
  assert.equal((await shared.post(`/api/admin/orders/${a.orderId}/refund`, { memo: '이체 완료' }, auth)).status, 200);
  assert.equal((await shared.get('/api/admin/export.csv?status=refunded', auth)).status, 200);
  // 실패한 작업(없는 광고)은 기록하지 않는다
  assert.equal((await shared.post('/api/admin/advertisers/nope00000000/approve', {}, auth)).status, 400);

  assert.equal((await shared.get('/api/admin/audit')).status, 401);
  assert.equal((await shared.get('/api/admin/audit', wrong)).status, 401);
  const res = await shared.get('/api/admin/audit', auth);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { entries, max } = await res.json();
  assert.equal(max, 2000);
  const mine = entries.filter((e) => e.order === a.orderId.slice(0, 8) || e.action === 'export');
  assert.deepEqual(mine.map((e) => e.action).reverse(), ['approve', 'hide', 'restore', 'edit', 'reject', 'refund', 'export']);
  assert.deepEqual(mine.find((e) => e.action === 'edit').fields, ['name', 'landingUrl']);
  assert.deepEqual(mine.find((e) => e.action === 'refund').fields, ['status', 'refundedAt', 'refundMemo']);
  assert.match(mine.find((e) => e.action === 'export').note, /refunded/);
  for (const e of mine) {
    assert.equal(e.actor, tokenFingerprint(ADMIN));
    assert.equal(e.ip, '127.0.0.*');
    assert.ok(Number.isFinite(e.at));
  }
  assert.equal(entries.some((e) => e.order === 'nope0000'), false);

  const text = JSON.stringify(entries);
  for (const leaked of [ADMIN, WEBHOOK_SECRET, a.orderId, '이체 완료', '감사수정']) assert.equal(text.includes(leaked), false, leaked);
  // 장부 파일에도 토큰 원문은 없다
  const ledgerFile = fs.readFileSync(path.join(shared.dataDir, 'db.json'), 'utf8');
  assert.ok(ledgerFile.includes('"audit"'));
  assert.equal(ledgerFile.includes(ADMIN), false);
});

test('[감사 HTTP] ?limit= 로 개수 제한, 잘못된 값은 400', async () => {
  const order = await paidSnipe('리밋손님');
  await shared.post(`/api/admin/advertisers/${order.advertiserId}/approve`, {}, auth);
  const { entries } = await (await shared.get('/api/admin/audit?limit=1', auth)).json();
  assert.equal(entries.length, 1);
  for (const bad of ['0', '-1', 'abc', '1.5']) assert.equal((await shared.get(`/api/admin/audit?limit=${bad}`, auth)).status, 400, bad);
});

// ── 3) 본문 형식 ────────────────────────────────────────────────────────────────
test('[본문] 관리자 POST 에 JSON null·배열·원시값 → 깔끔한 400(내부 TypeError 문구 없음)', async () => {
  const order = await paidSnipe('본문손님');
  const targets = [`/api/admin/advertisers/${order.advertiserId}/edit`, `/api/admin/orders/${order.orderId}/refund`];
  for (const p of targets) {
    for (const raw of ['null', '[]', '[1,2]', '1', '"x"', 'true']) {
      const res = await shared.post(p, raw, auth);
      assert.equal(res.status, 400, `${p} ${raw}`);
      const { error } = await res.json();
      assert.equal(error, '요청 형식이 올바르지 않아요', `${p} ${raw}`);
    }
  }
});

test('[본문] 공개 POST 도 null·배열 본문에 400(500·TypeError 문구 없음)', async () => {
  for (const p of ['/api/orders', '/api/kills', '/api/reports', '/api/runs', '/api/challenges']) {
    for (const raw of ['null', '[]']) {
      const res = await shared.post(p, raw);
      assert.equal(res.status, 400, `${p} ${raw}`);
      const { error } = await res.json();
      assert.doesNotMatch(error, /Cannot|undefined|null|TypeError|destructure/i, `${p} ${raw}`);
    }
  }
});

// ── 5) 오류 메시지 노출·프로토타입 키 ─────────────────────────────────────────────
test('[오류 노출] 서비스 안의 프로그램 오류(TypeError)는 문구를 내보내지 않고 500 일반 문구', async () => {
  const order = await paidSnipe('오류손님');
  const original = shared.app.service.editAdvertiser;
  shared.app.service.editAdvertiser = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'internalSecretField')");
  };
  try {
    const res = await shared.post(`/api/admin/advertisers/${order.advertiserId}/edit`, { name: '바꿈' }, auth);
    assert.equal(res.status, 500);
    const { error } = await res.json();
    assert.doesNotMatch(error, /internalSecretField|Cannot read/);
  } finally {
    shared.app.service.editAdvertiser = original;
  }
});

test('[프로토타입] 주문 조회·칸 추가에 __proto__·constructor 같은 키를 넣어도 404/400(가짜 주문 없음)', async () => {
  for (const key of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) {
    assert.equal((await shared.get(`/api/orders/${key}`)).status, 404, key);
    const topup = await shared.post(`/api/orders/${key}/topup`, { slots: 1, consents: CONSENTS });
    assert.equal(topup.status, 400, key);
    assert.match((await topup.json()).error, /주문을 찾을 수 없/, key);
  }
});

test('[웹훅] 위조 웹훅을 퍼부어도 IP별 실패 상한을 넘으면 429 — 최근 문제(50건)가 위조 기록으로 덮이지 않는다', async () => {
  const s = await start();
  try {
    const body = JSON.stringify({ orderId: 'deadbeefdeadbeefdeadbeefdeadbeef', status: 'DONE', amount: 1000 });
    const statuses = [];
    for (let i = 0; i < 40; i += 1) statuses.push((await s.post('/api/payments/webhook', body, { 'x-mock-signature': `forged-${i}` })).status);
    assert.equal(statuses[0], 401);
    assert.equal(statuses[statuses.length - 1], 429);
    const webhookNotes = s.app.errorLog.list().filter((e) => e.kind === 'webhook');
    assert.ok(webhookNotes.length <= 30, `${webhookNotes.length}`);
    // 위조가 막혀도 올바른 서명 웹훅은 다른 IP(PG)에서 정상 처리 — 같은 IP 라도 1분 뒤엔 다시 받는다(PG 재전송)
  } finally {
    s.app.close();
  }
});

test('[프로토타입] 관리자 작업 이름에 __proto__·constructor 를 넣어도 400(500·내부 문구 없음), 기록도 남지 않는다', async () => {
  const order = await paidSnipe('작업이름손님');
  for (const action of ['__proto__', 'constructor', 'toString']) {
    const res = await shared.post(`/api/admin/advertisers/${order.advertiserId}/${action}`, {}, auth);
    assert.equal(res.status, 400, action);
    assert.match((await res.json()).error, /알 수 없는 작업/, action);
  }
  const { entries } = await (await shared.get('/api/admin/audit', auth)).json();
  assert.equal(entries.some((e) => !['approve', 'reject', 'hide', 'restore', 'edit', 'refund', 'export'].includes(e.action)), false);
});

// ── 6) 감사 기록 실패 격리(Step 6 리뷰 MEDIUM) ─────────────────────────────────────
test('[감사 목록] orders.js 의 관리자 작업 이름은 전부 감사 로그 작업 목록에 있다(두 목록이 따로 늘지 않게)', () => {
  const { ADMIN_ACTIONS } = require('./orders.js');
  const { AUDIT_ACTIONS } = require('./audit-log.js');
  assert.ok(Array.isArray(ADMIN_ACTIONS) && ADMIN_ACTIONS.length > 0, 'ADMIN_ACTIONS 를 내보내야 한다');
  for (const action of ADMIN_ACTIONS) assert.ok(AUDIT_ACTIONS.has(action), action);
});

test('[감사 실패] 감사 기록이 실패해도 이미 끝난 관리자 작업은 200 — 실패는 최근 문제(audit)에 남는다', async () => {
  const failingAudit = {
    record() {
      throw new Error('감사 기록 디스크 쓰기 실패');
    },
    list: () => [],
  };
  const s = await start({ auditLog: failingAudit });
  try {
    const order = await (await s.post('/api/orders', { kind: 'logo', name: '감사실패손님', slots: 1, image: PNG_1PX, consents: CONSENTS })).json();
    assert.equal((await s.post(`/api/dev/deposit/${order.orderId}`, {})).status, 200);
    const res = await s.post(`/api/admin/advertisers/${order.advertiserId}/approve`, {}, auth);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'active');
    assert.equal((await s.get('/api/admin/export.csv', auth)).status, 200);
    const notes = s.app.errorLog.list().filter((e) => e.kind === 'audit');
    assert.equal(notes.length, 2, JSON.stringify(s.app.errorLog.list()));
    assert.match(notes[0].message, /감사 기록/);
  } finally {
    s.app.close();
  }
});
