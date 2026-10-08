// 서버 API 클라이언트 — fetch·EventSource 래퍼. 판정은 전부 서버(server/orders.js)가 한다.
//   서버 없이 정적 파일만 열었을 때(M1처럼)도 게임이 돌도록, 장부 조회 실패는 null로 돌려주고
//   app.js가 하우스 시드 장부로 대체한다.

const API_TIMEOUT_MS = 8000;

/**
 * "가장 최근에 시작한 요청의 응답만 반영" 게이트. 늦게 도착한 옛 응답(장부 역전)이나
 * 화면을 닫은 뒤 도착한 응답(주문 폴링 좀비)이 화면을 덮어쓰지 못하게 한다.
 */
function createLatestGate() {
  let current = 0;
  return {
    next: () => {
      current += 1;
      return current;
    },
    isLatest: (token) => token === current,
    cancel: () => {
      current += 1;
    },
  };
}

/** 서버가 꺼져 있을 때 브라우저가 던지는 "Failed to fetch"(TypeError)를 알아듣는 문구로 바꾼다 */
function friendlyNetworkError(err) {
  if (err instanceof TypeError) return new Error('서버에 연결할 수 없어요. 서버가 켜져 있는지 확인해 주세요');
  return err;
}

async function apiRequest(path, { method = 'GET', body, keepalive = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      keepalive,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('서버 응답이 늦어요. 잠시 후 다시 시도해 주세요');
    throw friendlyNetworkError(err);
  } finally {
    clearTimeout(timer);
  }
}

const api = {
  config: () => apiRequest('/api/config'),
  ledger: () => apiRequest('/api/ledger'),
  createOrder: (form) => apiRequest('/api/orders', { method: 'POST', body: form }),
  order: (orderId) => apiRequest(`/api/orders/${encodeURIComponent(orderId)}`),
  devDeposit: (orderId) => apiRequest(`/api/dev/deposit/${encodeURIComponent(orderId)}`, { method: 'POST', body: {} }),
  // 죽자마자 광고주 사이트로 이동해도 킬 기록이 끊기지 않게 sendBeacon(페이지를 떠나도 브라우저가 전송 보장).
  // fetch keepalive만으로는 이동 직후 요청이 유실되는 것을 실제로 확인했다.
  kill(advId) {
    const payload = JSON.stringify({ advId });
    if (typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon('/api/kills', new Blob([payload], { type: 'application/json' }))) {
      return Promise.resolve(null);
    }
    return apiRequest('/api/kills', { method: 'POST', body: { advId }, keepalive: true });
  },
  killRanking: () => apiRequest('/api/kills/today'),
  report: (advId, reason) => apiRequest('/api/reports', { method: 'POST', body: { advId, reason } }),
  /** handlers: { purchase(data), takedown(data), reconnect() } → 구독 해제 함수.
   *  SSE는 끊겼다 붙는 사이의 이벤트를 다시 보내지 않으므로, 재연결(open)마다 reconnect()로 전체 재동기화한다. */
  subscribe({ reconnect, ...handlers }) {
    if (typeof EventSource === 'undefined') return () => {};
    const source = new EventSource('/api/events');
    let opened = false;
    source.addEventListener('open', () => {
      if (opened && reconnect) reconnect();
      opened = true;
    });
    for (const [type, fn] of Object.entries(handlers)) {
      source.addEventListener(type, (e) => {
        try {
          fn(JSON.parse(e.data));
        } catch (err) {
          console.warn('[api] 이벤트 처리 실패', type, err);
        }
      });
    }
    return () => source.close();
  },
};

if (typeof module !== 'undefined') {
  module.exports = { api, apiRequest, createLatestGate, friendlyNetworkError };
}
