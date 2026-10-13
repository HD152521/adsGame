// 컨테이너 진입점 — 루트로 시작했으면 데이터 볼륨(/data) 주인을 node 사용자로 바꾼 뒤 권한을 내려놓고 서버를 띄운다.
//   fly 볼륨은 처음 만들면 root 소유라 비root 사용자가 쓸 수 없다. 그래서 "루트로 시작 → 볼륨만 넘겨주고 → 즉시 강등".
//   이미 비root 로 시작했으면(podman run --user node 등) 아무것도 바꾸지 않는다. 강등에 실패하면 루트로 돌지 않고 멈춘다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { dropPrivileges, APP_UID, APP_GID } = require('./container-entry.js');

function fakeProc(uid) {
  const calls = [];
  let current = uid;
  return {
    calls,
    getuid: () => current,
    setgroups: (g) => calls.push(['setgroups', g]),
    setgid: (g) => calls.push(['setgid', g]),
    setuid: (u) => {
      calls.push(['setuid', u]);
      current = u;
    },
  };
}

function fakeFs(tree) {
  // tree: { '/data': { uid: 0, dir: ['a.json', 'uploads'] }, '/data/a.json': { uid: 0 }, ... }
  const chowned = [];
  return {
    chowned,
    mkdirSync: (p) => {
      if (!tree[p]) tree[p] = { uid: 0, dir: [] };
    },
    lstatSync: (p) => ({ uid: tree[p].uid, isDirectory: () => Array.isArray(tree[p].dir), isSymbolicLink: () => Boolean(tree[p].link) }),
    readdirSync: (p) => tree[p].dir,
    chownSync: (p, u, g) => {
      chowned.push([p, u, g]);
      tree[p].uid = u;
    },
  };
}

test('루트로 시작: 볼륨 안 root 소유 파일을 node(1000) 소유로 바꾸고 gid → uid 순서로 강등', () => {
  const proc = fakeProc(0);
  const fsImpl = fakeFs({
    '/data': { uid: 0, dir: ['db.json', 'uploads', 'link'] },
    '/data/db.json': { uid: 0 },
    '/data/uploads': { uid: APP_UID, dir: ['a.png'] },
    '/data/uploads/a.png': { uid: 0 },
    '/data/link': { uid: 0, link: true },
  });
  const r = dropPrivileges({ proc, fsImpl, dataDir: '/data', sep: '/' });
  assert.equal(r, 'dropped');
  assert.deepEqual(fsImpl.chowned.map((c) => c[0]).sort(), ['/data', '/data/db.json', '/data/uploads/a.png'], '이미 node 소유인 것·심볼릭 링크는 건드리지 않음');
  assert.ok(fsImpl.chowned.every(([, u, g]) => u === APP_UID && g === APP_GID));
  assert.deepEqual(proc.calls.map((c) => c[0]), ['setgroups', 'setgid', 'setuid']);
  assert.equal(proc.getuid(), APP_UID);
});

test('이미 비root 로 시작: 아무것도 바꾸지 않는다', () => {
  const proc = fakeProc(APP_UID);
  const fsImpl = fakeFs({ '/data': { uid: 0, dir: [] } });
  assert.equal(dropPrivileges({ proc, fsImpl, dataDir: '/data', sep: '/' }), 'unprivileged');
  assert.deepEqual(proc.calls, []);
  assert.deepEqual(fsImpl.chowned, []);
});

test('POSIX 가 아닌 곳(Windows 로컬): 강등 없이 그대로', () => {
  assert.equal(dropPrivileges({ proc: {}, fsImpl: fakeFs({}), dataDir: '/data', sep: '/' }), 'unsupported');
});

test('강등 뒤에도 루트면 예외 — 루트로 서버를 띄우지 않는다', () => {
  const proc = { ...fakeProc(0), setuid: () => {} }; // setuid 가 먹지 않은 상황
  assert.throws(() => dropPrivileges({ proc, fsImpl: fakeFs({ '/data': { uid: 0, dir: [] } }), dataDir: '/data', sep: '/' }), /root/);
});
