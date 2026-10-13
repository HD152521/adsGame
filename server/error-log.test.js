// 오류 알림 링버퍼(계획서 Step 5) — 최근 50건만 메모리에, 비밀값·요청 본문은 남기지 않는다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createErrorLog, ERROR_LOG_MAX, maskPath } = require('./error-log.js');

test('[오류 기록] 최대 50건 — 넘치면 오래된 것부터 버리고, 최신이 맨 앞', () => {
  let t = 0;
  const log = createErrorLog({ now: () => ++t });
  assert.equal(ERROR_LOG_MAX, 50);
  for (let i = 0; i < 60; i += 1) log.record('server', `문제 ${i}`);
  const list = log.list();
  assert.equal(list.length, 50);
  assert.equal(list[0].message, '문제 59');
  assert.equal(list[49].message, '문제 10');
  assert.deepEqual(Object.keys(list[0]).sort(), ['at', 'kind', 'message']);
  assert.equal(list[0].at, 60);
});

test('[오류 기록] 돌려준 목록을 고쳐도 원본은 그대로', () => {
  const log = createErrorLog({});
  log.record('backup', '실패');
  const list = log.list();
  list[0].message = '바꿈';
  list.push({});
  assert.equal(log.list().length, 1);
  assert.equal(log.list()[0].message, '실패');
});

test('[오류 기록] 알 수 없는 종류는 other, 메시지는 Error·문자열 모두 받고 길이 제한', () => {
  const log = createErrorLog({});
  log.record('???', new Error('에러 객체'));
  log.record('pg', 'x'.repeat(2000));
  const [long, err] = log.list();
  assert.equal(err.kind, 'other');
  assert.equal(err.message, '에러 객체');
  assert.equal(long.kind, 'pg');
  assert.ok(long.message.length <= 300);
});

test('[오류 기록] 비밀값은 남기지 않는다 — 설정된 비밀값·토스 키·Bearer 토큰·긴 hex(orderId·secret)를 가린다', () => {
  const log = createErrorLog({ secrets: ['super-admin-token-1234', 'S3SECRETKEYVALUE/abc+def', '', undefined, 'short'] });
  log.record('server', 'short 낱말은 그대로');
  log.record('server', 'token super-admin-token-1234 그리고 S3SECRETKEYVALUE/abc+def');
  log.record('pg', 'key test_sk_abcDEF123_xyz / live_sk_QQQ999 실패');
  log.record('webhook', 'authorization: Bearer abc.def-ghi 거부');
  log.record('server', 'POST /api/orders/0123456789abcdef0123456789abcdef/topup ps_1234567890abcdef12345678');
  const text = JSON.stringify(log.list());
  for (const leaked of ['super-admin-token-1234', 'S3SECRETKEYVALUE', 'test_sk_abcDEF123_xyz', 'live_sk_QQQ999', 'abc.def-ghi', '0123456789abcdef0123456789abcdef', '1234567890abcdef12345678']) {
    assert.equal(text.includes(leaked), false, leaked);
  }
  assert.match(text, /01234567…/); // 주문번호 앞 8자리는 남겨 찾을 수 있게
  assert.match(text, /short/); // 너무 짧은 값은 일반 단어를 지울 수 있어 가리지 않는다(비밀값은 16자 이상)
});

test('[오류 기록] maskPath: 쿼리는 버리고 긴 hex 경로 조각은 앞 8자리만', () => {
  assert.equal(maskPath('/api/orders/0123456789abcdef0123456789abcdef?x=secret'), '/api/orders/01234567…');
  assert.equal(maskPath('/api/ledger'), '/api/ledger');
});
