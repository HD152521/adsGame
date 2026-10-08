// JSON 파일 저장소 — 일회성 바이럴 규모라 DB 없이 파일 하나로 충분하다.
//   상태는 통째로 교체한다(update(fn) → fn이 새 객체를 돌려줌). 쓰기는 임시 파일 → rename 으로
//   원자적으로 해서 쓰는 도중 죽어도 파일이 반쯤 깨지지 않는다. file=null 이면 메모리 전용(테스트).
//
//   쓰기 두 종류:
//   - 기본(즉시): 주문·입금·검수처럼 돈이 걸린 변경. 응답하기 전에 디스크에 있어야 한다.
//   - lazy: 판 기록·도전장·광고 성과 같은 놀이 기록. 판마다 전체 파일을 쓰면 이벤트 루프가 막히므로
//     LAZY_WRITE_MS 동안 모았다가 한 번에 쓴다(서버가 그 사이 죽으면 그 몇 판만 잃는다 — 허용).
//   실행 검증: apps/ad-dodge 안에서 node --test (server/store.test.js)

const fs = require('node:fs');
const path = require('node:path');

const EMPTY_STATE = Object.freeze({ orders: {}, kills: {}, reports: {}, runs: {}, adStats: {}, challenges: {} });
const LAZY_WRITE_MS = 1000;

function loadState(file) {
  if (!file || !fs.existsSync(file)) return { ...EMPTY_STATE };
  try {
    return { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    // 깨진 파일을 조용히 빈 상태로 덮어쓰면 결제 기록이 사라진다 — 멈추고 사람이 보게 한다
    throw new Error(`저장소 파일을 읽을 수 없습니다: ${file} (${err.message})`);
  }
}

function createStore({ file }) {
  let state = loadState(file);
  let lazyTimer = null;
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  const persist = () => {
    clearTimeout(lazyTimer);
    lazyTimer = null;
    if (!file) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  };

  const persistLater = () => {
    if (!file || lazyTimer) return;
    lazyTimer = setTimeout(() => {
      try {
        persist();
      } catch (err) {
        console.error('[store] 모아 쓰기 실패', err);
      }
    }, LAZY_WRITE_MS);
    lazyTimer.unref();
  };

  return {
    read: () => state,
    /** opts.lazy: 놀이 기록 — 모아서 쓴다. 기본은 즉시(밀린 lazy 변경도 함께 저장됨) */
    update(fn, { lazy = false } = {}) {
      state = fn(state);
      if (lazy) persistLater();
      else persist();
      return state;
    },
    /** 밀린 lazy 변경을 바로 쓴다(종료 직전) */
    flush() {
      if (lazyTimer) persist();
    },
    close() {
      clearTimeout(lazyTimer);
      lazyTimer = null;
    },
  };
}

module.exports = { createStore, LAZY_WRITE_MS };
