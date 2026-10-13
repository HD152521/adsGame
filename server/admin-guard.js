// 관리자 경로 문지기(계획서 Step 6) — /api/admin/* 전체에 IP별 전용 버킷 + 토큰 실패 반복 차단.
//   - allow(ip): 토큰 검사 "전에" 부른다. 차단 중이거나 요청 버킷(분당 120회)을 넘으면 false → 429
//   - fail(ip):  토큰이 틀렸을 때 부른다. 5분 안에 10회를 넘게 틀리면 그 IP를 15분 막는다 → true(지금 막힘)
//   정상 관리자 사용(화면 한 번 = 요청 3개, 새로고침 수십 번, 오타 몇 번)은 걸리지 않는 수준이다.
//   IP는 app.js clientIp(TRUST_PROXY 면 X-Forwarded-For 마지막 값)로 받는다 — 앞쪽 값을 바꿔도 우회되지 않는다.
//   차단 목록은 메모리에만(재시작하면 풀림). 크기가 커지면 끝난 차단부터 지운다.
//   실행 검증: apps/ad-dodge 안에서 node --test (server/admin-security.test.js)

const { createRateLimiter } = require('./realtime.js');

const ADMIN_GUARD_DEFAULTS = Object.freeze({
  requests: 120, // IP별 분당 관리자 요청
  windowMs: 60_000,
  failures: 10, // 이 횟수까지는 401, 넘으면 차단
  failureWindowMs: 5 * 60_000,
  blockMs: 15 * 60_000,
});
const MAX_BLOCKED_IPS = 10_000;

function createAdminGuard({ now = Date.now, ...options } = {}) {
  const cfg = { ...ADMIN_GUARD_DEFAULTS, ...options };
  const requests = createRateLimiter({ limit: cfg.requests, windowMs: cfg.windowMs, now });
  const failures = createRateLimiter({ limit: cfg.failures, windowMs: cfg.failureWindowMs, now });
  let blockedUntil = new Map();

  const isBlocked = (ip) => (blockedUntil.get(ip) || 0) > now();

  const block = (ip) => {
    const t = now();
    if (blockedUntil.size >= MAX_BLOCKED_IPS) blockedUntil = new Map([...blockedUntil].filter(([, until]) => until > t));
    blockedUntil = new Map(blockedUntil).set(ip, t + cfg.blockMs);
  };

  return {
    /** 토큰 검사 전 — false 면 429 */
    allow(ip) {
      if (isBlocked(ip)) return false;
      return requests.hit(ip);
    },
    /** 토큰 실패 기록 → 이번 실패로 막혔으면 true */
    fail(ip) {
      if (failures.hit(ip)) return false;
      block(ip);
      return true;
    },
    blockMinutes: Math.round(cfg.blockMs / 60_000),
  };
}

module.exports = { createAdminGuard, ADMIN_GUARD_DEFAULTS };
