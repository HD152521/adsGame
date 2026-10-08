// 입력 — 손가락/마우스 "상대 드래그"와 방향키를 논리 좌표의 목표점으로 바꾼다.
//   상대 드래그: 손가락이 움직인 만큼 캐릭터가 움직인다(손가락 밑에 캐릭터를 두지 않아 가려지지 않는다
//   — 죽림고수식 조작). 속도 제한은 game.js(PLAYER_MAX_SPEED)가 건다.
//   실행 검증: apps/ad-dodge 안에서 node --test (view.test.js)

const DRAG_SENSITIVITY = 1.3;
const KEY_REACH = 1000; // 방향키: 그 방향 멀리 목표를 찍어 최고 속도로 이동
const KEY_DIRS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  w: [0, -1],
  s: [0, 1],
};

/** Shift/CapsLock 상태의 대문자 WASD도 같은 방향으로 본다 */
function keyDir(key) {
  return KEY_DIRS[key] || KEY_DIRS[String(key).toLowerCase()];
}

/** startFinger/nowFinger: 화면 CSS px, startPlayer: 논리 좌표, scale: fitView().scale */
function relativeTarget(startFinger, startPlayer, nowFinger, scale) {
  return {
    x: startPlayer.x + ((nowFinger.x - startFinger.x) / scale) * DRAG_SENSITIVITY,
    y: startPlayer.y + ((nowFinger.y - startFinger.y) / scale) * DRAG_SENSITIVITY,
  };
}

function keyboardTarget(player, keys) {
  let dx = 0;
  let dy = 0;
  for (const k of keys) {
    const dir = keyDir(k);
    if (dir) {
      dx += dir[0];
      dy += dir[1];
    }
  }
  if (dx === 0 && dy === 0) return null;
  return { x: player.x + dx * KEY_REACH, y: player.y + dy * KEY_REACH };
}

/** 브라우저 전용. getView() → fitView 결과, getPlayer() → 현재 논리 좌표 */
function createInput(el, getView, getPlayer) {
  let drag = null;
  let enabled = true;
  const keys = new Set();

  const onDown = (e) => {
    // 이미 드래그 중이면 두 번째 손가락은 무시 — 뺏기거나, 그 손가락이 떨어질 때 첫 드래그가 끊기지 않게
    if (drag) return;
    el.setPointerCapture(e.pointerId);
    drag = { pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, startPlayer: { ...getPlayer() }, now: { x: e.clientX, y: e.clientY } };
  };
  const onMove = (e) => {
    if (drag && e.pointerId === drag.pointerId) drag = { ...drag, now: { x: e.clientX, y: e.clientY } };
  };
  const onUp = (e) => {
    if (drag && e.pointerId === drag.pointerId) drag = null;
  };
  const onKeyDown = (e) => {
    // 플레이 중이 아닐 때는 방향키 기본동작(오버레이 스크롤)을 막지 않는다
    if (enabled && keyDir(e.key)) {
      keys.add(e.key);
      e.preventDefault();
    }
  };
  const onKeyUp = (e) => keys.delete(e.key);

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return {
    target() {
      if (drag) return relativeTarget(drag.start, drag.startPlayer, drag.now, getView().scale);
      return keyboardTarget(getPlayer(), keys);
    },
    reset() {
      drag = null;
      keys.clear();
    },
    setEnabled(value) {
      enabled = value;
      if (!value) {
        drag = null;
        keys.clear();
      }
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { DRAG_SENSITIVITY, relativeTarget, keyboardTarget, createInput };
}
