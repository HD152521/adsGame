// 관리자 페이지 — 검수 대기열 승인/거절, 신고로 가려진 광고 복구, 환불 대상 확인·환불 완료 기록,
//   주문 CSV 내려받기, 최근 문제(서버 오류·웹훅·PG·백업 실패·관리자 차단·감사 기록 실패) 확인, 관리 기록(감사 로그) 확인.
//   환불 완료는 "기록"만 한다 — 실제 돈은 운영자가 직접 이체한 뒤 처리 일시·메모를 남긴다(되돌리기 없음).
//   토큰은 sessionStorage에만(탭을 닫으면 사라짐). 광고 이름은 전부 textContent로만 넣는다.

const ADMIN_TOKEN_KEY = 'ad-dodge:admin-token';
const ADMIN_EDITABLE = new Set(['active', 'pending_review', 'hidden', 'awaiting_deposit']);
const ADMIN_LOGO_SIZE = 256; // 구매 화면과 같은 크기로 줄여 올린다(용량·EXIF 제거)
const ADMIN_ACTIONS = {
  pending_review: [['approve', '붙이기'], ['reject', '거절·환불']],
  active: [['hide', '떼어 내기'], ['reject', '삭제·환불']],
  hidden: [['restore', '다시 붙이기'], ['reject', '삭제·환불']],
  refund_required: [],
  refunded: [],
  awaiting_deposit: [],
};
const ADMIN_REFUND_MEMO_MAX = 200;
const ADMIN_ERROR_KIND = { server: '서버 오류', webhook: '웹훅 검증 실패', pg: '결제사 장애', backup: '백업 실패', admin: '관리자 차단', audit: '감사 기록 실패', other: '기타' };
const ADMIN_AUDIT_ACTION = { approve: '붙이기', reject: '거절·환불', hide: '떼어 내기', restore: '다시 붙이기', edit: '고치기', refund: '환불 완료', export: 'CSV 내려받기' };
const ADMIN_AUDIT_FIELD = { status: '상태', name: '이름', landingUrl: '이동 주소', logo: '로고', refundedAt: '처리 일시', refundMemo: '메모' };

