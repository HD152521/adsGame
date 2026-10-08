// game.js 단위 테스트 — 순수 시뮬레이션(시계·RNG 주입, DOM 없음).
//   난이도 곡선은 "재미"를 좌우하므로 봇 생존시간으로 회귀를 막는다:
//   가만히 있는 플레이어는 금방 죽고, 피하는 봇은 확실히 더 오래 산다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const G = require('./game.js');
const { createRng } = require('./rng.js');

const pickFrom = (ids) => (rng) => ids[Math.floor(rng() * ids.length)];

function run({ seed, bot, maxSeconds = 120 }) {
  const rng = createRng(seed);
  let state = G.createGame();
  const pickAdId = pickFrom(['A', 'B', 'C']);
  const maxSteps = Math.round(maxSeconds / G.FIXED_DT);
  for (let i = 0; i < maxSteps && !state.dead; i += 1) {
    state = G.step(state, bot(state), G.FIXED_DT, rng, pickAdId);
  }
  return state;
}

const idleBot = () => null;

// 가장 가까운 발사체 반대 방향으로 도망가되, 벽에 붙지 않게 중앙 쪽으로 약간 끌린다.
function evasiveBot(state) {
  const { player } = state;
  let fx = (G.WORLD_WIDTH / 2 - player.x) * 0.3;
  let fy = (G.WORLD_HEIGHT / 2 - player.y) * 0.3;
  for (const p of state.projectiles) {
    const dx = player.x - p.x;
    const dy = player.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 150 * 150 && d2 > 0) {
      const d = Math.sqrt(d2);
      const w = (150 - d) * 6;
      fx += (dx / d) * w;
      fy += (dy / d) * w;
    }
  }
  return { x: player.x + fx, y: player.y + fy };
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

test('createGame: 플레이어는 화면 중앙, 발사체 없음, 살아있음', () => {
  const s = G.createGame();
  assert.equal(s.player.x, G.WORLD_WIDTH / 2);
  assert.equal(s.player.y, G.WORLD_HEIGHT / 2);
  assert.equal(s.projectiles.length, 0);
  assert.equal(s.dead, false);
  assert.equal(s.killerId, null);
});

test('결정론: 같은 시드·같은 입력이면 같은 결과', () => {
  const a = run({ seed: 5, bot: evasiveBot });
  const b = run({ seed: 5, bot: evasiveBot });
  assert.equal(a.t, b.t);
  assert.equal(a.killerId, b.killerId);
  assert.deepEqual(a.dodged, b.dodged);
});

test('step: 이전 상태를 변경하지 않는다(불변)', () => {
  const rng = createRng(1);
  const s0 = G.createGame();
  const snapshot = JSON.stringify(s0);
  G.step(s0, { x: 10, y: 10 }, G.FIXED_DT, rng, () => 'A');
  assert.equal(JSON.stringify(s0), snapshot);
});

test('step: 죽은 뒤에는 상태가 더 진행되지 않는다', () => {
  const dead = run({ seed: 3, bot: idleBot });
  assert.equal(dead.dead, true);
  const after = G.step(dead, null, G.FIXED_DT, createRng(1), () => 'A');
  assert.equal(after, dead);
});

test('사망 시 killerId는 부딪힌 발사체의 광고주', () => {
  const s = run({ seed: 11, bot: idleBot });
  assert.equal(s.dead, true);
  assert.ok(['A', 'B', 'C'].includes(s.killerId));
});

test('플레이어는 화면 밖으로 나가지 않는다', () => {
  const rng = createRng(1);
  let s = G.createGame();
  for (let i = 0; i < 60; i += 1) s = G.step(s, { x: -9999, y: 99999 }, G.FIXED_DT, rng, () => null);
  assert.ok(s.player.x >= G.PLAYER_RADIUS && s.player.x <= G.WORLD_WIDTH - G.PLAYER_RADIUS);
  assert.ok(s.player.y >= G.PLAYER_RADIUS && s.player.y <= G.WORLD_HEIGHT - G.PLAYER_RADIUS);
});

test('pickAdId가 null이면 발사체를 만들지 않는다(판매 0칸)', () => {
  const rng = createRng(1);
  let s = G.createGame();
  for (let i = 0; i < 600; i += 1) s = G.step(s, null, G.FIXED_DT, rng, () => null);
  assert.equal(s.projectiles.length, 0);
  assert.equal(s.dead, false);
});

