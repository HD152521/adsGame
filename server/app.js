// HTTP 라우팅 — 요청 검증·레이트 리밋·인증만 하고 규칙은 orders.js에 맡긴다.
//   createApp(config) → { server, service, provider, errorLog, close } (테스트는 포트 0에 띄운다)
//
// 공개 API
//   GET  /api/health                 헬스체크 — 장부를 읽을 수 있으면 200 { ok:true }, 아니면 503 { ok:false } (server/health.js). IP별 분당 30회 리밋
//   GET  /api/config                 클라이언트 설정(모의 입금 버튼 노출 여부)
//   GET  /api/business               사업자 정보(법정 표시, 환경변수) — 필수 값이 비면 ready=false
//   GET  /api/ledger                 장부·지분·보스·공개 규칙
//   GET  /api/events                 SSE: purchase / takedown / review / ledger(관리자 수정)
//   POST /api/orders                 주문 생성 → 가상계좌
//   GET  /api/orders/:orderId        주문 상태(orderId = 비밀 토큰)
//   POST /api/payments/webhook       PG 웹훅(모의: HMAC 서명 / 토스: secret 비교 + 결제 조회 재확인). PG 장애 시 503(재전송 유도)
//   POST /api/kills  | GET /api/kills/today
//   POST /api/reports
//   POST /api/runs                   판 기록 → 오늘 백분위(+킬·등장·사이트 이동 집계)
//   POST /api/challenges | GET /api/challenges/:id   도전장
//   POST /api/orders/:orderId/topup  붙어 있는 내 광고에 칸 추가(orderId = 소유 증명)
// 테스트 모드(freeMode): 주문하면 결제 없이 바로 출연
// 개발 전용(devMode + 모의 PG일 때만): POST /api/dev/deposit/:orderId — 은행 입금 흉내(서명된 웹훅을 내부에서 발생)
// 결제 제공자: payment = { provider: 'mock' | 'toss', tossSecretKey, tossBank } (server/payments.js) — fetch 는 테스트에서 주입
// 관리자(Bearer ADMIN_TOKEN): GET /api/admin/advertisers?status= · POST /api/admin/advertisers/:id/:action
//   · POST /api/admin/advertisers/:id/edit { name?, landingUrl?, image? } — 이름·이동 주소·로고 수정
//   · POST /api/admin/orders/:orderId/refund { refundedAt?, memo? } — 환불 필요 → 환불 완료 기록(주문 단위, 되돌리기 없음)
//   · GET  /api/admin/export.csv?status= — 주문 CSV(UTF-8 BOM·CRLF·CSV 인젝션 방지, 결제 비밀값 없음)
//   · GET  /api/admin/errors — 최근 문제 50건(500 오류·웹훅 검증 실패·PG 장애·백업 실패, server/error-log.js)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createStore } = require('./store.js');
const { createPaymentProvider } = require('./payments.js');
const { createOrderService, ORDER_STATUS } = require('./orders.js');
const { createEventHub, createRateLimiter } = require('./realtime.js');
const { HttpError, readBody, parseJson, send, sendJson, serveStatic } = require('./http-util.js');
const { SEED_LEDGER } = require('../seed-ledger.js');
const { publicBusinessInfo } = require('./business.js');
const { checkLedger } = require('./health.js');
const { ordersToCsv } = require('./export-csv.js');
const { createErrorLog, maskPath, ERROR_LOG_MAX } = require('./error-log.js');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULT_LIMITS = { orders: 5, kills: 60, reports: 10, challenges: 10, runs: 15, health: 30, windowMs: 60_000 };
const VISIT_DEDUP_MAX = 50_000; // 하루치 (IP·광고) 쌍 기억 상한 — 넘치면 비우고 다시
const KNOWN_STATUSES = new Set(Object.values(ORDER_STATUS));
const PG_ERROR_CODES = new Set(['PG_UNAVAILABLE', 'PG_ISSUE_FAILED']);
const KST_OFFSET_MS = 9 * 3600 * 1000;

