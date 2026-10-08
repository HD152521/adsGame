// paper.js — "게시판 복사 전단" 질감 도구의 순수 계산 부분.
//   캔버스 그리기는 브라우저 확인 대상이고, 여기서는 결정론(같은 시드 = 같은 모양)과
//   복사기 처리(흑백·대비·계조 단순화)가 규칙대로 되는지만 본다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const P = require('./paper.js');

test('tornEdge: 같은 시드면 같은 뜯김 모양, 다른 시드면 다름', () => {
  const a = P.tornEdge(7, 100, 12);
  const b = P.tornEdge(7, 100, 12);
  const c = P.tornEdge(8, 100, 12);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('tornEdge: 양 끝이 가장자리에 붙고, 높이는 0~depth 안', () => {
  const pts = P.tornEdge(3, 120, 10);
  assert.equal(pts[0].x, 0);
  assert.equal(pts[pts.length - 1].x, 120);
  for (const p of pts) assert.ok(p.y >= 0 && p.y <= 10, `y=${p.y}`);
  for (let i = 1; i < pts.length; i += 1) assert.ok(pts[i].x > pts[i - 1].x, 'x는 오른쪽으로만 증가');
});

test('photocopyPixels: 컬러 → 흑백, 대비 강하게, 계조 단순화(토너 느낌)', () => {
  // 빨강·파랑·연회색·흰색 4픽셀
  const px = new Uint8ClampedArray([230, 30, 30, 255, 20, 60, 200, 255, 200, 200, 200, 255, 255, 255, 255, 255]);
  const out = P.photocopyPixels(px, { levels: 4, contrast: 1.6, seed: 1, grain: 0 });
  for (let i = 0; i < out.length; i += 4) {
    assert.equal(out[i], out[i + 1], '흑백: R=G');
    assert.equal(out[i + 1], out[i + 2], '흑백: G=B');
    assert.equal(out[i + 3], px[i + 3], '투명도는 그대로');
  }
  const values = new Set([out[0], out[4], out[8], out[12]]);
  assert.ok(values.size <= 4, '계조는 levels 이하');
  assert.equal(out[12], P.PAPER_RGB[0], '흰 바탕은 복사지 색으로');
  assert.ok(out[4] < out[8], '어두운 파랑이 연회색보다 진함');
});

test('photocopyPixels: 원본 배열을 바꾸지 않는다', () => {
  const px = new Uint8ClampedArray([100, 150, 200, 255]);
  const copy = Array.from(px);
  P.photocopyPixels(px, { levels: 4, contrast: 1.5, seed: 1, grain: 0 });
  assert.deepEqual(Array.from(px), copy);
});

test('tiltFor: 종이 기울기는 id마다 −3°~+3° 사이로 고정(같은 id는 같은 각도)', () => {
  for (const id of ['a', 'b', 'abc123', '동네치킨']) {
    const t = P.tiltFor(id);
    assert.equal(t, P.tiltFor(id));
    assert.ok(Math.abs(t) <= (3 * Math.PI) / 180 + 1e-9);
  }
  assert.notEqual(P.tiltFor('a'), P.tiltFor('b'));
});

test('shreds: 맞은 자리 주변 종이 조각 3~4개, 결정론', () => {
  const s = P.shreds({ x: 100, y: 200 }, 5);
  assert.ok(s.length >= 3 && s.length <= 4);
  assert.deepEqual(s, P.shreds({ x: 100, y: 200 }, 5));
  for (const piece of s) assert.ok(Math.hypot(piece.x - 100, piece.y - 200) < 60);
});
