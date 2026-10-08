// 게임 시뮬레이션 — 순수 계산기. DOM·타이머·Math.random·Date.now 금지(시계와 RNG는 주입).
//   좌표계는 논리 해상도 WORLD_WIDTH×WORLD_HEIGHT(세로 9:16). 화면 크기에 맞춘 확대는 render.js가 한다.
//   step()은 새 상태 객체를 돌려주고 이전 상태를 변경하지 않는다(game.test.js "불변").
//
//   발사체 = "광고". 화면 가장자리 바깥에서 생겨 플레이어 쪽(+흔들림)으로 직선 비행한다.
//   반대편으로 빠져나가면 그 광고주의 "피함" +1 — 사망 카드 TOP3의 재료.
//   난이도 상수는 재미를 좌우하므로 여기 모아 두고, game.test.js의 봇 생존시간 테스트로 회귀를 막는다.
//   실행 검증: apps/ad-dodge 안에서 node --test (game.test.js)

const WORLD_WIDTH = 360;
const WORLD_HEIGHT = 640;
const FIXED_DT = 1 / 60;

const PLAYER_RADIUS = 12;
const PLAYER_MAX_SPEED = 900; // 손가락을 순간이동시켜도 캐릭터는 이 속도로만 따라간다
const PROJECTILE_RADIUS = 18;
const HITBOX_FORGIVENESS = 0.75; // 로고 가장자리 스침은 봐준다 — 억울한 죽음이 공유를 막는다

// ── 난이도: 0~RAMP_SECONDS는 빠르게, 그 뒤 "연장전"은 천천히 계속 어려워지고 상한에서 멈춘다 ──
const SPAWN_INTERVAL_START = 0.9;
const SPAWN_INTERVAL_MIN = 0.2;     // 연장전 시작 시점(RAMP_SECONDS)의 등장 간격
const SPAWN_INTERVAL_FLOOR = 0.11;  // 아무리 버텨도 이보다 촘촘하진 않다
const SPAWN_OVERTIME_DECAY = 0.985; // 연장전 1초마다 등장 간격 ×0.985
const SPEED_START = 150;
const SPEED_MAX = 330;              // 연장전 시작 시점 속도
const SPEED_OVERTIME_PER_SEC = 2.2; // 연장전 1초마다 +2.2
const SPEED_CAP = 470;
const RAMP_SECONDS = 40; // 이 시간에 걸쳐 시작값 → 연장전 시작값으로 선형 증가
const AIM_JITTER = 0.35; // 라디안. 0이면 전부 정조준이라 가만히 있으면 즉사, 크면 긴장감이 없다
const MAX_PROJECTILES = 40;      // 연장전 전 동시 개수 상한(저사양 폰 프레임 방어)
const MAX_PROJECTILES_CAP = 60;
const MAX_PROJECTILES_STEP_SECONDS = 15; // 연장전 15초마다 +5개

// ── 추적: "적당히 따라오기". 1초에 꺾을 수 있는 각도(rad/s)에 상한을 두고,
//    플레이어를 지나친 뒤에는 더 꺾지 않는다 → 옆으로 피하면 흘러간다(유도 미사일 아님).
const HOMING_START = 0.25;  // rad/s ≈ 14°/s — 처음엔 살짝 휘는 정도
const HOMING_MAX = 0.85;    // rad/s ≈ 49°/s — 아무리 늦게 가도 이 이상은 안 꺾음
const HOMING_RAMP_SECONDS = 90;
const BOSS_SIZE_MULTIPLIER = 1.6; // 지분 1위 광고주(shares.js findBossId) — 공개 규칙
const BOSS_SPEED_MULTIPLIER = 1.25;
const SPAWN_MARGIN = 30;
const DESPAWN_MARGIN = 60;

function ramp(t) {
  return Math.min(1, t / RAMP_SECONDS);
}

function overtime(t) {
  return Math.max(0, t - RAMP_SECONDS);
}