/** ?status= → 알려진 상태 | undefined(전체). 모르는 값은 400 */
function statusParam(url) {
  const status = url.searchParams.get('status');
  if (!status) return undefined;
  if (!KNOWN_STATUSES.has(status)) throw new HttpError(400, '알 수 없는 상태예요');
  return status;
}

/** 오늘(한국 시각) YYYYMMDD — 내려받는 파일 이름용 */
const kstDay = (ms) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');

// TRUST_PROXY=1 은 "앞단에 신뢰하는 프록시가 정확히 한 단" 있다는 뜻이다. 프록시는 X-Forwarded-For 끝에
// 실제 접속 IP를 덧붙이므로 **마지막** 값만 믿는다 — 앞쪽 값은 클라이언트가 마음대로 넣을 수 있다(보안 리뷰 H1).
function clientIp(req, trustProxy) {
  const hops = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  return hops[hops.length - 1] || req.socket.remoteAddress || 'unknown';
}

function isAdmin(req, adminToken) {
  if (!adminToken) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(adminToken).digest();
  return crypto.timingSafeEqual(a, b);
}

function createImageSaver(dataDir) {
  const dir = path.join(dataDir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return (advertiserId, img) => {
    fs.writeFileSync(path.join(dir, `${advertiserId}.${img.ext}`), img.buffer);
    return `/uploads/${advertiserId}.${img.ext}`;
  };
}

function createApp({ dataDir, adminToken, webhookSecret, devMode: devModeRequested = false, freeMode = false, classifier, limits = DEFAULT_LIMITS, trustProxy = false, business, payment = { provider: 'mock' }, fetch, now = Date.now, errorLog: givenErrorLog }) {
  const businessInfo = publicBusinessInfo(business);
  // 최근 문제 — index.js 가 백업 실패도 같은 곳에 쓰도록 밖에서 넘길 수 있다(그때 S3 키도 가릴 목록에 넣는다)
  const errorLog = givenErrorLog || createErrorLog({ now, secrets: [adminToken, webhookSecret, payment.tossSecretKey] });
  const hub = createEventHub();
  let service = null; // provider 가 웹훅 검증 때 주문에 저장된 secret 을 찾는다(서비스는 아래에서 만든다)
  const provider = createPaymentProvider({ ...payment, webhookSecret, fetch, now, lookupWebhookSecret: (orderId) => service.getWebhookSecret(orderId) });
  // 모의 입금은 모의 PG에서만 — 실제 PG에서 켜 두면 서명 없이 입금 처리되는 길이 생긴다
  const devMode = devModeRequested && provider.name === 'mock';
  const store = createStore({ file: path.join(dataDir, 'db.json') });
  service = createOrderService({
    store,
    provider,
    classifier,
    saveImage: createImageSaver(dataDir),
    broadcast: hub.broadcast,
    now,
    seedLedger: SEED_LEDGER,
    instantActivate: freeMode,
  });
  const limiters = {
    orders: createRateLimiter({ limit: limits.orders, windowMs: limits.windowMs, now }),
    kills: createRateLimiter({ limit: limits.kills, windowMs: limits.windowMs, now }),
    reports: createRateLimiter({ limit: limits.reports, windowMs: limits.windowMs, now }),
    challenges: createRateLimiter({ limit: limits.challenges || DEFAULT_LIMITS.challenges, windowMs: limits.windowMs, now }),
    // 한 판은 최소 몇 초 — 분당 15판 넘게 보고하면 사람이 아니다(광고 성과 부풀리기 방어, 리뷰 M1)
    runs: createRateLimiter({ limit: limits.runs || DEFAULT_LIMITS.runs, windowMs: limits.windowMs, now }),
    // 헬스체크는 인증 없이 매번 장부 전체를 읽는다 — 마구 두드려 디스크 I/O 를 짜내지 못하게(리뷰 M).
    // fly 탐침은 15초 간격(분당 4회)이라 분당 30회면 넉넉하다
    health: createRateLimiter({ limit: limits.health || DEFAULT_LIMITS.health, windowMs: limits.windowMs, now }),
  };
  // 사이트 이동은 같은 사람·같은 광고 하루 한 번만 센다(클라이언트 보고값이라 반복 보고로 부풀릴 수 있음)
  let visitDay = '';
  let visited = new Set();
  const firstVisitToday = (ip, advId) => {
    const day = new Date(now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    if (day !== visitDay || visited.size > VISIT_DEDUP_MAX) {
      visitDay = day;
      visited = new Set();
    }
    const key = `${ip}|${advId}`;
    if (visited.has(key)) return false;
    visited.add(key);
    return true;
  };
  const reporterSalt = crypto.randomBytes(16).toString('hex');

  const limit = (req, name) => {
    if (!limiters[name].hit(clientIp(req, trustProxy))) throw new HttpError(429, '잠시 후 다시 시도해 주세요');
  };
  const asUserError = (fn) => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, err.message);
    }
  };

  async function handleWebhook(req, res) {
    const raw = await readBody(req);
    let payload;
    try {
      payload = await provider.verifyWebhook(req.headers, raw);
    } catch (err) {
      if (err.code === 'PG_UNAVAILABLE') {
        console.error('[webhook] 결제 조회 실패 — PG 재전송을 기다립니다', err.message);
        errorLog.record('pg', `웹훅 결제 조회 실패(재전송 대기): ${err.message}`);
        throw new HttpError(503, '잠시 후 다시 보내 주세요');
      }
      console.warn('[webhook] 검증 실패', err.message);
      errorLog.record('webhook', `웹훅 검증 실패: ${err.message}`);
      throw new HttpError(401, '서명이 올바르지 않아요');
    }
    sendJson(res, 200, asUserError(() => service.confirmDeposit(payload)));
  }

  async function handleDevDeposit(res, orderId) {
    const order = service.getOrder(orderId);
    if (!order) throw new HttpError(404, '주문을 찾을 수 없어요');
    const raw = JSON.stringify({ orderId, status: 'DONE', amount: order.amount });
    const payload = await provider.verifyWebhook({ 'x-mock-signature': provider.sign(raw) }, raw);
    sendJson(res, 200, asUserError(() => service.confirmDeposit(payload)));
  }

  /** 주문 만들기·칸 추가 실패 → 400. PG 장애(가상계좌 발급 실패)는 최근 문제에도 남긴다 */
  const orderError = (err) => {
    if (PG_ERROR_CODES.has(err.code)) errorLog.record('pg', `가상계좌 발급 실패: ${err.detail || err.message}`);
    return new HttpError(400, err.message);
  };

  function sendCsv(res, status) {
    const csv = ordersToCsv(service.exportRows(status));
    const filename = `ad-dodge-orders-${kstDay(now())}${status ? `-${status}` : ''}.csv`;
    send(res, 200, csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' });
  }

  /** 광고(advertisers) 밖의 관리자 API — 환불 완료 기록·CSV 내보내기·최근 문제 */
  async function handleAdminOps(req, res, url, parts) {
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'export.csv') return sendCsv(res, statusParam(url));
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'errors') return sendJson(res, 200, { errors: errorLog.list(), max: ERROR_LOG_MAX });
    if (req.method === 'POST' && parts.length === 4 && parts[1] === 'orders' && parts[3] === 'refund') {
      const body = parseJson(await readBody(req));
      return sendJson(res, 200, asUserError(() => service.markRefunded(parts[2], { refundedAt: body.refundedAt, memo: body.memo })));
    }
    throw new HttpError(404, '찾을 수 없어요');
  }

  async function handleAdmin(req, res, url, parts) {
    if (!isAdmin(req, adminToken)) throw new HttpError(401, '관리자 인증이 필요해요');
    // parts: ['admin', 'advertisers', id?, action?] | ['admin', 'orders', orderId, 'refund'] | ['admin', 'export.csv'] | ['admin', 'errors']
    if (parts[1] !== 'advertisers') return handleAdminOps(req, res, url, parts);
    if (req.method === 'GET' && parts.length === 2) {
      sendJson(res, 200, service.listAdvertisers(statusParam(url)));
      return;
    }
    if (req.method === 'POST' && parts.length === 4 && parts[3] === 'edit') {
      const body = parseJson(await readBody(req));
      sendJson(res, 200, asUserError(() => service.editAdvertiser(parts[2], body)));
      return;
    }
    if (req.method === 'POST' && parts.length === 4) {
      sendJson(res, 200, asUserError(() => service.adminAction(parts[2], parts[3])));
      return;
    }
    throw new HttpError(404, '찾을 수 없어요');
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // 'api' 뒤
    const key = `${req.method} ${parts[0] || ''}`;

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않은 요청이에요');
      serveStatic(req, res, APP_ROOT, dataDir);
      return;
    }
    if (parts[0] === 'admin') return handleAdmin(req, res, url, parts);

    switch (key) {
      case 'GET health': {
        limit(req, 'health');
        const health = await checkLedger(dataDir);
        if (!health.ok) console.error('[health]', health.reason);
        return sendJson(res, health.ok ? 200 : 503, health.ok ? { ok: true } : { ok: false, error: '장부를 읽을 수 없습니다' });
      }
      case 'GET config':
        return sendJson(res, 200, { devDeposit: devMode, freeMode, provider: provider.name });
      case 'GET business':
        return sendJson(res, 200, businessInfo);
      case 'GET ledger':
        return sendJson(res, 200, service.getLedger());
      case 'GET events':
        return hub.handle(req, res, clientIp(req, trustProxy));
      case 'POST orders': {
        limit(req, 'orders');
        if (parts[2] === 'topup') {
          const body = parseJson(await readBody(req));
          const topup = await service.createTopup(String(parts[1]), body).catch((err) => {
            throw orderError(err);
          });
          return sendJson(res, 201, topup);
        }
        const body = parseJson(await readBody(req));
        const order = await service.createOrder(body).catch((err) => {
          throw orderError(err);
        });
        return sendJson(res, 201, order);
      }
      case 'POST runs': {
        limit(req, 'runs');
        const body = parseJson(await readBody(req));
        const redirected = body.redirected === true && Boolean(body.killerId) && firstVisitToday(clientIp(req, trustProxy), String(body.killerId));
        return sendJson(res, 200, asUserError(() => service.recordRun({ ...body, redirected })));
      }
      case 'POST challenges': {
        limit(req, 'challenges');
        const body = parseJson(await readBody(req));
        return sendJson(res, 201, asUserError(() => service.createChallenge(body)));
      }
      case 'GET challenges': {
        const c = service.getChallenge(String(parts[1] || ''));
        if (!c) throw new HttpError(404, '도전장을 찾을 수 없어요');
        return sendJson(res, 200, c);
      }
      case 'GET orders': {
        const order = service.getOrder(parts[1]);
        if (!order) throw new HttpError(404, '주문을 찾을 수 없어요');
        return sendJson(res, 200, order);
      }
      case 'POST payments':
        if (parts[1] !== 'webhook') break;
        return handleWebhook(req, res);
      case 'POST dev':
        if (!devMode || parts[1] !== 'deposit') break;
        return handleDevDeposit(res, parts[2]);
      case 'POST kills': {
        limit(req, 'kills');
        const { advId } = parseJson(await readBody(req));
        asUserError(() => service.recordKill(String(advId)));
        res.writeHead(204).end();
        return undefined;
      }
      case 'GET kills':
        return sendJson(res, 200, service.getKillRanking());
      case 'POST reports': {
        limit(req, 'reports');
        const { advId, reason } = parseJson(await readBody(req));
        const reporter = crypto.createHash('sha256').update(reporterSalt + clientIp(req, trustProxy)).digest('hex').slice(0, 16);
        return sendJson(res, 202, asUserError(() => service.report({ advId: String(advId), reason, reporter })));
      }
      default:
        break;
    }
    throw new HttpError(404, '찾을 수 없어요');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) {
        console.error('[server]', req.method, req.url, err);
        // 요청 본문·쿼리는 남기지 않는다(경로의 주문번호도 앞 8자리만)
        errorLog.record('server', `${req.method} ${maskPath(req.url)}: ${err && err.message ? err.message : err}`);
      }
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요' : err.message });
      else res.end();
    });
  });

  return {
    server,
    service,
    provider,
    errorLog,
    close() {
      store.flush();
      store.close();
      hub.close();
      server.close();
      server.closeAllConnections?.();
    },
  };
}

module.exports = { createApp, clientIp };
