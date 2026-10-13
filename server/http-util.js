// HTTP 공용 도구 — 본문 읽기(크기 상한), JSON 응답, 보안 헤더, 정적 파일(허용 목록 방식).
//   정적 파일은 "막을 것"이 아니라 "보여줄 것"만 정규식으로 허용한다 — server/, *.test.js,
//   data/ 가 실수로 노출되는 경로를 원천 차단한다(app.test.js "노출되지 않는다").

const fs = require('node:fs');
const path = require('node:path');

const MAX_BODY_BYTES = 1024 * 1024;

const SECURITY_HEADERS = {
  // 스크립트는 self만. 스타일은 Google Fonts(게시판 글꼴 4종)와 종이 기울기(style="--tilt")용 인라인 허용 —
  // 인라인 스타일은 스크립트 실행 경로가 아니고, 사용자 입력은 전부 textContent로만 들어간다.
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};

const MIME = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

const PUBLIC_FILE = /^(?:(?!.*\.test\.js$)(?!dom-stub\.js$)[a-z0-9-]+\.(?:html|css|js)|assets\/logos\/[a-z0-9-]+\.svg)$/;
const UPLOAD_FILE = /^uploads\/([a-f0-9]{12})\.(png|jpg|webp)$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '요청이 너무 커요'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 요청 본문 → JSON 객체. 빈 본문은 {}. null·배열·숫자·문자열은 400 —
 *  구조 분해(const { advId } = …)가 TypeError 로 터지며 내부 문구가 새지 않게(Step 5 리뷰 LOW) */
function parseJson(raw) {
  if (raw.length === 0) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, '요청 형식이 올바르지 않아요');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '요청 형식이 올바르지 않아요');
  return value;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

/** URL 경로 → 허용 목록에 맞는 로컬 파일 경로 | null */
function resolveStatic(urlPath, appRoot, dataDir) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (rel === '') rel = 'index.html';
  if (rel.includes('..') || rel.includes('\\')) return null;
  const upload = UPLOAD_FILE.exec(rel);
  if (upload) return { file: path.join(dataDir, rel), ext: upload[2] };
  if (!PUBLIC_FILE.test(rel)) return null;
  return { file: path.join(appRoot, rel), ext: rel.split('.').pop() };
}

function serveStatic(req, res, appRoot, dataDir) {
  const resolved = resolveStatic(new URL(req.url, 'http://x').pathname, appRoot, dataDir);
  if (!resolved || !fs.existsSync(resolved.file)) {
    sendJson(res, 404, { error: '찾을 수 없어요' });
    return;
  }
  // 코드(html/css/js)는 매번 재검증 — 배포·수정 직후 옛 스크립트가 캐시에 남아 동작이 섞이지 않게
  const cache = ['html', 'css', 'js'].includes(resolved.ext) ? 'no-cache' : 'public, max-age=300';
  send(res, 200, fs.readFileSync(resolved.file), { 'content-type': MIME[resolved.ext], 'cache-control': cache });
}

module.exports = { HttpError, readBody, parseJson, send, sendJson, serveStatic, resolveStatic, SECURITY_HEADERS, MAX_BODY_BYTES };
