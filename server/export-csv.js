// 주문 CSV 내보내기 — 관리자 GET /api/admin/export.csv?status= 가 쓴다(장부 대조·환불 정산용).
//   - 엑셀이 한글을 깨뜨리지 않게 UTF-8 BOM, 줄 끝은 CRLF(RFC 4180)
//   - 쉼표·따옴표·줄바꿈이 든 셀은 "…" 로 감싸고 " 는 "" 로
//   - CSV 인젝션 방지: =,+,-,@ (그리고 탭·CR)로 시작하는 셀은 앞에 ' 를 붙여 수식으로 실행되지 않게(OWASP)
//   - 허용한 열만 쓴다 — 결제 secret·paymentKey·가상계좌·전체 orderId(주문 조회 비밀 토큰)는 나가지 않는다
//   실행 검증: apps/ad-dodge 안에서 node --test (server/export-csv.test.js, server/app-ops.test.js)

const CSV_HEADER = Object.freeze(['주문번호', '광고 이름', '종류', '칸', '금액', '상태', '생성 일시', '입금 일시', '환불 일시', '환불 메모']);
const BOM = '\ufeff';
const CRLF = '\r\n';
const ORDER_ID_PREFIX = 8;
const KST_OFFSET_MS = 9 * 3600 * 1000;
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTE = /[",\r\n]/;

const KIND_LABEL = Object.freeze({ logo: '로고', snipe: '저격' });
const STATUS_LABEL = Object.freeze({
  awaiting_deposit: '입금 대기',
  pending_review: '검수 대기',
  active: '붙어 있음',
  hidden: '떼어 냄',
  refund_required: '환불 필요',
  refunded: '환불 완료',
});

/** ms → 'YYYY-MM-DD HH:mm'(한국 시각). 값이 없으면 빈 칸 */
function kstDateTime(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** 셀 하나 → CSV 조각(인젝션 방지 → 이스케이프 순서) */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return NEEDS_QUOTE.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toRow(o) {
  return [
    String(o.orderId || '').slice(0, ORDER_ID_PREFIX),
    o.name,
    KIND_LABEL[o.kind] || o.kind,
    o.slots,
    o.amount,
    STATUS_LABEL[o.status] || o.status,
    kstDateTime(o.createdAt),
    kstDateTime(o.paidAt),
    kstDateTime(o.refundedAt),
    o.refundMemo || '',
  ];
}

/** 주문 목록 → CSV 문자열(BOM 포함) */
function ordersToCsv(orders) {
  const lines = [CSV_HEADER, ...orders.map(toRow)].map((cells) => cells.map(csvCell).join(','));
  return `${BOM}${lines.join(CRLF)}${CRLF}`;
}

module.exports = { ordersToCsv, csvCell, kstDateTime, CSV_HEADER, STATUS_LABEL };
