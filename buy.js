// 광고 구매 화면 — "결제하면 몇 초 만에 내 로고가 날아온다"(PRD 핵심 트리거).
//   순수 로직(예상 지분·폼 검증·문구)은 위쪽에 두고 테스트한다(buy.test.js).
//   아래 createBuyFlow는 브라우저 전용 배선. 최종 검증은 서버가 다시 한다.

const BUY_DEPS = typeof module !== 'undefined' ? require('./shares.js') : { formatSharePercent };

const BUY_NAME_MAX = 16;
const BUY_LOGO_SIZE = 256; // 업로드 전 캔버스로 줄인다 — 용량·EXIF(위치정보) 제거
const ORDER_POLL_MS = 2500;
const ORDER_STORAGE_KEY = 'ad-dodge:last-order';
const FINAL_STATUSES = new Set(['active', 'refund_required', 'expired', 'hidden']);
const SNIPE_ID_RE = /^[a-f0-9]{6,32}$/;
const CHALLENGE_ID_RE = /^[a-f0-9]{10}$/;

const STATUS_MESSAGES = {
  awaiting_deposit: '아래 계좌로 입금하면 바로 붙여 드려요',
  pending_review: '입금 확인! 관리사무소 검수 중 — 확인되면 바로 날아가요',
  active: '게시 완료! 지금 게시판에서 날아가는 중',
  refund_required: '못 붙이게 돼서 환불 대상이에요. 약관의 환불 절차로 돌려드려요',
  expired: '입금 기한이 지났어요. 새로 신청해 주세요',
  hidden: '신고로 잠시 떼어 냈어요. 확인 후 다시 붙이거나 환불해요',
};

/** 예상 지분 분모 — 하우스 광고는 유료 광고가 생기면 빠지므로 세지 않는다 */
function paidSlots(ledger) {
  return ledger.advertisers.filter((a) => !a.isHouse).reduce((sum, a) => sum + a.slots, 0);
}

function estimateShare(mySlots, currentTotalSlots) {
  return mySlots / (currentTotalSlots + mySlots);
}

function formatWon(amount) {
  return `${amount.toLocaleString('ko-KR')}원`;
}

/** 스킴이 없으면 https로 보고, http(s)인지만 즉시 확인(최종 판정은 서버 moderation.validateLandingUrl) */
function isHttpUrl(text) {
  const t = String(text).trim();
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function validateBuyForm({ kind, name, slots, image, landingUrl, consents }) {
  const errors = [];
  const trimmed = String(name || '').trim();
  if (!trimmed) errors.push('광고 이름을 적어 주세요');
  else if ([...trimmed].length > BUY_NAME_MAX) errors.push(`이름은 ${BUY_NAME_MAX}자까지예요`);
  if (!Number.isInteger(slots) || slots < 1) errors.push('칸 수는 1 이상 정수로 적어 주세요');
  if (kind === 'logo' && !image) errors.push('로고 이미지를 올려 주세요');
  if (landingUrl && !isHttpUrl(landingUrl)) errors.push('이동 주소는 http(s) 웹사이트 주소만 쓸 수 있어요');
  const c = consents || {};
  if (!(c.rights && c.dilution && c.refund)) errors.push('필수 동의 3가지에 모두 체크해 주세요');
  return errors;
}

function buildSnipeUrl(origin, advertiserId) {
  return `${origin}/?snipe=${advertiserId}`;
}

function readSnipeId(search) {
  const id = new URLSearchParams(search).get('snipe');
  return id && SNIPE_ID_RE.test(id) ? id : null;
}

function readChallengeId(search) {
  const id = new URLSearchParams(search).get('challenge');
  return id && CHALLENGE_ID_RE.test(id) ? id : null;
}

function buildChallengeUrl(origin, id) {
  return `${origin}/?challenge=${id}`;
}

/** 광고 성과(참고용 기록 — 약속 아님) */
function statsText(stats) {
  if (!stats || (stats.seen === 0 && stats.kills === 0 && stats.visits === 0)) return '아직 기록 없음 — 곧 날아가요';
  const f = (n) => n.toLocaleString('ko-KR');
  return `${f(stats.seen)}번 날아감 · ${f(stats.kills)}명 쓰러뜨림 · 사이트 이동 ${f(stats.visits)}회`;
}

function canTopup(status) {
  return status === 'active';
}

function orderStatusMessage(status) {
  return STATUS_MESSAGES[status] || '상태를 확인하는 중이에요';
}

function submitLabel(config) {
  return config.freeMode ? '게시판에 바로 붙이기 (테스트 모드)' : '가상계좌 받기';
}

function isFinalStatus(status) {
  return FINAL_STATUSES.has(status);
}

function purchaseBannerText({ name, slots, share }) {
  return `${name} · ${slots.toLocaleString('ko-KR')}칸 붙임 · 지분 ${BUY_DEPS.formatSharePercent(share)}`;
}

// ── 브라우저 전용 ─────────────────────────────────────────────

/** 파일 → 정사각 BUY_LOGO_SIZE PNG data URL (가운데 크롭) */
function fileToLogoDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = BUY_LOGO_SIZE;
      canvas.height = BUY_LOGO_SIZE;
      canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, BUY_LOGO_SIZE, BUY_LOGO_SIZE);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 읽을 수 없어요. PNG·JPG로 다시 올려 주세요'));
    };
    img.src = url;
  });
}

