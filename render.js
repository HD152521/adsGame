// 캔버스 렌더 — "게시판 복사 전단" 세계. game.js 상태를 그리기만 한다(판정 로직 금지).
//   바탕은 코르크, 광고는 윗변이 뜯긴 쪽지(복사기로 뽑은 흑백 로고 + 손글씨 이름), 플레이어는 매직 졸라맨.
//   쪽지는 정사각형이라 원형 충돌 판정 안에 들어간다(억울한 죽음 방지). 회전은 그리기 전용 — 판정과 무관.
//   쪽지 이미지는 광고주마다 한 번만 만들어 캐시한다(매 프레임 픽셀 처리 금지 — 저사양 폰).
//   실행 검증: apps/ad-dodge 안에서 node --test (view.test.js)

const RENDER_DEPS = typeof module !== 'undefined'
  ? { ...require('./game.js'), ...require('./paper.js') }
  : { WORLD_WIDTH, WORLD_HEIGHT, PLAYER_RADIUS, PAPER_COLORS, PAPER_FONTS, hashString, tiltFor, shreds, makeCanvas, makeTonerTile, makeCorkTile, fillPaper, drawTape, drawMarkerRing, drawGosu, photocopyImage };

const SPRITE_SIZE = 112;          // 쪽지 원본 해상도(px) — 화면에서는 축소해 그린다
const SLIP_SIDE_PER_RADIUS = 1.55; // 쪽지 한 변 = 발사체 반지름 × 이 값
const LETTERBOX_SHADE = 'rgba(30, 20, 10, 0.18)';

/** 논리 화면을 cssW×cssH 안에 비율 유지로 최대한 크게, 가운데 정렬 */
function fitView(cssW, cssH) {
  const scale = Math.min(cssW / RENDER_DEPS.WORLD_WIDTH, cssH / RENDER_DEPS.WORLD_HEIGHT);
  return {
    scale,
    offsetX: (cssW - RENDER_DEPS.WORLD_WIDTH * scale) / 2,
    offsetY: (cssH - RENDER_DEPS.WORLD_HEIGHT * scale) / 2,
    width: cssW,
    height: cssH,
  };
}

/** shares → Map(id → {img, name, label, kind, isHouse, sprite}). 쪽지 이미지는 처음 그릴 때 만든다. */
function createLogoCache(shares, ImageCtor) {
  const cache = new Map();
  for (const s of shares) {
    const entry = { id: s.id, img: null, name: s.name, label: [...s.name].slice(0, 2).join(''), kind: s.kind, isHouse: Boolean(s.isHouse), sprite: null };
    const src = s.logoUrl || s.logo;
    if (src && ImageCtor) {
      const img = new ImageCtor();
      img.onload = () => {
        entry.sprite = null; // 로고가 늦게 오면 쪽지를 다시 만든다
      };
      img.onerror = () => {
        console.warn('[render] 로고 로드 실패', s.id, src);
        entry.img = null;
        entry.sprite = null;
      };
      img.src = src;
      entry.img = img;
    }
    cache.set(s.id, entry);
  }
  return cache;
}

function isImageReady(img) {
  return Boolean(img && img.complete && img.naturalWidth > 0);
}

let tonerTile = null;
let corkTile = null;
function textures() {
  if (typeof document === 'undefined') return { toner: null, cork: null };
  if (!tonerTile) tonerTile = RENDER_DEPS.makeTonerTile();
  if (!corkTile) corkTile = RENDER_DEPS.makeCorkTile();
  return { toner: tonerTile, cork: corkTile };
}

