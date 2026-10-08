// HTTP 라우팅 — 요청 검증·레이트 리밋·인증만 하고 규칙은 orders.js에 맡긴다.
//   createApp(config) → { server, service, provider, close } (테스트는 포트 0에 띄운다)
//
// 공개 API
//   GET  /api/config                 클라이언트 설정(모의 입금 버튼 노출 여부)
//   GET  /api/ledger                 장부·지분·보스·공개 규칙
//   GET  /api/events                 SSE: purchase / takedown / review
//   POST /api/orders                 주문 생성 → 가상계좌
//   GET  /api/orders/:orderId        주문 상태(orderId = 비밀 토큰)
//   POST /api/payments/webhook       PG 웹훅(서명 검증)
//   POST /api/kills  | GET /api/kills/today
//   POST /api/reports
// 테스트 모드(freeMode): 주문하면 결제 없이 바로 출연
// 개발 전용(devMode): POST /api/dev/deposit/:orderId — 은행 입금 흉내(서명된 웹훅을 내부에서 발생)
// 관리자(Bearer ADMIN_TOKEN): GET /api/admin/advertisers?status= · POST /api/admin/advertisers/:id/:action

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createStore } = require('./store.js');
const { createMockProvider } = require('./payments.js');
const { createOrderService } = require('./orders.js');
const { createEventHub, createRateLimiter } = require('./realtime.js');
const { HttpError, readBody, parseJson, sendJson, serveStatic } = require('./http-util.js');
const { SEED_LEDGER } = require('../seed-ledger.js');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULT_LIMITS = { orders: 5, kills: 60, reports: 10, windowMs: 60_000 };

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

function createApp({ dataDir, adminToken, webhookSecret, devMode = false, freeMode = false, classifier, limits = DEFAULT_LIMITS, trustProxy = false, now = Date.now }) {
  const hub = createEventHub();
  const provider = createMockProvider({ secret: webhookSecret, now });
  const service = createOrderService({
    store: createStore({ file: path.join(dataDir, 'db.json') }),
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
      payload = provider.verifyWebhook(req.headers, raw);
    } catch (err) {
      console.warn('[webhook] 서명 검증 실패', err.message);
      throw new HttpError(401, '서명이 올바르지 않아요');
    }
    sendJson(res, 200, asUserError(() => service.confirmDeposit(payload)));
  }

  async function handleDevDeposit(res, orderId) {
    const order = service.getOrder(orderId);
    if (!order) throw new HttpError(404, '주문을 찾을 수 없어요');
    const raw = JSON.stringify({ orderId, status: 'DONE', amount: order.amount });
    sendJson(res, 200, asUserError(() => service.confirmDeposit(provider.verifyWebhook({ 'x-mock-signature': provider.sign(raw) }, raw))));
  }

  async function handleAdmin(req, res, url, parts) {
    if (!isAdmin(req, adminToken)) throw new HttpError(401, '관리자 인증이 필요해요');
    // parts: ['admin', 'advertisers', id?, action?]
    if (parts[1] !== 'advertisers') throw new HttpError(404, '찾을 수 없어요');
    if (req.method === 'GET' && parts.length === 2) {
      sendJson(res, 200, service.listAdvertisers(url.searchParams.get('status') || undefined));
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
      case 'GET config':
        return sendJson(res, 200, { devDeposit: devMode, freeMode, provider: provider.name });
      case 'GET ledger':
        return sendJson(res, 200, service.getLedger());
      case 'GET events':
        return hub.handle(req, res, clientIp(req, trustProxy));
      case 'POST orders': {
        limit(req, 'orders');
        const body = parseJson(await readBody(req));
        const order = await service.createOrder(body).catch((err) => {
          throw new HttpError(400, err.message);
        });
        return sendJson(res, 201, order);
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
      if (status === 500) console.error('[server]', req.method, req.url, err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? '서버에 문제가 생겼어요. 잠시 후 다시 시도해 주세요' : err.message });
      else res.end();
    });
  });

  return {
    server,
    service,
    provider,
    close() {
      hub.close();
      server.close();
      server.closeAllConnections?.();
    },
  };
}

module.exports = { createApp, clientIp };
