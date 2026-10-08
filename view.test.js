// render.js(fitView)·input.js(relativeTarget, keyboardTarget)·app.js(screenTransition)의 순수 함수 테스트.
//   캔버스 실제 그리기는 브라우저 수동 확인 대상. 여기서는 좌표 변환과 화면 전이 규칙만 본다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fitView, drawFrame, SLIP_SIDE_PER_RADIUS } = require('./render.js');
const { relativeTarget, keyboardTarget, DRAG_SENSITIVITY } = require('./input.js');
const { screenTransition } = require('./app.js');
const G = require('./game.js');

test('fitView: 세로 폰(390×844)은 가로를 꽉 채우고 세로 가운데 정렬', () => {
  const v = fitView(390, 844);
  assert.equal(v.scale, 390 / G.WORLD_WIDTH);
  assert.equal(v.offsetX, 0);
  assert.ok(v.offsetY > 0);
  assert.equal(Math.round(v.offsetY * 2 + G.WORLD_HEIGHT * v.scale), 844);
});

test('fitView: 가로로 넓은 데스크톱은 세로를 꽉 채우고 가로 가운데 정렬', () => {
  const v = fitView(1440, 900);
  assert.equal(v.scale, 900 / G.WORLD_HEIGHT);
  assert.equal(v.offsetY, 0);
  assert.ok(v.offsetX > 0);
});

test('relativeTarget: 손가락 이동량(화면px)을 논리 좌표로 환산해 시작 위치에 더한다', () => {
  const t = relativeTarget({ x: 100, y: 100 }, { x: 180, y: 320 }, { x: 120, y: 90 }, 2);
  assert.deepEqual(t, { x: 180 + (20 / 2) * DRAG_SENSITIVITY, y: 320 + (-10 / 2) * DRAG_SENSITIVITY });
});

test('keyboardTarget: 방향키가 없으면 null, 있으면 그 방향으로 멀리', () => {
  const p = { x: 100, y: 100 };
  assert.equal(keyboardTarget(p, new Set()), null);
  const right = keyboardTarget(p, new Set(['ArrowRight']));
  assert.ok(right.x > p.x && right.y === p.y);
  const upLeft = keyboardTarget(p, new Set(['ArrowUp', 'ArrowLeft']));
  assert.ok(upLeft.x < p.x && upLeft.y < p.y);
});

test('screenTransition: 시작 → 플레이 → 사망 → 다시하기', () => {
  assert.equal(screenTransition('start', 'play'), 'playing');
  assert.equal(screenTransition('playing', 'die'), 'dead');
  assert.equal(screenTransition('dead', 'retry'), 'playing');
});

test('screenTransition: 허용되지 않은 이벤트는 화면을 유지한다', () => {
  assert.equal(screenTransition('start', 'die'), 'start');
  assert.equal(screenTransition('dead', 'die'), 'dead');
  assert.equal(screenTransition('playing', 'play'), 'playing');
});

function recordingCtx(calls) {
  const props = ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'globalAlpha', 'shadowColor', 'shadowOffsetY', 'shadowBlur', 'lineCap', 'lineJoin'];
  return new Proxy({}, {
    get: (_, prop) => (typeof prop === 'string' && !props.includes(prop) ? (...args) => calls.push({ prop, args }) : undefined),
    set: () => true,
  });
}

test('drawFrame: 쪽지(캐시된 이미지)를 발사체마다 한 번씩, 정사각형으로 그린다', () => {
  const calls = [];
  const state = {
    ...G.createGame(),
    projectiles: [
      { id: 1, advId: 'A', x: 10, y: 10, r: 18 },
      { id: 2, advId: 'B', x: 50, y: 50, r: 18, boss: true },
    ],
  };
  const sprite = { tag: 'sprite' };
  const logos = new Map([['A', { id: 'A', sprite }], ['B', { id: 'B', sprite }]]);
  drawFrame(recordingCtx(calls), state, { scale: 1, offsetX: 0, offsetY: 0, width: 360, height: 640 }, logos);
  const draws = calls.filter((c) => c.prop === 'drawImage');
  assert.equal(draws.length, 2);
  for (const d of draws) assert.equal(d.args[3], d.args[4], '정사각형');
  assert.equal(draws[0].args[3], 18 * SLIP_SIDE_PER_RADIUS);
  assert.ok(calls.some((c) => c.prop === 'ellipse'), '보스는 빨간 매직 동그라미');
});

test('drawFrame: 쪽지 한 변은 원형 충돌 지름보다 작지 않고, 반대각선은 반지름의 1.2배 이내(억울함 방지)', () => {
  const halfDiagonal = (SLIP_SIDE_PER_RADIUS / 2) * Math.SQRT2;
  assert.ok(SLIP_SIDE_PER_RADIUS >= 1.5);
  assert.ok(halfDiagonal <= 1.2, `${halfDiagonal}`);
});

