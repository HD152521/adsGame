// "게시판 복사 전단" 질감 도구 — 게임 캔버스·사망 카드가 같은 재료를 쓰게 한곳에 모은다.
//   재료: 복사지(토너 망점), 코르크, 뜯긴 윗변, 테이프, 빨간 매직 동그라미, 매직 졸라맨, 복사기로 뽑은 로고.
//   순수 계산(뜯김 모양·복사기 픽셀 처리·기울기·종이 조각)은 위쪽 — paper.test.js가 검증한다.
//   아래 브라우저 전용 함수는 캔버스에 그리기만 한다.
//   실행 검증: apps/ad-dodge 안에서 node --test (paper.test.js)

const PAPER_DEPS = typeof module !== 'undefined' ? require('./rng.js') : { createRng };

const PAPER_RGB = [242, 241, 236];
const TONER_GRAY = 27;
const PAPER_COLORS = {
  paper: '#f2f1ec',
  paperShade: '#e3e2db',
  postit: '#fbefb2',
  toner: '#1b1b1a',
  tonerSoft: '#55544f',
  marker: '#c3161c',
  tape: 'rgba(238, 226, 160, 0.8)',
  cork: '#9a8466',
  corkDot: 'rgba(58, 38, 18, 0.32)',
  corkLight: 'rgba(255, 240, 210, 0.12)',
};
const PAPER_FONTS = {
  display: "'Black Han Sans', 'Apple SD Gothic Neo', sans-serif",
  hand: "'Nanum Pen Script', cursive",
  print: "'Gowun Dodum', 'Apple SD Gothic Neo', sans-serif",
  type: "'Nanum Gothic Coding', ui-monospace, monospace",
};
const MAX_TILT_RAD = (3 * Math.PI) / 180;

function hashString(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** 뜯긴 윗변 꼭짓점 — x는 0→width로 증가, y는 0~depth. 같은 seed면 같은 모양 */
function tornEdge(seed, width, depth) {
  const rng = PAPER_DEPS.createRng(seed);
  const pts = [{ x: 0, y: depth * (0.4 + rng() * 0.6) }];
  let x = 0;
  const step = width / 9;
  while (x + step * 0.6 < width) {
    x += step * (0.6 + rng() * 0.8);
    if (x >= width) break;
    pts.push({ x, y: rng() * depth });
  }
  pts.push({ x: width, y: depth * (0.4 + rng() * 0.6) });
  return pts;
}

/**
 * 복사기 처리: 흑백 → 대비 강화 → 계조 levels 단계로 단순화(토너~복사지) → 약한 토너 입자.
 * 원본은 바꾸지 않고 새 배열을 돌려준다. 흰색은 복사지 색으로 떨어진다.
 */
function photocopyPixels(px, { levels = 4, contrast = 1.6, seed = 1, grain = 0.06 } = {}) {
  const out = new Uint8ClampedArray(px.length);
  const rng = PAPER_DEPS.createRng(seed);
  const paperGray = PAPER_RGB[0];
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const c = (lum - 128) * contrast + 128 + (rng() * 2 - 1) * grain * 255;
    const t = Math.min(1, Math.max(0, c / 255));
    const q = Math.round(t * (levels - 1)) / (levels - 1);
    const v = Math.round(TONER_GRAY + (paperGray - TONER_GRAY) * q);
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = px[i + 3];
  }
  return out;
}

/** 종이마다 고정된 기울기(−3°~+3°) — 같은 각도 반복을 피하면서 매 프레임 흔들리지 않게 */
function tiltFor(id) {
  return ((hashString(id) % 2001) / 1000 - 1) * MAX_TILT_RAD;
}

/** 맞은 자리에 흩어지는 종이 조각 3~4개 */
function shreds(center, seed) {
  const rng = PAPER_DEPS.createRng(seed);
  const n = rng() < 0.5 ? 3 : 4;
  return Array.from({ length: n }, () => ({
    x: center.x + (rng() * 2 - 1) * 38,
    y: center.y + (rng() * 2 - 1) * 38,
    angle: rng() * Math.PI,
    w: 8 + rng() * 9,
    h: 7 + rng() * 8,
  }));
}

// ── 브라우저 전용 ─────────────────────────────────────────────

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** 토너 망점 타일(종이 위에 반복해서 깐다) */
function makeTonerTile(size = 48, seed = 11) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rng = PAPER_DEPS.createRng(seed);
  g.fillStyle = 'rgba(0,0,0,0.09)';
  for (let y = 0; y < size; y += 3) {
    for (let x = 0; x < size; x += 3) g.fillRect(x + (rng() < 0.5 ? 0 : 1), y, 1, 1);
  }
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (let i = 0; i < size / 2; i += 1) g.fillRect(Math.floor(rng() * size), Math.floor(rng() * size), 1, 1);
  return c;
}

/** 코르크 타일 */
function makeCorkTile(size = 64, seed = 5) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  const rng = PAPER_DEPS.createRng(seed);
  g.fillStyle = PAPER_COLORS.cork;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 3; i += 1) {
    g.fillStyle = rng() < 0.75 ? PAPER_COLORS.corkDot : PAPER_COLORS.corkLight;
    const r = 0.6 + rng() * 1.2;
    g.beginPath();
    g.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
    g.fill();
  }
  return c;
}

