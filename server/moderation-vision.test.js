// moderation-vision.js — Google Cloud Vision(SafeSearch + 얼굴 감지) 분류기, MODERATION_MODE 시작 점검.
//   실제 Vision 은 부르지 않는다 — fetch 를 주입해 가짜 응답으로 분기만 확인한다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const V = require('./moderation-vision.js');
const M = require('./moderation.js');

const FAKE_KEY = 'AIzaFAKE-test-key-never-real-0000';
const IMAGE = { mime: 'image/png', ext: 'png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]) };
const SAFE = { adult: 'VERY_UNLIKELY', spoof: 'VERY_UNLIKELY', medical: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', racy: 'UNLIKELY' };

/** 가짜 fetch — 받은 요청을 calls 에 남기고 정해 둔 응답을 돌려준다 */
function fakeFetch({ status = 200, body, throwError } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (throwError) throw throwError;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        if (typeof body === 'string') throw new SyntaxError('Unexpected token');
        return body;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

function visionBody({ safe = SAFE, faces } = {}) {
  const r = {};
  if (safe) r.safeSearchAnnotation = safe;
  if (faces) r.faceAnnotations = faces;
  return { responses: [r] };
}

function make(fetch, extra = {}) {
  const logs = [];
  const c = V.createVisionClassifier({ apiKey: FAKE_KEY, fetch, log: (...a) => logs.push(a.join(' ')), ...extra });
  return { c, logs };
}

// ── 판정 분기 ───────────────────────────────────────────────
test('vision: 이름은 vision, 안전한 이미지(얼굴 없음·이동 주소 없음)는 승인', async () => {
  const f = fakeFetch({ body: visionBody() });
  const { c } = make(f);
  assert.equal(c.name, 'vision');
  assert.equal(await c.classify({ image: IMAGE, landingUrl: null }), 'approve');
});

test('vision: 요청은 images:annotate 한 번 — SAFE_SEARCH_DETECTION + FACE_DETECTION, base64 본문', async () => {
  const f = fakeFetch({ body: visionBody() });
  const { c } = make(f);
  await c.classify({ image: IMAGE });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://vision.googleapis.com/v1/images:annotate');
  assert.equal(init.method, 'POST');
  const req = JSON.parse(init.body);
  assert.equal(req.requests.length, 1);
  assert.equal(req.requests[0].image.content, IMAGE.buffer.toString('base64'));
  assert.deepEqual(req.requests[0].features.map((x) => x.type).sort(), ['FACE_DETECTION', 'SAFE_SEARCH_DETECTION']);
  assert.ok(init.signal, '타임아웃 signal 이 있어야 한다');
});

test('vision: 키는 주소(쿼리)에 싣지 않고 헤더로만 보낸다(주소가 로그·오류에 찍혀도 새지 않게)', async () => {
  const f = fakeFetch({ body: visionBody() });
  const { c } = make(f);
  await c.classify({ image: IMAGE });
  const { url, init } = f.calls[0];
  assert.ok(!url.includes(FAKE_KEY));
  assert.equal(init.headers['X-Goog-Api-Key'], FAKE_KEY);
});

test('vision: adult·violence·racy 중 하나라도 LIKELY 이상이면 거절', async () => {
  for (const field of ['adult', 'violence', 'racy']) {
    for (const level of ['LIKELY', 'VERY_LIKELY']) {
      const { c } = make(fakeFetch({ body: visionBody({ safe: { ...SAFE, [field]: level } }) }));
      assert.equal(await c.classify({ image: IMAGE }), 'reject', `${field}=${level}`);
    }
  }
});

test('vision: adult·violence·racy 중 POSSIBLE 이면 관리자 검토', async () => {
  for (const field of ['adult', 'violence', 'racy']) {
    const { c } = make(fakeFetch({ body: visionBody({ safe: { ...SAFE, [field]: 'POSSIBLE' } }) }));
    assert.equal(await c.classify({ image: IMAGE }), 'review', field);
  }
});

test('vision: spoof·medical 은 판정에 쓰지 않는다(VERY_LIKELY 여도 승인)', async () => {
  const { c } = make(fakeFetch({ body: visionBody({ safe: { ...SAFE, spoof: 'VERY_LIKELY', medical: 'VERY_LIKELY' } }) }));
  assert.equal(await c.classify({ image: IMAGE }), 'approve');
});

test('vision: UNKNOWN(판단 못 함)은 관리자 검토', async () => {
  const { c } = make(fakeFetch({ body: visionBody({ safe: { ...SAFE, adult: 'UNKNOWN' } }) }));
  assert.equal(await c.classify({ image: IMAGE }), 'review');
});

test('vision: 얼굴이 감지되면 관리자 검토(초상권)', async () => {
  const { c } = make(fakeFetch({ body: visionBody({ faces: [{ detectionConfidence: 0.95, joyLikelihood: 'VERY_LIKELY' }] }) }));
  assert.equal(await c.classify({ image: IMAGE }), 'review');
});

test('vision: 빈 faceAnnotations 배열은 얼굴 없음', async () => {
  const { c } = make(fakeFetch({ body: visionBody({ faces: [] }) }));
  assert.equal(await c.classify({ image: IMAGE }), 'approve');
});

test('vision: 거절 등급은 얼굴·이동 주소보다 먼저 — 거절로 끝난다', async () => {
  const { c } = make(fakeFetch({ body: visionBody({ safe: { ...SAFE, adult: 'VERY_LIKELY' }, faces: [{}] }) }));
  assert.equal(await c.classify({ image: IMAGE, landingUrl: 'https://a.kr/' }), 'reject');
});

test('vision: 이미지가 안전해도 이동 주소가 있으면 관리자 검토(기존 정책 유지)', async () => {
  const { c } = make(fakeFetch({ body: visionBody() }));
  assert.equal(await c.classify({ image: IMAGE, landingUrl: 'https://a.kr/' }), 'review');
});

test('vision: 이미지 없는 텍스트 광고는 Vision 을 부르지 않고 승인, 이동 주소가 있으면 검토', async () => {
  const f = fakeFetch({ body: visionBody() });
  const { c } = make(f);
  assert.equal(await c.classify({ image: null, landingUrl: null }), 'approve');
  assert.equal(await c.classify({ image: null, landingUrl: 'https://a.kr/' }), 'review');
  assert.equal(f.calls.length, 0);
});

// ── 실패는 늘 검토(열린 채 실패 금지) ─────────────────────────
test('vision: HTTP 오류(400·401·403·429·500)는 관리자 검토', async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    const { c } = make(fakeFetch({ status, body: { error: { code: status, message: 'nope' } } }));
    assert.equal(await c.classify({ image: IMAGE }), 'review', String(status));
  }
});

test('vision: 200 이어도 responses[0].error 가 있으면 관리자 검토', async () => {
  const { c } = make(fakeFetch({ body: { responses: [{ error: { code: 3, message: 'Bad image data.' } }] } }));
  assert.equal(await c.classify({ image: IMAGE }), 'review');
});

test('vision: 연결 실패(fetch 예외)는 관리자 검토', async () => {
  const { c } = make(fakeFetch({ throwError: new TypeError('fetch failed') }));
  assert.equal(await c.classify({ image: IMAGE }), 'review');
});

test('vision: 타임아웃이면 관리자 검토(응답이 끝내 안 와도 기다리지 않는다)', async () => {
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason || new Error('aborted')));
    });
  const { c } = make(hanging, { timeoutMs: 30 });
  const started = Date.now();
  assert.equal(await c.classify({ image: IMAGE }), 'review');
  assert.ok(Date.now() - started < 2000);
});

