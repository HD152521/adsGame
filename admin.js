// 관리자 페이지 — 검수 대기열 승인/거절, 신고로 가려진 광고 복구, 환불 대상 확인.
//   토큰은 sessionStorage에만(탭을 닫으면 사라짐). 광고 이름은 전부 textContent로만 넣는다.

const ADMIN_TOKEN_KEY = 'ad-dodge:admin-token';
const ADMIN_ACTIONS = {
  pending_review: [['approve', '붙이기'], ['reject', '거절·환불']],
  active: [['hide', '떼어 내기'], ['reject', '삭제·환불']],
  hidden: [['restore', '다시 붙이기'], ['reject', '삭제·환불']],
  refund_required: [],
  awaiting_deposit: [],
};

(function bootAdmin() {
  const $ = (id) => document.getElementById(id);
  let token = '';
  let status = 'pending_review';
  try {
    token = sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  } catch {
    /* 저장 불가 환경 — 매번 입력 */
  }

  const request = async (path, method = 'GET') => {
    const res = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  };

  const renderItem = (ad) => {
    const li = document.createElement('li');
    li.className = 'admin__item';
    if (ad.logoUrl) {
      const img = document.createElement('img');
      img.src = ad.logoUrl;
      img.alt = `${ad.name} 로고`;
      img.width = 64;
      img.height = 64;
      li.append(img);
    }
    const info = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = `${ad.name} · ${ad.slots.toLocaleString('ko-KR')}칸 · ${ad.amount.toLocaleString('ko-KR')}원`;
    const meta = document.createElement('small');
    meta.textContent = `${ad.kind === 'snipe' ? '저격' : '로고'} · 신고 ${ad.reports}${ad.rightsReport ? ' (권리침해)' : ''} · 주문 ${ad.orderId.slice(0, 8)}… · ${new Date(ad.createdAt).toLocaleString('ko-KR')}`;
    info.append(title, document.createElement('br'), meta);
    if (ad.landingUrl) {
      // 검수용으로 주소만 글자로 보여준다(관리자가 실수로 악성 링크를 누르지 않게 링크로 만들지 않음)
      const url = document.createElement('code');
      url.className = 'admin__url';
      url.textContent = `→ ${ad.landingUrl}`;
      info.append(document.createElement('br'), url);
    }
    const actions = document.createElement('div');
    for (const [action, label] of ADMIN_ACTIONS[ad.status] || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = label;
      b.addEventListener('click', () => act(ad.advertiserId, action, label));
      actions.append(b);
    }
    li.append(info, actions);
    return li;
  };

  const load = async () => {
    for (const b of document.querySelectorAll('#admin-tabs [data-status]')) b.setAttribute('aria-pressed', String(b.dataset.status === status));
    try {
      const list = await request(`/api/admin/advertisers?status=${status}`);
      $('admin-list').replaceChildren(...list.map(renderItem));
      $('admin-status').textContent = `${list.length}건`;
    } catch (err) {
      $('admin-status').textContent = err.message;
    }
  };

  async function act(advertiserId, action, label) {
    if (!window.confirm(`${label} 할까요?`)) return;
    try {
      await request(`/api/admin/advertisers/${encodeURIComponent(advertiserId)}/${action}`, 'POST');
      await load();
    } catch (err) {
      $('admin-status').textContent = err.message;
    }
  }

  $('admin-login').addEventListener('submit', (e) => {
    e.preventDefault();
    token = e.target.elements.token.value;
    try {
      sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    } catch {
      /* 무시 */
    }
    load();
  });
  $('admin-tabs').addEventListener('click', (e) => {
    if (!e.target.dataset.status) return;
    status = e.target.dataset.status;
    load();
  });
  if (token) load();
})();
