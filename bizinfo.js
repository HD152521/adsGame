// 하단 사업자 정보(법정 표시) — 시작 화면·광고 신청서·약관·개인정보처리방침이 같이 쓴다.
//   서버 GET /api/business 값을 [data-biz-info] 칸에 textContent로만 채운다(값은 환경변수에서 오고, 그래도 글자로만).
//   서버가 없거나(Vercel 정적 미리보기) 운영 값이 아직 없으면 HTML에 적힌 "사업자 정보 준비 중"을 그대로 둔다.
//   classic script — 다른 파일과 전역 이름이 겹치지 않게 BIZ_/Business 이름만 쓴다.

const BIZ_PENDING_TEXT = '사업자 정보 준비 중';
const BIZ_MAIL_ORDER_PENDING = '신고 준비 중';
const BIZ_ENDPOINT = '/api/business';
const BIZ_TIMEOUT_MS = 5000;
const BIZ_ROWS = [
  ['name', '상호'],
  ['owner', '대표'],
  ['regNo', '사업자등록번호'],
  ['mailOrderNo', '통신판매업 신고'],
  ['address', '주소'],
  ['phone', '전화'],
  ['email', '이메일'],
  ['hostingProvider', '호스팅'],
];

/** 서버 응답 → [{ label, value }] | null(준비 전) */
function businessRows(info) {
  if (!info || info.ready !== true) return null;
  return BIZ_ROWS.map(([key, label]) => {
    const value = typeof info[key] === 'string' ? info[key].trim() : '';
    return { label, value: value || (key === 'mailOrderNo' ? BIZ_MAIL_ORDER_PENDING : '-') };
  });
}

/** el 안을 사업자 정보 목록(또는 준비 중 문구)으로 바꾼다 — createElement + textContent 만 */
function fillBusinessInfo(doc, el, info) {
  const rows = businessRows(info);
  if (!rows) {
    el.textContent = BIZ_PENDING_TEXT;
    return;
  }
  const list = doc.createElement('dl');
  list.className = 'biz__list';
  for (const { label, value } of rows) {
    const dt = doc.createElement('dt');
    dt.textContent = label;
    const dd = doc.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  el.replaceChildren(list);
}

/** 서버에서 사업자 정보를 받는다. 서버 없음·404·JSON 아님·시간 초과는 전부 null */
async function loadBusinessInfo(fetchFn) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), BIZ_TIMEOUT_MS) : null;
  try {
    const res = await fetchFn(BIZ_ENDPOINT, controller ? { signal: controller.signal } : undefined);
    if (!res || !res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null; // 정적 미리보기(서버 없음)에서는 정상 — 준비 중으로 둔다
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 페이지의 [data-biz-info] 칸을 한 번의 요청으로 전부 채운다 */
async function bootBusinessInfo(doc, fetchFn) {
  const slots = [...doc.querySelectorAll('[data-biz-info]')];
  if (slots.length === 0) return;
  const info = await loadBusinessInfo(fetchFn);
  for (const el of slots) fillBusinessInfo(doc, el, info);
}

if (typeof module !== 'undefined') {
  module.exports = { BIZ_PENDING_TEXT, businessRows, fillBusinessInfo, loadBusinessInfo, bootBusinessInfo };
} else if (typeof document !== 'undefined' && typeof fetch === 'function') {
  bootBusinessInfo(document, (url, opts) => fetch(url, opts));
}
