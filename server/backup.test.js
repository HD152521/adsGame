// backup.js — 장부 파일(db.json) 주기 백업. 오래된 백업은 개수 상한으로 지운다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { backupOnce } = require('./backup.js');

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
