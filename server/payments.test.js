// payments.js — 결제 제공자 인터페이스 + 모의 PG(가상계좌·서명된 웹훅).
//   실제 PG는 같은 인터페이스(issueVirtualAccount / verifyWebhook)로 교체한다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockProvider } = require('./payments.js');

const provider = () => createMockProvider({ secret: 'test-secret', now: () => 1_000_000 });

test('issueVirtualAccount: 계좌번호·예금주·입금기한(24시간)을 준다', () => {
  const va = provider().issueVirtualAccount({ orderId: 'o1', amount: 5000 });
  assert.match(va.accountNumber, /^\d{14}$/);
  assert.equal(va.holder, '이건광고입니다');
  assert.equal(va.dueAt, 1_000_000 + 24 * 3600 * 1000);
});

test('issueVirtualAccount: 주문마다 다른 계좌(입금자 매칭 불필요)', () => {
  const p = provider();
  const a = p.issueVirtualAccount({ orderId: 'o1', amount: 1000 });
  const b = p.issueVirtualAccount({ orderId: 'o2', amount: 1000 });
  assert.notEqual(a.accountNumber, b.accountNumber);
});

test('verifyWebhook: 올바른 서명이면 payload를 돌려준다', () => {
  const p = provider();
  const raw = JSON.stringify({ orderId: 'o1', status: 'DONE', amount: 5000 });
  const payload = p.verifyWebhook({ 'x-mock-signature': p.sign(raw) }, raw);
  assert.deepEqual(payload, { orderId: 'o1', status: 'DONE', amount: 5000 });
});

test('verifyWebhook: 서명이 없거나 틀리면 거부(위조 입금 방지)', () => {
  const p = provider();
  const raw = JSON.stringify({ orderId: 'o1', status: 'DONE', amount: 5000 });
  assert.throws(() => p.verifyWebhook({}, raw), /서명/);
  assert.throws(() => p.verifyWebhook({ 'x-mock-signature': 'deadbeef' }, raw), /서명/);
  assert.throws(() => p.verifyWebhook({ 'x-mock-signature': p.sign(raw) }, raw.replace('5000', '9000')), /서명/);
});
