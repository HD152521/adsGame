// 장부(db.json) 주기 백업 — 결제 기록이 든 유일한 파일이라, 망가지거나 지워져도 되돌릴 수 있게.
//   backups/db-YYYYMMDD-HHMM.json 으로 복사하고 keep개만 남긴다(오래된 것부터 지움).
//   볼륨 밖 사본(선택): upload 를 넘기면 만든 백업을 외부 저장소에도 올린다(server/sigv4.js 의 S3 업로더).
//   실패(로컬·외부 모두)는 서버를 멈추지 않는다 — 로그와 onError(관리자 "최근 문제")로만 알린다.
//   실행 검증: apps/ad-dodge 안에서 node --test (server/backup.test.js)

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_KEEP = 48;               // 1시간마다면 이틀치
const DEFAULT_INTERVAL_MS = 3600_000;

function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/** 한 번 백업. 만든 파일 경로 또는(장부가 아직 없으면) null */
function backupOnce({ dataDir, keep = DEFAULT_KEEP, now = Date.now }) {
  const db = path.join(dataDir, 'db.json');
  if (!fs.existsSync(db)) return null;
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `db-${stamp(now())}.json`);
  fs.copyFileSync(db, file);
  const all = fs.readdirSync(dir).filter((f) => /^db-\d{8}-\d{4}\.json$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, old));
  return file;
}

/**
 * 주기 백업 시작 → 멈추는 함수. 실패해도 서버는 계속 돈다(로그 + onError)
 * upload: async ({ name, body }) — 있으면 만든 백업을 외부 저장소에도 올린다
 */
function startBackups({ dataDir, keep = DEFAULT_KEEP, intervalMs = DEFAULT_INTERVAL_MS, upload = null, onError = () => {} }) {
  const fail = (label, err) => {
    console.error(`[backup] ${label}`, err);
    try {
      onError(new Error(`${label}: ${err && err.message ? err.message : err}`));
    } catch (reportErr) {
      console.error('[backup] 오류 기록 실패', reportErr);
    }
  };
  const run = () => {
    let file = null;
    try {
      file = backupOnce({ dataDir, keep });
    } catch (err) {
      fail('백업 실패', err);
      return;
    }
    if (!file || !upload) return;
    Promise.resolve()
      .then(() => upload({ name: path.basename(file), body: fs.readFileSync(file) }))
      .catch((err) => fail('외부 백업 업로드 실패', err));
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { backupOnce, startBackups };
