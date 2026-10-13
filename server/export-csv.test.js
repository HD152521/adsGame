// 주문 CSV 내보내기(계획서 Step 5) — 엑셀에서 바로 열리고(UTF-8 BOM·CRLF), 셀이 깨지지 않고(이스케이프),
//   수식으로 실행되지 않으며(CSV 인젝션 방지), 결제 비밀값(secret·paymentKey)은 들어가지 않는다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ordersToCsv, csvCell, CSV_HEADER } = require('./export-csv.js');

const BASE = {
  orderId: 'abcdef0123456789abcdef0123456789',
  name: '민수',
  kind: 'snipe',
  slots: 3,
  amount: 3000,
  status: 'refunded',
  createdAt: Date.UTC(2026, 9, 13, 0, 5),
  paidAt: Date.UTC(2026, 9, 13, 1, 0),
  refundedAt: Date.UTC(2026, 9, 13, 2, 30),
  refundMemo: '이체 완료',
};

test('[CSV] UTF-8 BOM 으로 시작하고 줄 끝은 CRLF, 첫 줄은 한국어 머리글', () => {
  const csv = ordersToCsv([BASE]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const body = csv.slice(1);
  assert.ok(body.endsWith('\r\n'));
  assert.equal(body.split('\r\n').length, 3); // 머리글 + 1행 + 끝 빈 칸
  assert.equal(body.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(body.split('\r\n')[0], CSV_HEADER.join(','));
  assert.deepEqual(CSV_HEADER, ['주문번호', '광고 이름', '종류', '칸', '금액', '상태', '생성 일시', '입금 일시', '환불 일시', '환불 메모']);
});

test('[CSV] 주문번호는 앞 8자리만, 일시는 한국 시각, 종류·상태는 한국어', () => {
  const row = ordersToCsv([BASE]).slice(1).split('\r\n')[1];
  assert.equal(row, 'abcdef01,민수,저격,3,3000,환불 완료,2026-10-13 09:05,2026-10-13 10:00,2026-10-13 11:30,이체 완료');
  const empty = ordersToCsv([{ ...BASE, kind: 'logo', status: 'awaiting_deposit', paidAt: null, refundedAt: undefined, refundMemo: undefined }]).slice(1).split('\r\n')[1];
  assert.equal(empty, 'abcdef01,민수,로고,3,3000,입금 대기,2026-10-13 09:05,,,');
});

test('[CSV] 쉼표·따옴표·줄바꿈이 든 셀은 따옴표로 감싸고 따옴표는 두 번', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('그가 "안녕"'), '"그가 ""안녕"""');
  assert.equal(csvCell('줄\n바꿈'), '"줄\n바꿈"');
  assert.equal(csvCell('줄\r\n바꿈'), '"줄\r\n바꿈"');
  assert.equal(csvCell('보통'), '보통');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(1000), '1000');
});

test('[CSV] =,+,-,@ (그리고 탭·CR)로 시작하는 셀은 앞에 \' 를 붙여 수식으로 실행되지 않게', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
  assert.equal(csvCell('+1+1'), "'+1+1");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('\tcmd'), "'\tcmd");
  assert.equal(csvCell('a=b'), 'a=b');
  const row = ordersToCsv([{ ...BASE, name: '=1+2', refundMemo: '@cmd' }]).slice(1).split('\r\n')[1];
  assert.match(row, /^abcdef01,'=1\+2,/);
  assert.match(row, /,'@cmd$/);
});

test('[CSV] 주문에 결제 비밀값이 붙어 와도 내보내지 않는다(허용한 열만 쓴다)', () => {
  const csv = ordersToCsv([{ ...BASE, payment: { webhookSecret: 'ps_SECRET_VALUE', paymentKey: 'pk_PAYMENT_KEY' }, webhookSecret: 'ps_SECRET_VALUE', paymentKey: 'pk_PAYMENT_KEY', virtualAccount: { accountNumber: '9999' } }]);
  assert.equal(csv.includes('ps_SECRET_VALUE'), false);
  assert.equal(csv.includes('pk_PAYMENT_KEY'), false);
  assert.equal(/secret|paymentKey/i.test(csv), false);
  assert.equal(csv.includes(BASE.orderId), false); // 전체 orderId(주문 조회 비밀 토큰)도 안 나간다
});

test('[CSV] 주문이 없으면 머리글만', () => {
  assert.equal(ordersToCsv([]), `\ufeff${CSV_HEADER.join(',')}\r\n`);
});
