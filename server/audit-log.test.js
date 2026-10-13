// 관리자 감사 로그(계획서 Step 6) — 누가(가린 IP·토큰 지문)·언제·무엇(주문번호 앞 8자리·작업·바뀐 필드)을
//   장부(store)에 즉시 기록하고, 상한을 넘으면 오래된 것부터 버린다. 토큰 원문·전체 주문번호는 남기지 않는다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuditLog, maskIp, tokenFingerprint, AUDIT_MAX } = require('./audit-log.js');
const { createStore } = require('./store.js');

const TOKEN = 'audit-unit-test-token-9f3c1a7e5b2d8046';
const ORDER_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

test('[감사] maskIp: IPv4 는 끝자리, IPv6 는 앞 세 덩어리만 남긴다', () => {
  assert.equal(maskIp('203.0.113.77'), '203.0.113.*');
  assert.equal(maskIp('::ffff:127.0.0.1'), '127.0.0.*');
  assert.equal(maskIp('2001:db8:85a3:0:0:8a2e:370:7334'), '2001:db8:85a3:*');
  assert.equal(maskIp(''), 'unknown');
  assert.equal(maskIp(undefined), 'unknown');
});

test('[감사] tokenFingerprint: sha256 앞 8자리 — 원문이 아니고, 같은 토큰이면 같은 값', () => {
  const fp = tokenFingerprint(TOKEN);
  assert.match(fp, /^[a-f0-9]{8}$/);
  assert.equal(fp, tokenFingerprint(TOKEN));
  assert.notEqual(fp, tokenFingerprint(`${TOKEN}x`));
  assert.equal(TOKEN.includes(fp), false);
});

test('[감사] record → 장부(store)에 즉시 저장, 최신이 맨 앞, 토큰 원문·전체 주문번호 없음', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-audit-'));
  const file = path.join(dir, 'db.json');
  const store = createStore({ file });
  let t = 1000;
  const log = createAuditLog({ store, now: () => ++t });
  log.record({ ip: '203.0.113.77', token: TOKEN, action: 'approve', orderId: ORDER_ID, advertiserId: 'abcdef123456', fields: ['status'] });
  log.record({ ip: '203.0.113.77', token: TOKEN, action: 'export', fields: [], note: 'status=all · 3건' });

  const onDisk = fs.readFileSync(file, 'utf8'); // lazy 아님 — 바로 디스크에 있다
  assert.ok(onDisk.includes('"approve"'));
  assert.equal(onDisk.includes(TOKEN), false);
  assert.equal(onDisk.includes(ORDER_ID), false);

  const [latest, first] = log.list();
  assert.equal(latest.action, 'export');
  assert.equal(first.action, 'approve');
  assert.equal(first.order, ORDER_ID.slice(0, 8));
  assert.equal(first.ip, '203.0.113.*');
  assert.equal(first.actor, tokenFingerprint(TOKEN));
  assert.deepEqual(first.fields, ['status']);
  assert.equal(first.at, 1001);
  store.close();
});

test('[감사] 알 수 없는 작업은 기록하지 않는다(오타로 엉뚱한 이름이 쌓이지 않게)', () => {
  const log = createAuditLog({ store: createStore({ file: null }) });
  assert.throws(() => log.record({ ip: '1.2.3.4', token: TOKEN, action: 'drop-table' }), /작업/);
  assert.equal(log.list().length, 0);
});

test(`[감사] 상한(기본 ${AUDIT_MAX}건)을 넘으면 오래된 것부터 버린다`, () => {
  assert.equal(AUDIT_MAX, 2000);
  const store = createStore({ file: null });
  const log = createAuditLog({ store, max: 5 });
  for (let i = 0; i < 8; i += 1) log.record({ ip: '1.2.3.4', token: TOKEN, action: 'hide', orderId: `${i}`.repeat(32), fields: ['status'] });
  const list = log.list();
  assert.equal(list.length, 5);
  assert.equal(list[0].order, '77777777');
  assert.equal(list[4].order, '33333333');
  assert.equal(store.read().audit.length, 5);
  assert.equal(log.list(2).length, 2);
});

test('[감사] 예전 장부(audit 칸 없음)를 읽어도 기록이 된다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-dodge-audit-old-'));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, JSON.stringify({ orders: {} }));
  const store = createStore({ file });
  const log = createAuditLog({ store });
  log.record({ ip: '1.2.3.4', token: TOKEN, action: 'refund', orderId: ORDER_ID, fields: ['status', 'refundedAt', 'refundMemo'] });
  assert.equal(log.list().length, 1);
  store.close();
});
