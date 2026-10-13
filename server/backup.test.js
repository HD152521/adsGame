// backup.js — 장부 파일(db.json) 주기 백업. 오래된 백업은 개수 상한으로 지운다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { backupOnce, startBackups } = require('./backup.js');

test('backupOnce: db.json을 시각이 찍힌 파일로 복사, keep개만 남긴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bak-'));
  fs.writeFileSync(path.join(dir, 'db.json'), '{"orders":{}}');
  let t = Date.UTC(2026, 9, 8, 0, 0, 0);
  for (let i = 0; i < 5; i += 1) {
    backupOnce({ dataDir: dir, keep: 3, now: () => t });
    t += 3600_000;
  }
  const files = fs.readdirSync(path.join(dir, 'backups')).sort();
  assert.equal(files.length, 3);
  assert.match(files[0], /^db-\d{8}-\d{4}\.json$/);
  assert.equal(fs.readFileSync(path.join(dir, 'backups', files[2]), 'utf8'), '{"orders":{}}');
});

test('backupOnce: db.json이 아직 없으면 아무것도 안 하고 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bak-'));
  assert.equal(backupOnce({ dataDir: dir, keep: 3, now: () => 0 }), null);
});

test('[외부 백업] startBackups: 업로더가 있으면 만든 백업 파일 이름·내용을 넘긴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bak-'));
  fs.writeFileSync(path.join(dir, 'db.json'), '{"orders":{"a":1}}');
  let resolveUploaded;
  const uploaded = new Promise((r) => { resolveUploaded = r; });
  const stop = startBackups({ dataDir: dir, intervalMs: 3600_000, upload: async (file) => resolveUploaded(file), onError: () => assert.fail('오류가 나면 안 된다') });
  const file = await uploaded;
  stop();
  assert.match(file.name, /^db-\d{8}-\d{4}\.json$/);
  assert.equal(file.body.toString('utf8'), '{"orders":{"a":1}}');
});

test('[외부 백업] 업로드가 실패해도 서버(백업 루프)는 멈추지 않고 onError 로 기록만 한다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bak-'));
  fs.writeFileSync(path.join(dir, 'db.json'), '{}');
  let resolveErr;
  const reported = new Promise((r) => { resolveErr = r; });
  let stop;
  assert.doesNotThrow(() => {
    stop = startBackups({ dataDir: dir, intervalMs: 3600_000, upload: async () => { throw new Error('HTTP 403'); }, onError: resolveErr });
  });
  const err = await reported;
  stop();
  assert.match(err.message, /외부 백업.*403/);
  assert.equal(fs.readdirSync(path.join(dir, 'backups')).length, 1); // 로컬 백업은 그대로 남는다
});

test('[외부 백업] 로컬 백업이 실패해도 throw 하지 않고 onError 로', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-bak-'));
  fs.writeFileSync(path.join(dir, 'db.json'), '{}');
  fs.writeFileSync(path.join(dir, 'backups'), '디렉터리 자리에 파일'); // mkdir 실패 유도
  const errors = [];
  const stop = startBackups({ dataDir: dir, intervalMs: 3600_000, onError: (e) => errors.push(e) });
  stop();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /백업/);
});