function spawnIntervalAt(t) {
  if (t <= RAMP_SECONDS) return SPAWN_INTERVAL_START + (SPAWN_INTERVAL_MIN - SPAWN_INTERVAL_START) * ramp(t);
  return Math.max(SPAWN_INTERVAL_FLOOR, SPAWN_INTERVAL_MIN * SPAWN_OVERTIME_DECAY ** overtime(t));
}

function speedAt(t) {
  if (t <= RAMP_SECONDS) return SPEED_START + (SPEED_MAX - SPEED_START) * ramp(t);
  return Math.min(SPEED_CAP, SPEED_MAX + SPEED_OVERTIME_PER_SEC * overtime(t));
}

function maxProjectilesAt(t) {
  return Math.min(MAX_PROJECTILES_CAP, MAX_PROJECTILES + 5 * Math.floor(overtime(t) / MAX_PROJECTILES_STEP_SECONDS));
}

function homingAt(t) {
  return HOMING_START + (HOMING_MAX - HOMING_START) * Math.min(1, t / HOMING_RAMP_SECONDS);
}

/**
 * 플레이어 쪽으로 최대 rate×dt 라디안만 꺾는다(속도 크기는 유지).
 * 이미 플레이어를 지나쳐 멀어지는 중이면(진행 방향·플레이어 방향 내적 < 0) 그대로 둔다.
 */
function steer(p, player, dt, rate) {
  const dx = player.x - p.x;
  const dy = player.y - p.y;
  if (dx * p.vx + dy * p.vy < 0) return p;
  const current = Math.atan2(p.vy, p.vx);
  let diff = Math.atan2(dy, dx) - current;
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  const maxTurn = rate * dt;
  const angle = current + clamp(diff, -maxTurn, maxTurn);
  const speed = Math.hypot(p.vx, p.vy);
  return { ...p, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed };
}

