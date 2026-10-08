// moderation.js — 광고 이름·이미지 1차 검수(PRD MVP 10·11). 외부 AI 필터는 classifier로 꽂는다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('./moderation.js');

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('validateName: 앞뒤 공백 제거 후 1~16자', () => {
  assert.equal(M.validateName('  치킨집  ').name, '치킨집');
  assert.match(M.validateName('   ').error, /이름/);
  assert.match(M.validateName('가'.repeat(17)).error, /16자/);
  assert.equal(M.validateName('가'.repeat(16)).name, '가'.repeat(16));
});

test('validateName: URL·전화번호는 거부(광고 지면 밖 유도 금지)', () => {
  for (const bad of ['www.abc.com', 'http://x.io', 'abc.kr', '010-1234-5678', '01012345678']) {
    assert.ok(M.validateName(bad).error, bad);
  }
});

test('validateName: 욕설은 띄어쓰기·특수문자로 우회해도 거부', () => {
  for (const bad of ['시발', '씨 발', 'ㅅ.ㅂ', '병-신', '개새끼네']) {
    assert.ok(M.validateName(bad).error, bad);
  }
});

test('validateName: 제어문자 거부', () => {
  assert.ok(M.validateName('abc\u0000').error);
  assert.ok(M.validateName('a‮b').error, 'RTL override');
});

test('decodeImage: PNG data URL → buffer·mime·ext', () => {
  const img = M.decodeImage(PNG_1PX);
  assert.equal(img.mime, 'image/png');
  assert.equal(img.ext, 'png');
  assert.ok(img.buffer.length > 0);
});

test('decodeImage: SVG는 거부(스크립트 삽입 위험)', () => {
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;
  assert.match(M.decodeImage(svg).error, /PNG|JPG|WEBP/);
});

test('decodeImage: 선언한 형식과 실제 바이트가 다르면 거부', () => {
  const fake = `data:image/png;base64,${Buffer.from('GIF89a....').toString('base64')}`;
  assert.ok(M.decodeImage(fake).error);
});

test('decodeImage: 크기 상한 초과 거부', () => {
  const big = Buffer.alloc(M.MAX_IMAGE_BYTES + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
  assert.match(M.decodeImage(`data:image/png;base64,${big.toString('base64')}`).error, /KB/);
});

test('reviewAllClassifier: 이미지는 관리자 검토로, 이미지 없는 텍스트 광고는 승인', async () => {
  const c = M.reviewAllClassifier();
  assert.equal(await c.classify({ image: { mime: 'image/png', buffer: Buffer.alloc(1) } }), 'review');
  assert.equal(await c.classify({ image: null }), 'approve');
});

test('autoApproveClassifier: 로컬 데모용 — 전부 승인', async () => {
  assert.equal(await M.autoApproveClassifier().classify({ image: { mime: 'image/png', buffer: Buffer.alloc(1) } }), 'approve');
});

// ── 광고주 이동 주소(죽으면 즉시 이동) ───────────────────────────
test('validateLandingUrl: 비어 있으면 없음(선택 항목)', () => {
  assert.deepEqual(M.validateLandingUrl(''), { url: null });
  assert.deepEqual(M.validateLandingUrl(undefined), { url: null });
});

test('validateLandingUrl: http/https만, 정규화된 주소를 돌려준다', () => {
  assert.equal(M.validateLandingUrl('https://chicken.example/menu?a=1').url, 'https://chicken.example/menu?a=1');
  assert.equal(M.validateLandingUrl('  http://a.kr  ').url, 'http://a.kr/');
  assert.equal(M.validateLandingUrl('치킨.kr').url, 'https://xn--v96bi6b.kr/', '스킴 없으면 https로');
});

test('validateLandingUrl: 스크립트·데이터·계정정보·내부망 주소는 거부', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x', 'https://user:pw@evil.example', 'http://localhost:3000', 'http://127.0.0.1', 'http://192.168.0.1', 'ftp://a.kr', 'https://', `https://a.kr/${'x'.repeat(400)}`]) {
    assert.ok(M.validateLandingUrl(bad).error, bad);
  }
});

test('reviewAllClassifier: 이동 주소가 있는 광고는 텍스트라도 관리자 검토', async () => {
  const c = M.reviewAllClassifier();
  assert.equal(await c.classify({ image: null, landingUrl: 'https://a.kr/' }), 'review');
  assert.equal(await c.classify({ image: null, landingUrl: null }), 'approve');
});