/** 광고주 쪽지 이미지(SPRITE_SIZE 정사각) — 종류별 종이 + 복사된 로고 + 손글씨 이름 */
function buildSprite(entry) {
  const D = RENDER_DEPS;
  const S = SPRITE_SIZE;
  const c = D.makeCanvas(S, S);
  const g = c.getContext('2d');
  const seed = D.hashString(entry.id);
  const snipe = entry.kind === 'snipe';
  const paperColor = snipe ? D.PAPER_COLORS.postit : D.PAPER_COLORS.paper;
  D.fillPaper(g, S, S, { seed, torn: !entry.isHouse, color: paperColor, toner: textures().toner });
  if (entry.isHouse) {
    g.strokeStyle = D.PAPER_COLORS.toner;
    g.lineWidth = 3;
    g.strokeRect(8, 8, S - 16, S - 16);
  }
  const logo = isImageReady(entry.img) ? D.photocopyImage(entry.img, 64, seed) : null;
  g.fillStyle = D.PAPER_COLORS.toner;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (logo) {
    g.drawImage(logo, (S - 58) / 2, 14, 58, 58);
    g.font = `38px ${D.PAPER_FONTS.hand}`;
    g.fillText(entry.name, S / 2, 92, S - 12);
  } else {
    g.font = `58px ${D.PAPER_FONTS.hand}`;
    g.fillText(entry.name, S / 2, S / 2 + 8, S - 12);
  }
  return c;
}

function spriteFor(entry) {
  if (!entry.sprite && typeof document !== 'undefined') entry.sprite = buildSprite(entry);
  return entry.sprite;
}

// 무늬(CanvasPattern)는 컨텍스트마다 한 번만 만든다 — 매 프레임 새로 만들면 저사양 폰에서 쓰레기가 쌓인다
const corkPatterns = new WeakMap();
function corkPatternFor(ctx) {
  const { cork } = textures();
  if (!cork) return '#9a8466';
  if (!corkPatterns.has(ctx)) corkPatterns.set(ctx, ctx.createPattern(cork, 'repeat'));
  return corkPatterns.get(ctx);
}

function drawField(ctx, view) {
  ctx.fillStyle = corkPatternFor(ctx);
  ctx.fillRect(0, 0, view.width, view.height);
  // 게임 영역 밖(가로 레터박스)은 살짝 어둡게 — 판 경계가 보이게
  const w = RENDER_DEPS.WORLD_WIDTH * view.scale;
  const h = RENDER_DEPS.WORLD_HEIGHT * view.scale;
  ctx.fillStyle = LETTERBOX_SHADE;
  if (view.offsetX > 0) {
    ctx.fillRect(0, 0, view.offsetX, view.height);
    ctx.fillRect(view.offsetX + w, 0, view.offsetX, view.height);
  }
  if (view.offsetY > 0) {
    ctx.fillRect(0, 0, view.width, view.offsetY);
    ctx.fillRect(0, view.offsetY + h, view.width, view.offsetY);
  }
}

/** 쪽지 회전: 광고주별 고정 기울기 + 날아가며 팔랑(방향·속도는 id마다 다름) */
function slipAngle(p, t) {
  const spin = (0.7 + (p.id % 3) * 0.35) * (p.id % 2 === 0 ? 1 : -1);
  return RENDER_DEPS.tiltFor(p.advId) + p.id * 0.9 + t * spin;
}

function drawProjectile(ctx, p, view, entry, t) {
  const x = view.offsetX + p.x * view.scale;
  const y = view.offsetY + p.y * view.scale;
  const side = p.r * SLIP_SIDE_PER_RADIUS * view.scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(slipAngle(p, t));
  ctx.shadowColor = 'rgba(30, 18, 6, 0.35)';
  ctx.shadowOffsetY = Math.max(1, side * 0.06);
  ctx.shadowBlur = side * 0.08;
  const sprite = entry ? spriteFor(entry) : null;
  if (sprite) ctx.drawImage(sprite, -side / 2, -side / 2, side, side);
  else {
    ctx.fillStyle = RENDER_DEPS.PAPER_COLORS.paper;
    ctx.fillRect(-side / 2, -side / 2, side, side);
  }
  ctx.shadowColor = 'transparent';
  if (p.boss) RENDER_DEPS.drawMarkerRing(ctx, 0, 0, side * 0.62, side * 0.6, Math.max(2, side * 0.06));
  ctx.restore();
}

