// 광고 지분 계산 + 가중 추첨 — 순수 함수만. 저장·결제(M2)는 이 파일의 책임이 아니다.
//
// ── 핵심 규칙 (PRD "핵심 규칙") ────────────────────────────────────────
//   전체 판매 한도 1,000,000칸, 1칸 = 1,000원.
//   광고주 등장 확률 = 보유 칸 ÷ "판매된" 전체 칸. (한도 1,000,000이 분모가 아니다 —
//   분모를 한도로 잡으면 초반 광고주는 0.001% 단위라 사실상 등장하지 않는다.)
//   새 구매가 들어오면 기존 지분은 희석된다. 광고주에게 약속하는 것은 노출 횟수가 아니라 확률이다.
//
//   확률이 칸 수에 정비례하므로 구매를 쪼개거나 여러 계정으로 나눠도 이득이 없다
//   (shares.test.js "쪼개기 무이득"). 표시 지분과 실제 추첨 확률이 같다는 것도 통계 테스트로 검증한다.
//   실행 검증: apps/ad-dodge 안에서 node --test (shares.test.js)

const SLOT_PRICE = 1000;
const MAX_SLOTS = 1000000;

/**
 * 장부 항목: { id: string, name: string, slots: number, logo?: string, isHouse?: boolean }
 * 문제가 있으면 한국어 메시지로 throw 한다(fail fast).
 */
function validateLedger(ledger) {
  if (!Array.isArray(ledger)) throw new Error('장부는 배열이어야 합니다');
  let total = 0;
  for (const e of ledger) {
    if (!e || typeof e.id !== 'string' || e.id.length === 0) throw new Error('장부 항목에 id가 없습니다');
    if (!Number.isInteger(e.slots) || e.slots < 1) throw new Error(`칸 수는 1 이상의 정수여야 합니다 (id=${e.id})`);
    total += e.slots;
  }
  if (total > MAX_SLOTS) throw new Error(`판매 한도 ${MAX_SLOTS.toLocaleString('en-US')}칸을 넘었습니다`);
  return ledger;
}

function totalSoldSlots(ledger) {
  return ledger.reduce((sum, e) => sum + e.slots, 0);
}

/** 같은 id의 구매를 합산해 지분 내림차순으로 돌려준다. 입력은 변경하지 않는다. */
function computeShares(ledger) {
  validateLedger(ledger);
  const total = totalSoldSlots(ledger);
  if (total === 0) return [];
  const byId = new Map();
  for (const e of ledger) {
    const prev = byId.get(e.id);
    byId.set(e.id, prev ? { ...prev, slots: prev.slots + e.slots } : { ...e });
  }
  return [...byId.values()]
    .map((a) => ({ ...a, share: a.slots / total }))
    .sort((x, y) => y.slots - x.slots || x.id.localeCompare(y.id));
}

/** 지분 비율대로 하나를 뽑는다. 판매 0칸이면 null. */
function pickAdvertiser(shares, rng) {
  if (shares.length === 0) return null;
  const r = rng();
  let acc = 0;
  for (const s of shares) {
    acc += s.share;
    if (r < acc) return s;
  }
  return shares[shares.length - 1]; // 부동소수 누적 오차로 acc가 1에 못 미칠 때
}

// ── 공개 규칙 (시작 화면 전광판·약관에 그대로 적는다) ──────────────────────
// 보스: 하우스가 아닌 광고주 중 최다 칸. 동률이면 먼저 결제한 쪽. 보스 발사체는 크고 빠르다(game.js).
//   보스는 등장 "확률"을 바꾸지 않는다 — 크기·속도만 다르다. 표시 지분 = 실제 확률 원칙 유지.
// 친구 저격: 저격 링크(?snipe=id)로 들어온 판에서만, 스폰의 SNIPE_RATE는 저격 광고, 나머지는 지분대로.
//   저격 링크가 아닌 판에는 영향이 없다.
const SNIPE_RATE = 0.2;

function findBossId(shares) {
  const paid = shares.filter((s) => !s.isHouse);
  if (paid.length === 0) return null;
  const firstPaid = (s) => (Number.isFinite(s.firstPaidAt) ? s.firstPaidAt : Infinity);
  const best = paid.reduce((a, b) => (b.slots > a.slots || (b.slots === a.slots && firstPaid(b) < firstPaid(a)) ? b : a));
  return best.id;
}

/** (rng) => advId | null. snipeId가 장부에 없으면(가려짐·오타) 저격 규칙을 적용하지 않는다. */
function createPicker(shares, snipeId) {
  const hasSnipe = Boolean(snipeId) && shares.some((s) => s.id === snipeId);
  return (rng) => {
    if (hasSnipe && rng() < SNIPE_RATE) return snipeId;
    const picked = pickAdvertiser(shares, rng);
    return picked ? picked.id : null;
  };
}

/** 0.5 → "50%", 0.12345 → "12.35%", 0.00001 → "0.001%" (의미 있는 자리까지) */
function formatSharePercent(share) {
  if (share === 0) return '0%';
  const pct = share * 100;
  const digits = pct >= 1 ? 2 : Math.min(6, Math.ceil(-Math.log10(pct)) + 1);
  return `${Number(pct.toFixed(digits))}%`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    SLOT_PRICE,
    MAX_SLOTS,
    validateLedger,
    totalSoldSlots,
    computeShares,
    pickAdvertiser,
    formatSharePercent,
    SNIPE_RATE,
    findBossId,
    createPicker,
  };
}
