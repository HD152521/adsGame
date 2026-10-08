// JSON 파일 저장소 — 일회성 바이럴 규모(수백~수천 건)라 DB 없이 파일 하나로 충분하다.
//   상태는 통째로 교체한다(update(fn) → fn이 새 객체를 돌려줌). 쓰기는 임시 파일 → rename 으로
//   원자적으로 해서 쓰는 도중 죽어도 파일이 반쯤 깨지지 않는다. file=null 이면 메모리 전용(테스트).

const fs = require('node:fs');
const path = require('node:path');

const EMPTY_STATE = Object.freeze({ orders: {}, kills: {}, reports: {} });

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
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  const persist = () => {
    if (!file) return;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  };

  return {
    read: () => state,
    update(fn) {
      state = fn(state);
      persist();
      return state;
    },
  };
}

module.exports = { createStore };
