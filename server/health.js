// 헬스체크 — 호스팅(fly)이 15초마다 GET /api/health 를 두드린다.
//   "프로세스가 살아 있다"가 아니라 "장부(db.json)를 실제로 읽을 수 있다"까지 본다 — 볼륨이 안 붙었거나
//   장부가 깨졌으면 결제 기록을 못 쓰는 상태라 503 으로 알린다.
//   장부가 아직 없으면(새 볼륨, 첫 주문 전) 데이터 폴더에 쓸 수 있는지만 본다.
//   응답에는 ok 여부만 — 경로·오류 원문·비밀값은 서버 로그에만 남긴다.
//   실행 검증: apps/ad-dodge 안에서 node --test (server/health.test.js)

const fs = require('node:fs');
const path = require('node:path');

/** 장부 점검 → { ok: true } | { ok: false, reason } (reason 은 서버 로그용 — 응답에 싣지 않는다) */
async function checkLedger(dataDir) {
  const file = path.join(dataDir, 'db.json');
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    JSON.parse(raw);
    return { ok: true };
  } catch (err) {
    if (err.code !== 'ENOENT') return { ok: false, reason: `장부 읽기 실패: ${err.message}` };
  }
  try {
    await fs.promises.access(dataDir, fs.constants.R_OK | fs.constants.W_OK);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `데이터 폴더 접근 실패: ${err.message}` };
  }
}

module.exports = { checkLedger };