test('vision: 비정상 응답(JSON 아님·빈 응답·safeSearch 없음·이상한 등급·형식 틀린 faces)은 관리자 검토', async () => {
  const bodies = [
    'not json',
    null,
    {},
    { responses: [] },
    { responses: [{}] },
    { responses: [{ faceAnnotations: [] }] },
    visionBody({ safe: { ...SAFE, adult: 'MAYBE' } }),
    visionBody({ safe: { violence: 'VERY_UNLIKELY', racy: 'VERY_UNLIKELY' } }),
    visionBody({ faces: 'yes' }),
    { responses: 'x' },
  ];
  for (const body of bodies) {
    const { c } = make(fakeFetch({ body }));
    assert.equal(await c.classify({ image: IMAGE }), 'review', JSON.stringify(body));
  }
});

test('vision: 실패 로그·오류 어디에도 키가 찍히지 않는다', async () => {
  const keyInMessage = new Error(`request to https://vision.googleapis.com/v1/images:annotate?key=${FAKE_KEY} failed`);
  const cases = [
    fakeFetch({ throwError: keyInMessage }),
    fakeFetch({ status: 400, body: { error: { code: 400, message: `API key not valid: ${FAKE_KEY}` } } }),
    fakeFetch({ body: { responses: [{ error: { code: 7, message: `key ${FAKE_KEY} denied` } }] } }),
  ];
  for (const f of cases) {
    const { c, logs } = make(f);
    assert.equal(await c.classify({ image: IMAGE }), 'review');
    assert.ok(logs.length > 0, '실패는 로그로 남긴다');
    for (const line of logs) assert.ok(!line.includes(FAKE_KEY), line);
  }
});

