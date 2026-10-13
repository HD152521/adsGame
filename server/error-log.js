// 최근 문제(오류 알림) 링버퍼 — 500 오류·웹훅 검증 실패·PG 장애·백업 실패를 메모리에 최근 50건만 모은다.
//   관리자 GET /api/admin/errors 와 관리자 화면 상단 "최근 문제" 칸에 보인다. 재시작하면 비워진다(로그는 fly logs 에).
//   남기는 것: 시각·종류·짧은 설명뿐. 요청 본문·쿼리는 애초에 받지 않고, 설명 안의 비밀값은 가린다:
//     · 설정된 비밀값(관리자 토큰·웹훅 비밀값·토스 키·S3 키) → [비밀값]
//     · 토스 키 모양(test_sk_… / live_sk_…)·Bearer 토큰 → [비밀값]
//     · 16자 넘는 hex(orderId·결제 secret 등) → 앞 8자리…
//   실행 검증: apps/ad-dodge 안에서 node --test (server/error-log.test.js, server/app-ops.test.js)

const ERROR_LOG_MAX = 50;
const MESSAGE_MAX = 300;
const MIN_SECRET_LENGTH = 8; // 너무 짧은 값까지 가리면 일반 낱말이 지워진다(실제 비밀값은 16자 이상)
const ERROR_KINDS = new Set(['server', 'webhook', 'pg', 'backup']);
const REDACTED = '[비밀값]';
const LONG_HEX = /[a-f0-9]{16,}/gi;
const KEY_PATTERNS = [/\b(?:test|live)_(?:sk|gsk|ck)_[A-Za-z0-9_-]+/g, /Bearer\s+\S+/gi];

const shortenHex = (s) => s.replace(LONG_HEX, (m) => `${m.slice(0, 8)}…`);

/** 요청 경로 → 기록용(쿼리 버림, 긴 hex 조각은 앞 8자리만) */
function maskPath(rawPath) {
  return shortenHex(String(rawPath || '').split('?')[0]);
}

function createErrorLog({ max = ERROR_LOG_MAX, now = Date.now, secrets = [] } = {}) {
  const known = secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH);
  let entries = [];

  const clean = (raw) => {
    let s = raw instanceof Error ? raw.message : String(raw);
    for (const secret of known) s = s.split(secret).join(REDACTED);
    for (const re of KEY_PATTERNS) s = s.replace(re, REDACTED);
    return shortenHex(s).slice(0, MESSAGE_MAX);
  };

  return {
    /** kind: server | webhook | pg | backup (그 밖은 other) */
    record(kind, message) {
      const entry = Object.freeze({ at: now(), kind: ERROR_KINDS.has(kind) ? kind : 'other', message: clean(message) });
      entries = [entry, ...entries].slice(0, max);
    },
    /** 최신이 맨 앞. 복사본을 돌려준다 */
    list: () => entries.map((e) => ({ ...e })),
  };
}

module.exports = { createErrorLog, maskPath, ERROR_LOG_MAX };