/** 윗변이 뜯긴 종이 경로를 (0,0)~(w,h) 사각형에 만든다 */
function tornPaperPath(ctx, w, h, seed, depth = Math.max(3, h * 0.1)) {
  const edge = tornEdge(seed, w, depth);
  ctx.beginPath();
  ctx.moveTo(edge[0].x, edge[0].y);
  for (const p of edge.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
}

/** 종이 한 장(색 + 토너 망점) — 뜯김 여부 선택 */
function fillPaper(ctx, w, h, { seed = 1, torn = false, color = PAPER_COLORS.paper, toner = null } = {}) {
  if (torn) tornPaperPath(ctx, w, h, seed);
  else {
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
  }
  ctx.fillStyle = color;
  ctx.fill();
  if (toner) {
    ctx.save();
    ctx.clip();
    ctx.fillStyle = ctx.createPattern(toner, 'repeat');
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}

function drawTape(ctx, x, y, w, angle = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = PAPER_COLORS.tape;
  ctx.fillRect(-w / 2, -w * 0.13, w, w * 0.26);
  ctx.restore();
}

/** 빨간 매직으로 대충 그린 동그라미(두 번 겹쳐 그림).
 *  긴 문구를 감쌀 때 기울기를 그대로 두면 양 끝이 처져 글자를 가로지르므로, 가로로 길수록 기울기를 줄인다. */
function drawMarkerRing(ctx, cx, cy, rx, ry, width = 2) {
  const tilt = -0.12 * Math.min(1, (ry * 1.6) / rx);
  ctx.save();
  ctx.strokeStyle = PAPER_COLORS.marker;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, tilt, 0.2, Math.PI * 2 + 0.05);
  ctx.stroke();
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.ellipse(cx + 1, cy - 1, rx * 1.04, ry * 0.97, tilt * 0.7, 0, Math.PI * 1.7);
  ctx.stroke();
  ctx.restore();
}

/** 광고고수 — 매직 졸라맨 + 빨간 머리띠. (cx,cy)=몸통 중심, s=키(px) */
function drawGosu(ctx, cx, cy, s) {
  const u = s / 34;
  const line = (pts, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * u;
    ctx.beginPath();
    ctx.moveTo(cx + pts[0][0] * u, cy + pts[0][1] * u);
    for (const p of pts.slice(1)) ctx.lineTo(cx + p[0] * u, cy + p[1] * u);
    ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 몸(기준점은 배꼽 근처)
  line([[0, -3], [0, 8]], PAPER_COLORS.toner, 2.3);
  line([[0, 0], [-8, 4]], PAPER_COLORS.toner, 2.3);
  line([[0, 0], [8, -4]], PAPER_COLORS.toner, 2.3);
  line([[0, 8], [-6, 16]], PAPER_COLORS.toner, 2.3);
  line([[0, 8], [6, 16]], PAPER_COLORS.toner, 2.3);
  // 머리
  ctx.fillStyle = PAPER_COLORS.paper;
  ctx.strokeStyle = PAPER_COLORS.toner;
  ctx.lineWidth = 2 * u;
  ctx.beginPath();
  ctx.arc(cx, cy - 9 * u, 6 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // 머리띠 + 휘날리는 끈
  line([[-7, -10.5], [7, -10.5]], PAPER_COLORS.marker, 2.2);
  line([[6, -10.5], [11, -13]], PAPER_COLORS.marker, 2.2);
  line([[6, -10], [10, -7]], PAPER_COLORS.marker, 2.2);
  // 눈
  line([[-2.5, -8], [-1, -8]], PAPER_COLORS.toner, 1.6);
  line([[1.5, -8], [3, -8]], PAPER_COLORS.toner, 1.6);
  ctx.restore();
}

/** 로고 이미지 → 복사기로 뽑은 흑백 캔버스(size×size, 가운데 맞춤). 실패하면 null */
function photocopyImage(img, size, seed = 1) {
  try {
    const c = makeCanvas(size, size);
    const g = c.getContext('2d');
    g.fillStyle = PAPER_COLORS.paper;
    g.fillRect(0, 0, size, size);
    const ratio = Math.min(size / img.naturalWidth, size / img.naturalHeight);
    const w = img.naturalWidth * ratio;
    const h = img.naturalHeight * ratio;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    const data = g.getImageData(0, 0, size, size);
    data.data.set(photocopyPixels(data.data, { levels: 4, contrast: 1.55, seed, grain: 0.05 }));
    g.putImageData(data, 0, 0);
    return c;
  } catch (err) {
    console.warn('[paper] 로고 복사기 처리 실패(교차 출처 등)', err);
    return null;
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    PAPER_RGB,
    PAPER_COLORS,
    PAPER_FONTS,
    hashString,
    tornEdge,
    photocopyPixels,
    tiltFor,
    shreds,
    makeCanvas,
    makeTonerTile,
    makeCorkTile,
    tornPaperPath,
    fillPaper,
    drawTape,
    drawMarkerRing,
    drawGosu,
    photocopyImage,
  };
}