test('vision: 키가 없으면 분류기를 만들지 않는다(오류 메시지에 키 값 없음)', () => {
  assert.throws(() => V.createVisionClassifier({ apiKey: '', fetch: fakeFetch() }), /GOOGLE_VISION_API_KEY/);
  assert.throws(() => V.createVisionClassifier({ apiKey: undefined, fetch: fakeFetch() }), /GOOGLE_VISION_API_KEY/);
});

// ── MODERATION_MODE 설정 점검·분류기 선택 ─────────────────────
test('checkModerationConfig: 로컬은 review-all·auto-approve 허용, 알 수 없는 모드는 거부', () => {
  assert.deepEqual(M.checkModerationConfig({}, { production: false }), []);
  assert.deepEqual(M.checkModerationConfig({ MODERATION_MODE: 'auto-approve' }, { production: false }), []);
  assert.ok(M.checkModerationConfig({ MODERATION_MODE: 'vison' }, { production: false }).some((e) => e.includes('MODERATION_MODE')));
});

test('checkModerationConfig: MODERATION_MODE=vision 인데 GOOGLE_VISION_API_KEY 가 없으면 거부, 있으면 통과', () => {
  for (const production of [true, false]) {
    assert.ok(M.checkModerationConfig({ MODERATION_MODE: 'vision' }, { production }).some((e) => e.includes('GOOGLE_VISION_API_KEY')));
    assert.ok(M.checkModerationConfig({ MODERATION_MODE: 'vision', GOOGLE_VISION_API_KEY: '  ' }, { production }).some((e) => e.includes('GOOGLE_VISION_API_KEY')));
    assert.deepEqual(M.checkModerationConfig({ MODERATION_MODE: 'vision', GOOGLE_VISION_API_KEY: FAKE_KEY }, { production }), []);
  }
});

test('checkModerationConfig: 운영 모드에서 auto-approve 는 거부', () => {
  const errors = M.checkModerationConfig({ MODERATION_MODE: 'auto-approve' }, { production: true });
  assert.ok(errors.some((e) => e.includes('auto-approve')));
});

test('checkModerationConfig: 오류 메시지에 키 값이 들어가지 않는다', () => {
  const errors = M.checkModerationConfig({ MODERATION_MODE: 'nope', GOOGLE_VISION_API_KEY: FAKE_KEY }, { production: true });
  assert.ok(errors.length > 0);
  for (const e of errors) assert.ok(!e.includes(FAKE_KEY));
});

test('createClassifier: 환경변수대로 분류기를 고른다(기본 review-all)', () => {
  assert.equal(M.createClassifier({}).name, 'review-all');
  assert.equal(M.createClassifier({ MODERATION_MODE: 'auto-approve' }).name, 'auto-approve');
  assert.equal(M.createClassifier({ MODERATION_MODE: 'vision', GOOGLE_VISION_API_KEY: FAKE_KEY }, { fetch: fakeFetch() }).name, 'vision');
});