test('동시 발사체 수는 MAX_PROJECTILES를 넘지 않는다', () => {
  const rng = createRng(2);
  let s = G.createGame();
  let peak = 0;
  // 절대 안 죽게 무적 모드로 오래 돌린다
  for (let i = 0; i < Math.round(90 / G.FIXED_DT); i += 1) {
    s = G.step({ ...s, dead: false }, evasiveBot(s), G.FIXED_DT, rng, () => 'A', { invincible: true });
    peak = Math.max(peak, s.projectiles.length);
  }
  assert.ok(peak <= G.maxProjectilesAt(90), `peak=${peak}`);
  assert.ok(peak > 5, '발사체가 충분히 쌓여야 한다');
});

test('화면을 가로질러 나간 발사체는 그 광고주의 "피함"으로 집계된다', () => {
  const rng = createRng(4);
  let s = G.createGame();
  for (let i = 0; i < Math.round(20 / G.FIXED_DT); i += 1) {
    s = G.step(s, evasiveBot(s), G.FIXED_DT, rng, () => 'A', { invincible: true });
  }
  assert.ok(s.dodged.A > 0);
});

test('난이도: 시간이 지날수록 스폰 간격은 줄고 속도는 늘어난다', () => {
  assert.ok(G.spawnIntervalAt(0) > G.spawnIntervalAt(15));
  assert.ok(G.spawnIntervalAt(15) > G.spawnIntervalAt(60) || G.spawnIntervalAt(60) === G.SPAWN_INTERVAL_MIN);
  assert.ok(G.speedAt(0) < G.speedAt(30));
  assert.equal(G.speedAt(9999), G.SPEED_CAP);
});

test('난이도 곡선: 가만히 있으면 중앙값 2~15초 안에 죽는다', () => {
  const times = Array.from({ length: 20 }, (_, i) => run({ seed: 100 + i, bot: idleBot }).t);
  const m = median(times);
  assert.ok(m >= 2 && m <= 15, `idle median=${m.toFixed(2)}s`);
});

test('난이도 곡선: 피하는 봇은 가만히 있는 것보다 확실히 오래 산다(중앙값 1.5배 이상)', () => {
  const idle = Array.from({ length: 20 }, (_, i) => run({ seed: 200 + i, bot: idleBot }).t);
  const evasive = Array.from({ length: 20 }, (_, i) => run({ seed: 200 + i, bot: evasiveBot }).t);
  assert.ok(median(evasive) >= median(idle) * 1.5, `idle=${median(idle).toFixed(2)} evasive=${median(evasive).toFixed(2)}`);
});

// ── M4: 보스 발사체 ──────────────────────────────────────────────
test('보스 광고주의 발사체는 더 크고 빠르다(공개 규칙)', () => {
  const rng = createRng(8);
  let s = G.createGame();
  const pickAlt = (() => { let i = 0; return () => (i++ % 2 === 0 ? 'BOSS' : 'N'); })();
  for (let i = 0; i < 200; i += 1) s = G.step(s, null, G.FIXED_DT, rng, pickAlt, { invincible: true, bossId: 'BOSS' });
  const boss = s.projectiles.find((p) => p.advId === 'BOSS');
  const normal = s.projectiles.find((p) => p.advId === 'N');
  assert.ok(boss && normal);
  assert.equal(boss.boss, true);
  assert.equal(boss.r, G.PROJECTILE_RADIUS * G.BOSS_SIZE_MULTIPLIER);
  assert.ok(Math.hypot(boss.vx, boss.vy) > Math.hypot(normal.vx, normal.vy));
});

// ── M3: 가려진 광고는 날아가던 것도 즉시 사라진다 ─────────────────
test('removeAdvertiser: 해당 광고주 발사체만 제거, 원본 불변', () => {
  const s = { ...G.createGame(), projectiles: [{ id: 1, advId: 'A' }, { id: 2, advId: 'B' }] };
  const out = G.removeAdvertiser(s, 'A');
  assert.deepEqual(out.projectiles.map((p) => p.advId), ['B']);
  assert.equal(s.projectiles.length, 2);
});

test('[리뷰 M] keepAdvertisers: 장부에 없는 광고주의 발사체는 제거(재동기화 안전망)', () => {
  const s = { ...G.createGame(), projectiles: [{ id: 1, advId: 'A' }, { id: 2, advId: 'GONE' }, { id: 3, advId: 'B' }] };
  const out = G.keepAdvertisers(s, new Set(['A', 'B']));
  assert.deepEqual(out.projectiles.map((p) => p.advId), ['A', 'B']);
  assert.equal(G.keepAdvertisers(out, new Set(['A', 'B'])), out, '바뀐 게 없으면 같은 객체');
});


