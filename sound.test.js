// sound.js — 소리 켜기/끄기 설정과 "무엇이 일어났나" 판정(순수). 소리 합성 자체는 브라우저 확인 대상.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const S = require('./sound.js');

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('loadMuted/saveMuted: 저장한 값을 다시 읽는다, 기본은 소리 켬', () => {
  const st = fakeStorage();
  assert.equal(S.loadMuted(st), false);
  S.saveMuted(st, true);
  assert.equal(S.loadMuted(st), true);
});

test('loadMuted: 저장소가 막혀 있어도(사생활 보호 모드) 던지지 않는다', () => {
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(S.loadMuted(broken), false);
  assert.doesNotThrow(() => S.saveMuted(broken, true));
});

test('gameEvents: 상태 변화에서 소리 낼 사건을 뽑는다', () => {
  const prev = { seen: { A: 1 }, nearMisses: 0, waves: 0, waveWarning: false, dead: false };
  const next = { seen: { A: 2 }, nearMisses: 1, waves: 1, waveWarning: false, dead: true };
  assert.deepEqual(S.gameEvents(prev, next), ['spawn', 'whoosh', 'wave', 'hit']);
});

test('gameEvents: 경고는 켜지는 순간 한 번만', () => {
  const a = { seen: {}, nearMisses: 0, waves: 0, waveWarning: false, dead: false };
  const b = { ...a, waveWarning: true };
  assert.deepEqual(S.gameEvents(a, b), ['warning']);
  assert.deepEqual(S.gameEvents(b, b), []);
});
