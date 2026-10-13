// GET /api/health — 호스팅(fly) 헬스체크. 장부(db.json)를 실제로 읽어 볼 수 있어야 200, 못 읽으면 503.
//   응답에는 상태만 — 경로·토큰·비밀값을 싣지 않는다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('./app.js');
const { checkLedger } = require('./health.js');
const M = require('./moderation.js');

const ADMIN = 'health-test-admin-token';
const WEBHOOK = 'health-test-webhook-secret';

async function withApp(fn, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-health-'));
  const app = createApp({ dataDir, adminToken: ADMIN, webhookSecret: WEBHOOK, classifier: M.reviewAllClassifier(), ...extra });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    return await fn({ dataDir, base: `http://127.0.0.1:${app.server.address().port}` });
  } finally {
    app.close();
  }
}

async function getHealth(base) {
  const res = await fetch(`${base}/api/health`);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text), cache: res.headers.get('cache-control') };
}

test('GET /api/health: 새 볼륨(장부 파일 아직 없음)이면 200 ok', async () => {
  await withApp(async ({ base }) => {
    const h = await getHealth(base);
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.equal(h.cache, 'no-store');
  });
});

test('GET /api/health: 장부 파일을 읽을 수 있으면 200 ok', async () => {
  await withApp(async ({ base, dataDir }) => {
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ orders: {} }));
    const h = await getHealth(base);
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
  });
});

test('GET /api/health: 장부가 깨져서 못 읽으면 503 — 경로·비밀값은 응답에 없다', async () => {
  await withApp(async ({ base, dataDir }) => {
    fs.writeFileSync(path.join(dataDir, 'db.json'), '{ 반쯤 깨진 장부');
    const h = await getHealth(base);
    assert.equal(h.status, 503);
    assert.equal(h.body.ok, false);
    for (const secret of [ADMIN, WEBHOOK, dataDir, 'db.json']) assert.ok(!h.text.includes(secret), `응답에 ${secret} 노출`);
  });
});

test('GET /api/health: 장부 자리가 파일이 아니면(읽기 오류) 503', async () => {
  await withApp(async ({ base, dataDir }) => {
    fs.mkdirSync(path.join(dataDir, 'db.json'));
    const h = await getHealth(base);
    assert.equal(h.status, 503);
    assert.equal(h.body.ok, false);
  });
});

test('checkLedger: 데이터 폴더가 사라졌으면(볼륨 미마운트) 실패', async () => {
  const gone = path.join(os.tmpdir(), `ad-dodge-missing-${process.pid}-${Date.now()}`);
  const r = await checkLedger(gone);
  assert.equal(r.ok, false);
});

// 리뷰 M: 헬스체크는 인증 없이 열려 있고 매번 장부 전체를 읽는다 — 마구 두드리면 디스크 I/O 로 실사용자가 느려진다.
//   다른 공개 API 처럼 IP별 리밋을 건다. 단, fly 탐침(15초 간격 = 분당 4회)보다는 넉넉해야 한다.
test('GET /api/health: 같은 IP가 리밋을 넘겨 두드리면 429 — 장부를 더 읽지 않는다', async () => {
  await withApp(async ({ base }) => {
    assert.equal((await getHealth(base)).status, 200);
    assert.equal((await getHealth(base)).status, 200);
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 429);
  }, { limits: { orders: 5, kills: 60, reports: 10, health: 2, windowMs: 60_000 } });
});

test('GET /api/health: 기본 리밋은 fly 탐침 주기(분당 4회)보다 넉넉하다 — 분당 20회까지 200', async () => {
  await withApp(async ({ base }) => {
    for (let i = 0; i < 20; i += 1) assert.equal((await getHealth(base)).status, 200, `${i + 1}번째 요청`);
  });
});
