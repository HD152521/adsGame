// store.js — 결제 기록은 즉시 디스크에, 놀이 기록(lazy)은 모아서 1초 안에 쓴다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore, LAZY_WRITE_MS } = require('./store.js');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-store-')), 'db.json');
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('update: 기본은 즉시 디스크에 쓴다(결제 기록)', () => {
  const file = tmpFile();
  const store = createStore({ file });
  store.update((s) => ({ ...s, orders: { a: 1 } }));
  assert.deepEqual(onDisk(file).orders, { a: 1 });
});

test('update lazy: 메모리엔 바로, 디스크엔 모아서 한 번에', async () => {
  const file = tmpFile();
  const store = createStore({ file });
  store.update((s) => ({ ...s, runs: { n: 1 } }), { lazy: true });
  store.update((s) => ({ ...s, runs: { n: 2 } }), { lazy: true });
  assert.deepEqual(store.read().runs, { n: 2 });
  assert.equal(fs.existsSync(file), false, '아직 안 씀');
  await new Promise((r) => setTimeout(r, LAZY_WRITE_MS + 50));
  assert.deepEqual(onDisk(file).runs, { n: 2 });
  store.close();
});

test('즉시 쓰기가 오면 밀려 있던 lazy 변경도 함께 저장된다', () => {
  const file = tmpFile();
  const store = createStore({ file });
  store.update((s) => ({ ...s, runs: { n: 9 } }), { lazy: true });
  store.update((s) => ({ ...s, orders: { b: 1 } }));
  assert.deepEqual(onDisk(file).runs, { n: 9 });
  store.close();
});

test('flush: 남은 lazy 변경을 바로 쓴다(종료 직전)', () => {
  const file = tmpFile();
  const store = createStore({ file });
  store.update((s) => ({ ...s, runs: { n: 3 } }), { lazy: true });
  store.flush();
  assert.deepEqual(onDisk(file).runs, { n: 3 });
  store.close();
});
