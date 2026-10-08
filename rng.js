// 시드 고정 PRNG(mulberry32) — 게임 시뮬레이션과 광고주 추첨을 테스트에서 재현 가능하게 만든다.
//   브라우저에서는 app.js가 매 판 새 시드(Date.now 등)로 만들어 주입한다. game.js·shares.js는
//   Math.random을 직접 부르지 않는다.
//   실행 검증: apps/ad-dodge 안에서 node --test (rng.test.js)

/** @param {number} seed 32비트 정수로 잘린다 @returns {() => number} [0, 1) */
function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createRng };
}