function saveLastOrder(orderId) {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, orderId);
  } catch {
    /* 사생활 보호 모드 등 — 재방문 복구만 못 할 뿐 */
  }
}

function loadLastOrder() {
  try {
    return localStorage.getItem(ORDER_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * deps: { doc, api, getLedger: () => ledger, config: { devDeposit, freeMode }, onClose(), onPosted() }
 * 반환: { open() }
 */
function createBuyFlow({ doc, api, getLedger, config, onClose, onPosted = () => {} }) {
  const $ = (id) => doc.getElementById(id);
  const form = $('buy-form');
  $('btn-buy-submit').textContent = submitLabel(config);
  let logoDataUrl = null;
  let pollTimer = null;
  // 화면을 닫거나 새 주문을 시작하면 진행 중인 폴링 응답은 버린다(코드 리뷰 HIGH — 다른 주문 계좌번호 덮어쓰기)
  const pollGate = createLatestGate();
  const stopPolling = () => {
    pollGate.cancel();
    clearTimeout(pollTimer);
  };

  const readForm = () => ({
    kind: form.elements.kind.value,
    name: form.elements.name.value,
    slots: Number(form.elements.slots.value),
    image: form.elements.kind.value === 'logo' ? logoDataUrl : undefined,
    landingUrl: form.elements.landingUrl.value.trim(),
    consents: { rights: form.elements.consentRights.checked, dilution: form.elements.consentDilution.checked, refund: form.elements.consentRefund.checked },
  });

  const refreshPreview = () => {
    const { kind, slots } = readForm();
    $('buy-logo-field').hidden = kind !== 'logo';
    const valid = Number.isInteger(slots) && slots > 0;
    const ledger = getLedger();
    const total = paidSlots(ledger);
    $('buy-amount').textContent = valid ? formatWon(slots * ledger.slotPrice) : '-';
    $('buy-share').textContent = valid ? BUY_DEPS.formatSharePercent(estimateShare(slots, total)) : '-';
  };

  const showStep = (step) => {
    $('buy-step-form').hidden = step !== 'form';
    $('buy-step-pay').hidden = step !== 'pay';
  };

  const renderOrder = (order) => {
    $('pay-status').textContent = orderStatusMessage(order.status);
    $('pay-bank').textContent = order.virtualAccount.bank;
    $('pay-account').textContent = order.virtualAccount.accountNumber;
    $('pay-holder').textContent = order.virtualAccount.holder;
    $('pay-amount').textContent = formatWon(order.amount);
    $('pay-due').textContent = new Date(order.virtualAccount.dueAt).toLocaleString('ko-KR');
    $('pay-account-box').hidden = order.status !== 'awaiting_deposit';
    const wasPosted = !$('pay-stamp').hidden;
    $('pay-stamp').hidden = order.status !== 'active';
    if (order.status === 'active' && !wasPosted) onPosted();
    $('pay-stats').hidden = order.status !== 'active';
    $('pay-stats-text').textContent = statsText(order.stats);
    $('pay-topup').hidden = !canTopup(order.status);
    $('btn-dev-deposit').hidden = !(config.devDeposit && order.status === 'awaiting_deposit');
    const snipe = order.kind === 'snipe' && order.status === 'active';
    $('pay-snipe').hidden = !snipe;
    if (snipe) $('pay-snipe-url').value = buildSnipeUrl(location.origin, order.advertiserId);
  };

  const poll = (orderId, token = pollGate.next()) => {
    clearTimeout(pollTimer);
    api
      .order(orderId)
      .then((order) => {
        if (!pollGate.isLatest(token)) return;
        renderOrder(order);
        if (!isFinalStatus(order.status)) pollTimer = setTimeout(() => poll(orderId, token), ORDER_POLL_MS);
      })
      .catch((err) => {
        if (!pollGate.isLatest(token)) return;
        $('pay-status').textContent = err.message;
        pollTimer = setTimeout(() => poll(orderId, token), ORDER_POLL_MS * 2);
      });
  };

  const submit = async (e) => {
    e.preventDefault();
    const data = readForm();
    const errors = validateBuyForm(data);
    $('buy-errors').textContent = errors.join(' · ');
    if (errors.length) return;
    const button = $('btn-buy-submit');
    button.disabled = true;
    try {
      const order = await api.createOrder({ ...data, name: data.name.trim() });
      saveLastOrder(order.orderId);
      $('buy-step-pay').dataset.orderId = order.orderId;
      showStep('pay');
      renderOrder(order);
      poll(order.orderId);
    } catch (err) {
      $('buy-errors').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  };

  form.addEventListener('input', refreshPreview);
  form.addEventListener('submit', submit);
  form.elements.logo.addEventListener('change', async () => {
    const file = form.elements.logo.files[0];
    logoDataUrl = null;
    $('buy-logo-preview').hidden = true;
    if (!file) return;
    try {
      logoDataUrl = await fileToLogoDataUrl(file);
      $('buy-logo-preview').src = logoDataUrl;
      $('buy-logo-preview').hidden = false;
    } catch (err) {
      $('buy-errors').textContent = err.message;
    }
  });
  $('btn-dev-deposit').addEventListener('click', async () => {
    try {
      renderOrder(await api.devDeposit($('buy-step-pay').dataset.orderId));
    } catch (err) {
      $('pay-status').textContent = err.message;
    }
  });
  $('btn-topup').addEventListener('click', async () => {
    const slots = Number($('topup-slots').value);
    if (!Number.isInteger(slots) || slots < 1) {
      $('pay-status').textContent = '추가할 칸 수를 1 이상 정수로 적어 주세요';
      return;
    }
    if (!$('topup-consent').checked) {
      $('pay-status').textContent = '같은 약관·희석 규칙에 동의해 주세요';
      return;
    }
    const button = $('btn-topup');
    button.disabled = true;
    try {
      const consents = { rights: true, dilution: true, refund: true };
      const order = await api.topup($('buy-step-pay').dataset.orderId, { slots, consents });
      $('buy-step-pay').dataset.orderId = order.orderId;
      $('pay-stamp').hidden = true;
      renderOrder(order);
      poll(order.orderId);
    } catch (err) {
      $('pay-status').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  $('btn-copy-snipe').addEventListener('click', async () => {
    const input = $('pay-snipe-url');
    try {
      await navigator.clipboard.writeText(input.value);
      $('btn-copy-snipe').textContent = '복사됨!';
    } catch {
      input.select();
    }
  });
  $('btn-buy-close').addEventListener('click', () => {
    stopPolling();
    onClose();
  });

  return {
    open() {
      stopPolling();
      const last = loadLastOrder();
      form.reset();
      logoDataUrl = null;
      $('buy-logo-preview').hidden = true;
      $('buy-errors').textContent = '';
      showStep('form');
      refreshPreview();
      $('buy-resume').hidden = !last;
      $('buy-resume').onclick = () => {
        $('buy-step-pay').dataset.orderId = last;
        showStep('pay');
        poll(last);
      };
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { readChallengeId, buildChallengeUrl, statsText, canTopup, submitLabel, paidSlots, estimateShare, formatWon, validateBuyForm, buildSnipeUrl, readSnipeId, orderStatusMessage, isFinalStatus, purchaseBannerText };
}