function createGame() {
  return {
    t: 0,
    spawnTimer: SPAWN_INTERVAL_START * 0.5, // 첫 광고는 조금 빨리 — 룰을 바로 보여준다
    player: { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 },
    projectiles: [],
    nextId: 1,
    dead: false,
    killerId: null,
    dodged: {},
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function movePlayer(player, target, dt) {
  if (!target) return player;
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  const dist = Math.hypot(dx, dy);
  const maxStep = PLAYER_MAX_SPEED * dt;
  const k = dist > maxStep ? maxStep / dist : 1;
  return {
    x: clamp(player.x + dx * k, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS),
    y: clamp(player.y + dy * k, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS),
  };
}

/** 화면 둘레(바깥 SPAWN_MARGIN) 위의 임의 지점 */
function edgePoint(rng) {
  const w = WORLD_WIDTH + SPAWN_MARGIN * 2;
  const h = WORLD_HEIGHT + SPAWN_MARGIN * 2;
  let d = rng() * (w * 2 + h * 2);
  if (d < w) return { x: d - SPAWN_MARGIN, y: -SPAWN_MARGIN };
  d -= w;
  if (d < h) return { x: WORLD_WIDTH + SPAWN_MARGIN, y: d - SPAWN_MARGIN };
  d -= h;
  if (d < w) return { x: d - SPAWN_MARGIN, y: WORLD_HEIGHT + SPAWN_MARGIN };
  d -= w;
  return { x: -SPAWN_MARGIN, y: d - SPAWN_MARGIN };
}

function spawnProjectile(state, rng, advId, isBoss) {
  const from = edgePoint(rng);
  const aim = Math.atan2(state.player.y - from.y, state.player.x - from.x) + (rng() * 2 - 1) * AIM_JITTER;
  const speed = speedAt(state.t) * (isBoss ? BOSS_SPEED_MULTIPLIER : 1);
  return {
    id: state.nextId,
    advId,
    boss: isBoss,
    x: from.x,
    y: from.y,
    vx: Math.cos(aim) * speed,
    vy: Math.sin(aim) * speed,
    r: PROJECTILE_RADIUS * (isBoss ? BOSS_SIZE_MULTIPLIER : 1),
  };
}

function isGone(p) {
  return (
    p.x < -DESPAWN_MARGIN ||
    p.x > WORLD_WIDTH + DESPAWN_MARGIN ||
    p.y < -DESPAWN_MARGIN ||
    p.y > WORLD_HEIGHT + DESPAWN_MARGIN
  );
}

function hits(player, p) {
  const reach = PLAYER_RADIUS + p.r * HITBOX_FORGIVENESS;
  const dx = player.x - p.x;
  const dy = player.y - p.y;
  return dx * dx + dy * dy < reach * reach;
}

/**
 * 한 스텝 진행.
 * @param state 이전 상태(변경하지 않음)
 * @param target {x,y} | null — 플레이어가 향할 논리 좌표
 * @param pickAdId (rng) => advId | null — null이면 이번 스폰은 건너뛴다(판매 0칸)
 * @param opts { bossId?: string, invincible?: boolean(테스트 전용) }
 */
function step(state, target, dt, rng, pickAdId, opts = {}) {
  if (state.dead) return state;
  const t = state.t + dt;
  const player = movePlayer(state.player, target, dt);

  let spawnTimer = state.spawnTimer - dt;
  let nextId = state.nextId;
  const spawned = [];
  if (spawnTimer <= 0) {
    spawnTimer += spawnIntervalAt(t);
    const advId = state.projectiles.length < maxProjectilesAt(t) ? pickAdId(rng) : null;
    if (advId !== null && advId !== undefined) {
      spawned.push(spawnProjectile({ ...state, t, player, nextId }, rng, advId, advId === opts.bossId));
      nextId += 1;
    }
  }

  const dodged = { ...state.dodged };
  const projectiles = [];
  let killerId = null;
  const homing = homingAt(t);
  for (const p of [...state.projectiles, ...spawned]) {
    const steered = steer(p, player, dt, homing);
    const moved = { ...steered, x: steered.x + steered.vx * dt, y: steered.y + steered.vy * dt };
    if (isGone(moved)) {
      dodged[moved.advId] = (dodged[moved.advId] || 0) + 1;
      continue;
    }
    if (killerId === null && !opts.invincible && hits(player, moved)) killerId = moved.advId;
    projectiles.push(moved);
  }

  return {
    t,
    spawnTimer,
    player,
    projectiles,
    nextId,
    dead: killerId !== null,
    killerId,
    dodged,
  };
}

/** 신고로 가려진 광고는 이미 날아가던 것도 즉시 사라진다(PRD MVP 10) */
function removeAdvertiser(state, advId) {
  return { ...state, projectiles: state.projectiles.filter((p) => p.advId !== advId) };
}

/** 장부 재동기화 안전망 — 유실된 takedown 이벤트가 있어도 장부에 없는 광고는 화면에서 사라진다 */
function keepAdvertisers(state, idSet) {
  const kept = state.projectiles.filter((p) => idSet.has(p.advId));
  return kept.length === state.projectiles.length ? state : { ...state, projectiles: kept };
}

if (typeof module !== 'undefined') {
  module.exports = {
    removeAdvertiser,
    keepAdvertisers,
    WORLD_WIDTH,
    WORLD_HEIGHT,
    FIXED_DT,
    PLAYER_RADIUS,
    PROJECTILE_RADIUS,
    BOSS_SIZE_MULTIPLIER,
    MAX_PROJECTILES,
    MAX_PROJECTILES_CAP,
    SPAWN_INTERVAL_MIN,
    SPAWN_INTERVAL_FLOOR,
    SPEED_MAX,
    SPEED_CAP,
    HOMING_MAX,
    spawnIntervalAt,
    speedAt,
    maxProjectilesAt,
    homingAt,
    steer,
    createGame,
    step,
  };
}
