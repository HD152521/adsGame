// 관리자 페이지 — 검수 대기열 승인/거절, 신고로 가려진 광고 복구, 환불 대상 확인.
//   토큰은 sessionStorage에만(탭을 닫으면 사라짐). 광고 이름은 전부 textContent로만 넣는다.

const ADMIN_TOKEN_KEY = 'ad-dodge:admin-token';
const ADMIN_EDITABLE = new Set(['active', 'pending_review', 'hidden', 'awaiting_deposit']);
const ADMIN_LOGO_SIZE = 256; // 구매 화면과 같은 크기로 줄여 올린다(용량·EXIF 제거)
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
    actions.className = 'admin__actions';
    if (ADMIN_EDITABLE.has(ad.status)) {
      const editButton = Object.assign(document.createElement('button'), { type: 'button', className: 'chip', textContent: '고치기' });
      editButton.addEventListener('click', () => {
        const existing = li.querySelector('.admin__edit');
        if (existing) {
          existing.remove();
          return;
        }
        const form = buildEditForm(ad, () => form.remove());
        li.append(form);
        form.querySelector('input').focus();
      });
      actions.append(editButton);
    }
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