test('drawFrame: 죽으면 종이 조각이 흩어진다', () => {
  const calls = [];
  const state = { ...G.createGame(), dead: true, killerId: 'A' };
  drawFrame(recordingCtx(calls), state, { scale: 1, offsetX: 0, offsetY: 0, width: 360, height: 640 }, new Map());
  assert.ok(calls.filter((c) => c.prop === 'closePath').length >= 3);
});

// ── 코드 리뷰 반영 ────────────────────────────────────────────────

function fakeTarget() {
  const handlers = {};
  return {
    handlers,
    addEventListener: (type, fn) => { handlers[type] = fn; },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  };
}

function withFakeWindow(fn) {
  const prev = global.window;
  global.window = fakeTarget();
  try { return fn(global.window); } finally { global.window = prev; }
}

const pointer = (pointerId, x, y) => ({ pointerId, clientX: x, clientY: y });

test('[HIGH] 두 번째 손가락이 닿아도 첫 손가락 드래그를 뺏거나 끊지 않는다', () => {
  withFakeWindow(() => {
    const { createInput } = require('./input.js');
    const el = fakeTarget();
    const input = createInput(el, () => ({ scale: 1 }), () => ({ x: 100, y: 100 }));
    el.handlers.pointerdown(pointer(1, 0, 0));
    el.handlers.pointermove(pointer(1, 10, 0));
    el.handlers.pointerdown(pointer(2, 500, 500)); // 실수로 닿은 두 번째 손가락
    el.handlers.pointerup(pointer(2, 500, 500));
    el.handlers.pointermove(pointer(1, 20, 0));
    const t = input.target();
    assert.ok(t, '첫 손가락 드래그가 살아 있어야 한다');
    assert.equal(t.x, 100 + 20 * DRAG_SENSITIVITY);
  });
});

test('[MEDIUM] 입력이 비활성(플레이 중 아님)이면 방향키 기본동작(스크롤)을 막지 않는다', () => {
  withFakeWindow((win) => {
    const { createInput } = require('./input.js');
    const input = createInput(fakeTarget(), () => ({ scale: 1 }), () => ({ x: 0, y: 0 }));
    let prevented = false;
    input.setEnabled(false);
    win.handlers.keydown({ key: 'ArrowDown', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
    input.setEnabled(true);
    win.handlers.keydown({ key: 'ArrowDown', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  });
});

test('[LOW] 대문자 WASD(Shift/CapsLock)도 이동한다', () => {
  const t = keyboardTarget({ x: 0, y: 0 }, new Set(['D']));
  assert.ok(t && t.x > 0);
});

test('[M2] screenTransition: 구매 화면 진입/복귀, 사망 → 홈', () => {
  assert.equal(screenTransition('start', 'buy'), 'buying');
  assert.equal(screenTransition('buying', 'close'), 'start');
  assert.equal(screenTransition('dead', 'buy'), 'buying');
  assert.equal(screenTransition('dead', 'home'), 'start');
  assert.equal(screenTransition('playing', 'buy'), 'playing', '플레이 중에는 구매 화면으로 가지 않는다');
});

test('[M2] ledgerFromSeed: 서버 없을 때 장부 — 하우스는 판매 칸 0, 로고 경로 유지', () => {
  const { ledgerFromSeed } = require('./app.js');
  const { SEED_LEDGER } = require('./seed-ledger.js');
  const ledger = ledgerFromSeed(SEED_LEDGER);
  assert.equal(ledger.soldSlots, 0);
  assert.equal(ledger.bossId, null);
  assert.ok(ledger.advertisers.every((a) => a.logoUrl && a.share > 0));
});

test('[이동 주소] redirectTarget: 죽인 광고의 http(s) 주소만, 없거나 이상하면 null', () => {
  const { redirectTarget } = require('./app.js');
  const ledger = { advertisers: [{ id: 'A', landingUrl: 'https://a.example/' }, { id: 'B', landingUrl: null }, { id: 'C', landingUrl: 'javascript:alert(1)' }] };
  assert.equal(redirectTarget('A', ledger), 'https://a.example/');
  assert.equal(redirectTarget('B', ledger), null);
  assert.equal(redirectTarget('C', ledger), null, '서버가 걸러도 클라이언트에서 한 번 더');
  assert.equal(redirectTarget('ZZ', ledger), null);
});

test('[고도화] drawFrame: 아슬아슬하면 "휙!", 웨이브 직전엔 "전단 살포 주의!"', () => {
  const calls = [];
  const state = { ...G.createGame(), t: 10, fx: [{ kind: 'whoosh', x: 100, y: 100, t: 9.9 }], waveWarning: true };
  drawFrame(recordingCtx(calls), state, { scale: 1, offsetX: 0, offsetY: 0, width: 360, height: 640 }, new Map());
  const texts = calls.filter((c) => c.prop === 'fillText').map((c) => c.args[0]);
  assert.ok(texts.includes('휙!'), texts.join(','));
  assert.ok(texts.includes('전단 살포 주의!'), texts.join(','));
});
