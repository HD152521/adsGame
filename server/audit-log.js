// 관리자 감사 로그(계획서 Step 6) — 관리자 작업을 누가·언제·무엇으로 장부(store)에 남긴다.
//   작업: 승인(approve)·거절(reject)·가림(hide)·복구(restore)·수정(edit)·환불 완료(refund)·CSV 내보내기(export)
//   누가: 가린 IP(IPv4 끝자리·IPv6 뒤쪽 *) + 토큰 지문(sha256 앞 8자리). 토큰 원문은 남기지 않는다
//   무엇: 주문번호 앞 8자리(전체 orderId 는 주문 조회 비밀 토큰이라 금지)·공개 광고 id·바뀐 필드 "이름"만(값은 남기지 않음)
//   쓰기: 돈 기록과 같은 즉시 쓰기(store.update 기본값) — 응답하기 전에 디스크에 있다. 성공한 작업만 기록한다.
//   상한: 최근 AUDIT_MAX(2000)건 — 넘치면 오래된 것부터 버린다(장부 파일이 끝없이 커지지 않게).
//   실행 검증: apps/ad-dodge 안에서 node --test (server/audit-log.test.js, server/admin-security.test.js)

const crypto = require('node:crypto');

const AUDIT_MAX = 2000;
const AUDIT_ACTIONS = new Set(['approve', 'reject', 'hide', 'restore', 'edit', 'refund', 'export']);
const ORDER_PREFIX = 8;
const FINGERPRINT_LENGTH = 8;
const NOTE_MAX = 100;
const ADVERTISER_ID = /^[a-z0-9-]{1,40}$/i;

/** 접속 IP → 가린 IP(개인정보 최소화) */
function maskIp(raw) {
  const ip = String(raw || '').replace(/^::ffff:/i, '');
  if (!ip) return 'unknown';
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.*`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}:*`;
  return 'unknown';
}

/** 토큰 → 지문(sha256 앞 8자리). 토큰이 바뀌면(교체) 지문도 바뀌어 "어느 토큰으로" 했는지 구분된다 */
function tokenFingerprint(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

function createAuditLog({ store, now = Date.now, max = AUDIT_MAX }) {
  const entries = () => store.read().audit || [];

  return {
    /** 성공한 관리자 작업 하나를 즉시 기록한다. 모르는 작업 이름은 거부 */
    record({ ip, token, action, orderId, advertiserId, fields = [], note = '' }) {
      if (!AUDIT_ACTIONS.has(action)) throw new Error(`알 수 없는 관리자 작업: ${String(action).slice(0, 20)}`);
      const entry = Object.freeze({
        at: now(),
        actor: tokenFingerprint(token),
        ip: maskIp(ip),
        action,
        order: orderId ? String(orderId).slice(0, ORDER_PREFIX) : null,
        advertiser: advertiserId && ADVERTISER_ID.test(String(advertiserId)) ? String(advertiserId) : null,
        fields: Object.freeze(fields.map(String)),
        note: String(note).slice(0, NOTE_MAX),
      });
      store.update((s) => ({ ...s, audit: [...(s.audit || []), entry].slice(-max) }));
      return entry;
    },
    /** 최신이 맨 앞. limit 건까지 복사본으로 */
    list(limit = max) {
      return entries().slice(-limit).reverse().map((e) => ({ ...e, fields: [...e.fields] }));
    },
  };
}

module.exports = { createAuditLog, maskIp, tokenFingerprint, AUDIT_MAX, AUDIT_ACTIONS };