function drawPlayer(ctx, state, view) {
  const x = view.offsetX + state.player.x * view.scale;
  const y = view.offsetY + state.player.y * view.scale;
  const size = RENDER_DEPS.PLAYER_RADIUS * 2.9 * view.scale;
  ctx.save();
  if (state.dead) ctx.globalAlpha = 0.35;
  RENDER_DEPS.drawGosu(ctx, x, y, size);
  ctx.restore();
}

/** 맞은 순간: 그 자리에 종이 조각이 흩어진다 */
function drawShreds(ctx, state, view) {
  const pieces = RENDER_DEPS.shreds(state.player, RENDER_DEPS.hashString(state.killerId || 'x'));
  ctx.save();
  ctx.fillStyle = RENDER_DEPS.PAPER_COLORS.paper;
  ctx.shadowColor = 'rgba(30, 18, 6, 0.35)';
  ctx.shadowOffsetY = 2;
  for (const s of pieces) {
    ctx.save();
    ctx.translate(view.offsetX + s.x * view.scale, view.offsetY + s.y * view.scale);
    ctx.rotate(s.angle);
    const w = s.w * view.scale;
    const h = s.h * view.scale;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(w / 2, -h / 3);
    ctx.lineTo(w / 3, h / 2);
    ctx.lineTo(-w / 2, h / 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

const FX_LIFE = 0.7;

/** 아슬아슬: 플레이어 옆에 빨간 매직 "휙!"이 떠올랐다 사라진다 */
function drawWhoosh(ctx, f, state, view) {
  const age = (state.t - f.t) / FX_LIFE;
  if (age < 0 || age > 1) return;
  const x = view.offsetX + f.x * view.scale + 22 * view.scale;
  const y = view.offsetY + f.y * view.scale - (18 + age * 20) * view.scale;
  ctx.save();
  ctx.globalAlpha = 1 - age;
  ctx.translate(x, y);
  ctx.rotate(-0.15);
  ctx.fillStyle = RENDER_DEPS.PAPER_COLORS.marker;
  ctx.font = `${Math.round(26 * view.scale)}px ${RENDER_DEPS.PAPER_FONTS.hand}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('휙!', 0, 0);
  ctx.restore();
}

/** 전단 살포 직전: 화면 위쪽에 테이프로 붙인 경고 쪽지 */
function drawWaveWarning(ctx, state, view) {
  const D = RENDER_DEPS;
  const w = 210 * view.scale;
  const h = 40 * view.scale;
  const x = view.offsetX + (D.WORLD_WIDTH * view.scale - w) / 2;
  const y = view.offsetY + 64 * view.scale;
  const blink = Math.floor(state.t * 6) % 2 === 0;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(-0.03);
  ctx.fillStyle = D.PAPER_COLORS.paper;
  ctx.shadowColor = 'rgba(30, 18, 6, 0.4)';
  ctx.shadowOffsetY = 3;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = blink ? D.PAPER_COLORS.marker : D.PAPER_COLORS.toner;
  ctx.font = `${Math.round(22 * view.scale)}px ${D.PAPER_FONTS.display}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('전단 살포 주의!', 0, 1, w - 12);
  ctx.restore();
  D.drawTape(ctx, x + w / 2, y, 60 * view.scale, 0.04);
}

function drawFrame(ctx, state, view, logos) {
  drawField(ctx, view);
  for (const p of state.projectiles) drawProjectile(ctx, p, view, logos.get(p.advId), state.t);
  drawPlayer(ctx, state, view);
  for (const f of state.fx || []) if (f.kind === 'whoosh') drawWhoosh(ctx, f, state, view);
  if (state.waveWarning) drawWaveWarning(ctx, state, view);
  if (state.dead) drawShreds(ctx, state, view);
}

if (typeof module !== 'undefined') {
  module.exports = { fitView, createLogoCache, drawFrame, isImageReady, spriteFor, SLIP_SIDE_PER_RADIUS };
}
