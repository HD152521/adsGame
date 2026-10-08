// rng.js 단위 테스트 — 게임 시뮬레이션·추첨 테스트가 결정론적이려면 시드 PRNG가 재현 가능해야 한다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRng } = require('./rng.js');

test('같은 시드는 같은 수열', () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 100; i += 1) assert.equal(a(), b());
});

test('다른 시드는 다른 수열', () => {
  const a = createRng(1);
  const b = createRng(2);
  const seqA = Array.from({ length: 10 }, a);
  const seqB = Array.from({ length: 10 }, b);
  assert.notDeepEqual(seqA, seqB);
});

test('값은 [0, 1) 범위, 평균은 0.5 근처', () => {
  const rng = createRng(99);
  let sum = 0;
  const N = 50000;
  for (let i = 0; i < N; i += 1) {
    const v = rng();
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / N - 0.5) < 0.01);
});