(function bootAdmin() {
  const $ = (id) => document.getElementById(id);
  let token = '';
  let status = 'pending_review';
  try {
    token = sessionStorage.getItem(ADMIN_TOKEN_KEY) || '';
  } catch {
    /* 저장 불가 환경 — 매번 입력 */
  }

  const request = async (path, method = 'GET', body = {}) => {
    const res = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  };

  /** 로고 파일 → 정사각 PNG data URL(가운데 크롭) */
  const fileToDataUrl = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = ADMIN_LOGO_SIZE;
      c.height = ADMIN_LOGO_SIZE;
      c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, ADMIN_LOGO_SIZE, ADMIN_LOGO_SIZE);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 읽을 수 없어요. PNG·JPG로 다시 골라 주세요'));
    };
    img.src = url;
  });

  const field = (labelText, input) => {
    const label = document.createElement('label');
    label.append(labelText, input);
    return label;
  };

  /** 고치기 폼: 이름·이동 주소·로고. 바뀐 항목만 보낸다 */
  const buildEditForm = (ad, onCancel) => {
    const form = document.createElement('form');
    form.className = 'admin__edit';
    form.noValidate = true;
    const name = Object.assign(document.createElement('input'), { type: 'text', maxLength: 16, value: ad.name, required: true });
    // type=url이면 'fixed.example'처럼 https:// 없는 주소를 브라우저가 막는다 — 정규화·검증은 서버(validateLandingUrl)에 맡긴다
    const url = Object.assign(document.createElement('input'), { type: 'text', inputMode: 'url', maxLength: 300, value: ad.landingUrl || '', placeholder: '비우면 이동 없음' });
    const logo = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const error = Object.assign(document.createElement('p'), { className: 'admin__edit-error' });
    const save = Object.assign(document.createElement('button'), { type: 'submit', className: 'btn btn--primary', textContent: '고친 내용 붙이기' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: '취소' });
    cancel.addEventListener('click', onCancel);
    const actions = Object.assign(document.createElement('div'), { className: 'admin__edit-actions' });
    actions.append(save, cancel);
    form.append(field('광고 이름 (16자)', name), field('이동할 사이트', url));
    if (ad.kind === 'logo') form.append(field('새 로고 (선택 — 안 고르면 그대로)', logo));
    form.append(error, actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {};
      if (name.value.trim() !== ad.name) body.name = name.value;
      if (url.value.trim() !== (ad.landingUrl || '')) body.landingUrl = url.value;
      save.disabled = true;
      try {
        if (logo.files && logo.files[0]) body.image = await fileToDataUrl(logo.files[0]);
        if (Object.keys(body).length === 0) {
          error.textContent = '바뀐 내용이 없어요';
          return;
        }
        await request(`/api/admin/advertisers/${encodeURIComponent(ad.advertiserId)}/edit`, 'POST', body);
        await load();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    });
    return form;
  };

  /** datetime-local 기본값 — 지금(이 PC 시각) */
  const localNow = () => {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };

  /** 환불 완료 기록 폼: 처리 일시·메모. 주문 하나 단위(칸 추가 주문은 따로 처리) */
  const buildRefundForm = (ad, onCancel) => {
    const form = document.createElement('form');
    form.className = 'admin__edit';
    const at = Object.assign(document.createElement('input'), { type: 'datetime-local', value: localNow(), required: true });
    const memo = Object.assign(document.createElement('input'), { type: 'text', maxLength: ADMIN_REFUND_MEMO_MAX, placeholder: '예: 국민 123-45… 로 이체, 거래번호' });
    const error = Object.assign(document.createElement('p'), { className: 'admin__edit-error' });
    const save = Object.assign(document.createElement('button'), { type: 'submit', className: 'btn btn--primary', textContent: '환불 완료로 기록' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: '취소' });
    cancel.addEventListener('click', onCancel);
    const actions = Object.assign(document.createElement('div'), { className: 'admin__edit-actions' });
    actions.append(save, cancel);
    const note = Object.assign(document.createElement('small'), { textContent: `돈을 먼저 돌려준 뒤 기록하세요. 기록 후에는 되돌릴 수 없습니다 · ${ad.amount.toLocaleString('ko-KR')}원` });
    form.append(note, field('처리 일시', at), field(`메모 (${ADMIN_REFUND_MEMO_MAX}자)`, memo), error, actions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const when = new Date(at.value);
      if (Number.isNaN(when.getTime())) {
        error.textContent = '처리 일시를 골라 주세요';
        return;
      }
      if (!window.confirm(`${ad.name} · ${ad.amount.toLocaleString('ko-KR')}원 — 환불 완료로 기록할까요? 되돌릴 수 없습니다.`)) return;
      // datetime-local 은 분 단위라 주문과 같은 분을 고르면 초가 잘려 "주문 이전"이 된다(E2E 에서 발견) — 주문 시각 아래로는 내리지 않는다
      const refundedAt = new Date(Math.max(when.getTime(), ad.createdAt)).toISOString();
      save.disabled = true;
      try {
        await request(`/api/admin/orders/${encodeURIComponent(ad.orderId)}/refund`, 'POST', { refundedAt, memo: memo.value });
        await load();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    });
    return form;
  };

  /** 줄 끝에 폼 하나를 열고 닫는 버튼 */
  const toggleFormButton = (li, label, build) => {
    const button = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: label });
    button.addEventListener('click', () => {
      const existing = li.querySelector('.admin__edit');
      if (existing) {
        existing.remove();
        return;
      }
      const form = build(() => form.remove());
      li.append(form);
      form.querySelector('input').focus();
    });
    return button;
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
    if (ad.status === 'refunded') {
      const refund = document.createElement('small');
      refund.className = 'admin__refund';
      refund.textContent = `환불 완료 ${ad.refundedAt ? new Date(ad.refundedAt).toLocaleString('ko-KR') : ''}${ad.refundMemo ? ` · ${ad.refundMemo}` : ''}`;
      info.append(document.createElement('br'), refund);
    }
    const actions = document.createElement('div');
    actions.className = 'admin__actions';
    if (ADMIN_EDITABLE.has(ad.status)) actions.append(toggleFormButton(li, '고치기', (close) => buildEditForm(ad, close)));
    if (ad.status === 'refund_required') actions.append(toggleFormButton(li, '환불 완료 처리', (close) => buildRefundForm(ad, close)));
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

  /** 최근 문제 — 관리자 화면 맨 위. 없으면 "없음" */
  const loadErrors = async () => {
    try {
      const { errors } = await request('/api/admin/errors');
      const items = errors.map((e) => {
        const li = document.createElement('li');
        const when = Object.assign(document.createElement('time'), { textContent: new Date(e.at).toLocaleString('ko-KR') });
        const kind = Object.assign(document.createElement('b'), { textContent: ADMIN_ERROR_KIND[e.kind] || ADMIN_ERROR_KIND.other });
        li.append(when, ' ', kind, ' ', e.message);
        return li;
      });
      $('admin-errors-list').replaceChildren(...items);
      $('admin-errors-count').textContent = errors.length ? `${errors.length}건` : '없음';
      $('admin-errors').classList.toggle('admin__errors--alert', errors.length > 0);
      $('admin-errors').hidden = false;
    } catch {
      $('admin-errors').hidden = true; // 토큰이 틀렸으면 목록 쪽 메시지로 안내된다
    }
  };

  /** 관리 기록(감사 로그) — 맨 아래 접힌 칸. 값은 서버가 이미 가려서 준다(textContent로만 넣음) */
  const loadAudit = async () => {
    try {
      const { entries } = await request('/api/admin/audit');
      const items = entries.map((e) => {
        const li = document.createElement('li');
        const when = Object.assign(document.createElement('time'), { textContent: new Date(e.at).toLocaleString('ko-KR') });
        const what = Object.assign(document.createElement('b'), { textContent: ADMIN_AUDIT_ACTION[e.action] || e.action });
        const target = e.order ? ` 주문 ${e.order}…` : '';
        const fields = e.fields && e.fields.length ? ` [${e.fields.map((f) => ADMIN_AUDIT_FIELD[f] || f).join('·')}]` : '';
        const note = e.note ? ` ${e.note}` : '';
        li.append(when, ' ', what, `${target}${fields}${note} — 토큰 ${e.actor} · ${e.ip}`);
        return li;
      });
      $('admin-audit-list').replaceChildren(...items);
      $('admin-audit-count').textContent = entries.length ? `${entries.length}건` : '없음';
      $('admin-audit').hidden = false;
    } catch {
      $('admin-audit').hidden = true;
    }
  };

  /** CSV 내려받기 — 토큰을 헤더로 보내야 해서 링크 대신 fetch → blob */
  const exportCsv = async () => {
    try {
      const res = await fetch(`/api/admin/export.csv?status=${encodeURIComponent(status)}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `내려받기 실패 (${res.status})`);
      }
      const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'ad-dodge-orders.csv';
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      loadAudit(); // 내려받기도 관리 기록에 남는다
    } catch (err) {
      $('admin-status').textContent = err.message;
    }
  };

  const load = async () => {
    for (const b of document.querySelectorAll('#admin-tabs [data-status]')) b.setAttribute('aria-pressed', String(b.dataset.status === status));
    loadErrors();
    loadAudit();
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
  $('admin-export').addEventListener('click', exportCsv);
  $('admin-tabs').addEventListener('click', (e) => {
    if (!e.target.dataset.status) return;
    status = e.target.dataset.status;
    load();
  });
  if (token) load();
})();
