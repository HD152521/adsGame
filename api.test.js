// api.js의 순수 도구 — "가장 최근 요청만 반영" 게이트(코드 리뷰: 장부 응답 역전, 주문 폴링 좀비).
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLatestGate } = require('./api.js');

test('createLatestGate: 나중에 시작한 요청만 최신', () => {
  const gate = createLatestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isLatest(first), false, '먼저 보낸 응답이 늦게 와도 반영하지 않는다');
  assert.equal(gate.isLatest(second), true);
});

test('createLatestGate: cancel 이후에는 어떤 진행 중 요청도 최신이 아니다(화면 닫힘)', () => {
  const gate = createLatestGate();
  const t = gate.next();
  gate.cancel();
  assert.equal(gate.isLatest(t), false);
});

test('friendlyNetworkError: 서버가 꺼져 "Failed to fetch"면 알아듣는 문구로', () => {
  const { friendlyNetworkError } = require('./api.js');
  assert.match(friendlyNetworkError(new TypeError('Failed to fetch')).message, /서버/);
  const other = new Error('칸 수는 1 이상');
  assert.equal(friendlyNetworkError(other), other);
});
