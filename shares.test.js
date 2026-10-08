// shares.js 단위 테스트 — 의존성 없음, Node 내장 러너.
//   "광고주 확률 = 보유 칸 ÷ 판매된 전체 칸"(PRD 핵심 규칙)이 표시값과 실제 추첨 양쪽에서
//   정확히 지켜지는지 검증한다. 표시 지분과 실제 확률이 어긋나면 기만 논란(PRD Risks)이 되므로
//   통계 테스트로 직접 확인한다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SLOT_PRICE,
  MAX_SLOTS,
  validateLedger,
  computeShares,
  totalSoldSlots,
  pickAdvertiser,
  formatSharePercent,
} = require('./shares.js');
const { createRng } = require('./rng.js');

const entry = (id, slots, name = id) => ({ id, name, slots });

test('상수: 1칸 1,000원, 최대 1,000,000칸', () => {
  assert.equal(SLOT_PRICE, 1000);
  assert.equal(MAX_SLOTS, 1000000);
});

test('computeShares: A 10칸 / B 10칸 → 각 50%', () => {
  const shares = computeShares([entry('A', 10), entry('B', 10)]);
  assert.equal(shares.length, 2);
  for (const s of shares) assert.equal(s.share, 0.5);
});

test('computeShares: 같은 광고주의 여러 구매는 합산된다', () => {
  const shares = computeShares([entry('A', 3), entry('B', 10), entry('A', 7)]);
  const a = shares.find((s) => s.id === 'A');
  assert.equal(a.slots, 10);
  assert.equal(a.share, 0.5);
});

test('computeShares: 지분 내림차순 정렬, 입력 배열을 변경하지 않는다', () => {
  const ledger = [entry('A', 1), entry('B', 3)];
  const frozen = JSON.stringify(ledger);
  const shares = computeShares(ledger);
  assert.deepEqual(shares.map((s) => s.id), ['B', 'A']);
  assert.equal(JSON.stringify(ledger), frozen);
});

test('쪼개기 무이득: 10칸 1건과 1칸 10건의 지분이 같다', () => {
  const bulk = computeShares([entry('A', 10), entry('B', 30)]);
  const split = computeShares([...Array.from({ length: 10 }, () => entry('A', 1)), entry('B', 30)]);
  assert.equal(bulk.find((s) => s.id === 'A').share, split.find((s) => s.id === 'A').share);
});

test('totalSoldSlots: 판매된 칸 합계', () => {
  assert.equal(totalSoldSlots([entry('A', 3), entry('B', 4)]), 7);
});

test('validateLedger: 정수 1칸 이상만 허용', () => {
  for (const bad of [0, -1, 1.5, NaN, '3', null]) {
    assert.throws(() => validateLedger([entry('A', bad)]), /칸/);
  }
});

test('validateLedger: id 없는 항목 거부', () => {
  assert.throws(() => validateLedger([{ name: 'x', slots: 1 }]), /id/);
});

test('validateLedger: 합계가 MAX_SLOTS를 넘으면 거부, 정확히 MAX_SLOTS는 허용', () => {
  assert.doesNotThrow(() => validateLedger([entry('A', MAX_SLOTS)]));
  assert.throws(() => validateLedger([entry('A', MAX_SLOTS), entry('B', 1)]), /1,000,000/);
});

test('computeShares: 빈 장부는 빈 배열(0으로 나누지 않는다)', () => {
  assert.deepEqual(computeShares([]), []);
});

test('pickAdvertiser: 빈 지분이면 null', () => {
  assert.equal(pickAdvertiser([], createRng(1)), null);
});

test('pickAdvertiser: 10만 회 추첨 빈도가 지분과 ±1%p 이내', () => {
  const shares = computeShares([entry('A', 50), entry('B', 30), entry('C', 15), entry('D', 5)]);
  const rng = createRng(12345);
  const counts = {};
  const N = 100000;
  for (let i = 0; i < N; i += 1) {
    const picked = pickAdvertiser(shares, rng);
    counts[picked.id] = (counts[picked.id] || 0) + 1;
  }
  for (const s of shares) {
    const observed = counts[s.id] / N;
    assert.ok(Math.abs(observed - s.share) < 0.01, `${s.id}: 기대 ${s.share}, 관측 ${observed}`);
  }
});

test('pickAdvertiser: 지분이 아주 작은 광고주(1칸)도 뽑힐 수 있다', () => {
  const shares = computeShares([entry('BIG', 999), entry('TINY', 1)]);
  const rng = createRng(7);
  let seen = false;
  for (let i = 0; i < 20000 && !seen; i += 1) seen = pickAdvertiser(shares, rng).id === 'TINY';
  assert.ok(seen);
});

test('formatSharePercent: 소수 지분 표시', () => {
  assert.equal(formatSharePercent(0.5), '50%');
  assert.equal(formatSharePercent(0.12345), '12.35%');
  assert.equal(formatSharePercent(0.00001), '0.001%');
  assert.equal(formatSharePercent(0), '0%');
});

// ── M4: 보스 · 친구 저격 ─────────────────────────────────────────
const { findBossId, createPicker, SNIPE_RATE } = require('./shares.js');

test('findBossId: 하우스 제외 최다 칸 광고주', () => {
  const shares = computeShares([
    { id: 'H', name: 'h', slots: 100, isHouse: true },
    { id: 'A', name: 'a', slots: 5, firstPaidAt: 2 },
    { id: 'B', name: 'b', slots: 9, firstPaidAt: 3 },
  ]);
  assert.equal(findBossId(shares), 'B');
});

test('findBossId: 동률이면 먼저 결제한 광고주', () => {
  const shares = computeShares([
    { id: 'A', name: 'a', slots: 5, firstPaidAt: 20 },
    { id: 'B', name: 'b', slots: 5, firstPaidAt: 10 },
  ]);
  assert.equal(findBossId(shares), 'B');
});

test('findBossId: 유료 광고주가 없으면 null(하우스는 보스가 되지 않는다)', () => {
  assert.equal(findBossId(computeShares([{ id: 'H', name: 'h', slots: 1, isHouse: true }])), null);
});

test('createPicker: 저격 없으면 지분 그대로', () => {
  const shares = computeShares([entry('A', 1), entry('B', 3)]);
  const pick = createPicker(shares, null);
  const rng = createRng(3);
  let b = 0;
  const N = 40000;
  for (let i = 0; i < N; i += 1) if (pick(rng) === 'B') b += 1;
  assert.ok(Math.abs(b / N - 0.75) < 0.01);
});

test('createPicker: 저격 링크 판은 공개 규칙(SNIPE_RATE)만큼 저격 광고, 나머지는 지분대로', () => {
  const shares = computeShares([entry('A', 1), entry('B', 1), entry('S', 1)]);
  const pick = createPicker(shares, 'S');
  const rng = createRng(9);
  const N = 60000;
  let s = 0;
  for (let i = 0; i < N; i += 1) if (pick(rng) === 'S') s += 1;
  const expected = SNIPE_RATE + (1 - SNIPE_RATE) / 3;
  assert.ok(Math.abs(s / N - expected) < 0.01, `${s / N} vs ${expected}`);
});

test('createPicker: 장부에 없는(가려진) 저격 id는 무시한다', () => {
  const shares = computeShares([entry('A', 1)]);
  const pick = createPicker(shares, 'GONE');
  const rng = createRng(1);
  for (let i = 0; i < 100; i += 1) assert.equal(pick(rng), 'A');
});

test('createPicker: 빈 장부면 null', () => {
  assert.equal(createPicker([], null)(createRng(1)), null);
});
