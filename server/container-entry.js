// 컨테이너 진입점(Dockerfile CMD) — 루트로 시작했으면 데이터 볼륨만 node 사용자에게 넘겨주고 곧바로 권한을 내려놓은 뒤
//   server/index.js 를 띄운다. 서버 코드는 한 줄도 루트로 돌지 않는다.
//   왜: fly 볼륨은 처음 만들면 root 소유라, Dockerfile 에서 USER node 로만 띄우면 /data 에 장부를 못 쓴다.
//   · 이미 비root 로 시작(podman run --user node 등) → 그대로
//   · POSIX 가 아님(Windows 로컬) → 그대로
//   · 강등 뒤에도 루트 → 예외로 멈춤(루트로 서버를 띄우지 않는다)
//   심볼릭 링크는 따라가지 않는다(볼륨 밖 파일 주인을 바꾸지 않게).
//   실행 검증: apps/ad-dodge 안에서 node --test (server/container-entry.test.js)

const fs = require('node:fs');
const path = require('node:path');

const APP_UID = 1000; // node:20-alpine 의 node 사용자
const APP_GID = 1000;

function chownTree(fsImpl, dir, sep) {
  const walk = (p) => {
    const st = fsImpl.lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.uid !== APP_UID) fsImpl.chownSync(p, APP_UID, APP_GID);
    if (st.isDirectory()) for (const name of fsImpl.readdirSync(p)) walk(`${p}${sep}${name}`);
  };
  walk(dir);
}

/** → 'dropped' | 'unprivileged' | 'unsupported' */
function dropPrivileges({ proc = process, fsImpl = fs, dataDir, sep = path.sep }) {
  if (typeof proc.getuid !== 'function' || typeof proc.setuid !== 'function') return 'unsupported';
  if (proc.getuid() !== 0) return 'unprivileged';
  fsImpl.mkdirSync(dataDir, { recursive: true });
  chownTree(fsImpl, dataDir, sep);
  proc.setgroups([APP_GID]);
  proc.setgid(APP_GID);
  proc.setuid(APP_UID);
  if (proc.getuid() === 0) throw new Error('권한 강등 실패 — root 로 서버를 띄우지 않습니다');
  return 'dropped';
}

if (require.main === module) {
  const dataDir = path.resolve(process.env.DATA_DIR || '/data');
  try {
    const result = dropPrivileges({ dataDir });
    console.info(`[container] 실행 사용자 uid=${process.getuid?.() ?? '-'} (${result})`);
  } catch (err) {
    console.error('[container]', err.message);
    process.exit(1);
  }
  require('./index.js');
}

module.exports = { dropPrivileges, APP_UID, APP_GID };