// ── 계속 어려워지기 · 적당히 따라오기 ─────────────────────────────
test('[난이도] 40초 이후에도 속도·등장 간격·동시 개수가 계속 어려워진다', () => {
  assert.ok(G.speedAt(60) > G.speedAt(40));
  assert.ok(G.speedAt(120) > G.speedAt(60));
  assert.ok(G.spawnIntervalAt(60) < G.spawnIntervalAt(40));
  assert.ok(G.spawnIntervalAt(120) < G.spawnIntervalAt(60));
  assert.ok(G.maxProjectilesAt(120) > G.maxProjectilesAt(30));
});

test('[난이도] 그래도 상한이 있다(무한히 불가능해지지 않음)', () => {
  assert.equal(G.speedAt(100000), G.SPEED_CAP);
  assert.equal(G.spawnIntervalAt(100000), G.SPAWN_INTERVAL_FLOOR);
  assert.equal(G.maxProjectilesAt(100000), G.MAX_PROJECTILES_CAP);
  assert.ok(G.SPAWN_INTERVAL_FLOOR > 0);
});

test('[추적] 따라오는 힘은 시간이 갈수록 세지지만 상한이 있다', () => {
  assert.ok(G.homingAt(60) > G.homingAt(0));
  assert.equal(G.homingAt(100000), G.HOMING_MAX);
  assert.ok(G.HOMING_MAX <= 1.2, '1초에 70° 이상 꺾이면 유도 미사일');
});

const angleOf = (p) => Math.atan2(p.vy, p.vx);

test('[추적] 플레이어 쪽으로 꺾되, 한 스텝에 homingAt(t)×dt 이상은 못 꺾는다', () => {
  const p = { id: 1, advId: 'A', x: 0, y: 0, vx: 100, vy: 0, r: 18 };
  const player = { x: 0, y: 200 }; // 정확히 90° 옆
  const out = G.steer(p, player, 0.1, 0.8);
  const turned = angleOf(out) - angleOf(p);
  assert.ok(turned > 0, '플레이어 쪽(아래)으로 꺾임');
  assert.ok(turned <= 0.8 * 0.1 + 1e-9, `turned=${turned}`);
  assert.ok(Math.abs(Math.hypot(out.vx, out.vy) - 100) < 1e-6, '속도 크기는 그대로');
});

test('[추적] 이미 플레이어를 지나쳐 멀어지는 광고는 더 꺾지 않는다(빙빙 도는 미사일 방지)', () => {
  const p = { id: 1, advId: 'A', x: 100, y: 0, vx: 100, vy: 0, r: 18 };
  const player = { x: 0, y: 50 }; // 플레이어는 뒤쪽
  const out = G.steer(p, player, 0.1, 0.8);
  assert.equal(out, p);
});

test('[추적] 실제 게임 진행에서도 광고가 직선이 아니라 휜다', () => {
  const rng = createRng(21);
  let s = G.createGame();
  const pick = () => 'A';
  // 첫 광고가 나올 때까지 진행
  while (s.projectiles.length === 0) s = G.step(s, null, G.FIXED_DT, rng, pick, { invincible: true });
  const first = s.projectiles[0];
  const a0 = angleOf(first);
  // 플레이어를 옆으로 크게 이동시키며 진행
  for (let i = 0; i < 30; i += 1) s = G.step(s, { x: 20, y: s.player.y }, G.FIXED_DT, rng, pick, { invincible: true });
  const same = s.projectiles.find((p) => p.id === first.id);
  assert.ok(same, '아직 화면에 있음');
  assert.ok(Math.abs(angleOf(same) - a0) > 0.01, '방향이 바뀌었다');
});

test('[추적] 옆으로 피하는 봇은 여전히 가만히 있는 것보다 확실히 오래 산다(유도 미사일 아님)', () => {
  const idle = Array.from({ length: 20 }, (_, i) => run({ seed: 300 + i, bot: idleBot }).t);
  const evasive = Array.from({ length: 20 }, (_, i) => run({ seed: 300 + i, bot: evasiveBot }).t);
  assert.ok(median(evasive) >= median(idle) * 2, `idle=${median(idle).toFixed(2)} evasive=${median(evasive).toFixed(2)}`);
});
