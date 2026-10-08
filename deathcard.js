// 사망 카드 — 게시판에 붙은 "목숨 찾습니다" 분실 공고. 이 게임의 핵심 바이럴 장치(PRD MVP 3).
//   플레이어에겐 밈, 광고주에겐 게임 밖 2차 노출이 된다.
//   문구 조립은 순수 함수(buildDeathCardText)로 분리해 테스트하고, 캔버스 그리기·공유는
//   브라우저에서만 동작한다(apps/chukui의 공유 카드와 같은 층 분리).
//   실행 검증: apps/ad-dodge 안에서 node --test (deathcard.test.js)

const CARD_WIDTH = 1080; // 인스타 스토리 9:16
const CARD_HEIGHT = 1920;
const TOP_N = 3;
const NAME_MAX = 12;
const UNKNOWN_NAME = '알 수 없는 광고';

/** 사용자에게 보이는 글자(grapheme) 단위로 나눈다 — ZWJ 이모지를 반쪽으로 자르지 않도록 */
function splitGraphemes(s) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);
  }
  return [...s];
}

function truncateName(name) {
  const chars = splitGraphemes(String(name));
  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX).join('')}…` : chars.join('');
}

function formatSeconds(s) {
  return `${s.toFixed(1)}초`;
}

/** 나보다 짧게 버틴 비율 → "상위 N%". 상위 0%는 이상하니 최소 1% */
function formatTopPercent(betterThan) {
  if (betterThan === null || betterThan === undefined) return null;
  return `상위 ${Math.max(1, Math.ceil((1 - betterThan) * 100))}%`;
}

/** 도전장 결과 — 도전 기록을 넘었는지 */
function challengeResult(challenge, survivedSeconds) {
  if (!challenge) return null;
  const won = survivedSeconds > challenge.seconds;
  return {
    won,
    text: won ? `${challenge.name} 격파! (${challenge.seconds}초 넘김)` : `${challenge.name}에게 졌다 (${challenge.seconds}초)`,
  };
}

function rankLineOf(percentile) {
  if (!percentile) return null;
  if (percentile.betterThan === null) return '오늘 첫 기록';
  return `오늘 ${percentile.total.toLocaleString('ko-KR')}판 중 ${formatTopPercent(percentile.betterThan)}`;
}

function buildDeathCardText({ killerId, sniperId = null, survivedSeconds, dodged, names, nearMisses = 0, percentile = null, challenge = null }) {
  const nameOf = (id) => truncateName(names[id] || UNKNOWN_NAME);
  const killerName = nameOf(killerId);
  const top = Object.entries(dodged)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ id, name: nameOf(id), count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'))
    .slice(0, TOP_N);
  const survived = `${formatSeconds(survivedSeconds)} 버팀`;
  const sniped = sniperId !== null && killerId === sniperId;
  const dodgedTotal = Object.values(dodged).reduce((sum, n) => sum + n, 0);
  const rankLine = rankLineOf(percentile);
  const vs = challengeResult(challenge, survivedSeconds);
  const extras = [rankLine && rankLine !== '오늘 첫 기록' ? rankLine : null, vs ? vs.text : null].filter(Boolean).join(' · ');
  return {
    headline: sniped ? `${killerName}님의 광고에 당했습니다` : `당신은 ${killerName}에게 죽었습니다`,
    sniped,
    dodgedTotal,
    nearMisses,
    rankLine,
    challenge: vs,
    killerName,
    survived,
    top,
    shareText: `목숨 찾습니다… ${killerName} 광고 맞고 ${formatSeconds(survivedSeconds)} 만에 사라짐.${extras ? ` ${extras}.` : ''} 이 게시판 광고 전부 돈 내고 붙인 거임`,
  };
}

// ── 브라우저 전용 ─────────────────────────────────────────────
//   사망 카드 = 게시판에 붙은 "목숨 찾습니다" 분실 공고(1080×1920, 인스타 스토리).
//   재료는 paper.js(코르크·복사지·테이프·매직 동그라미·복사기 로고)를 그대로 쓴다.

const CARD_DEPS = typeof module !== 'undefined' ? require('./paper.js') : { PAPER_COLORS, PAPER_FONTS, hashString, makeTonerTile, makeCorkTile, fillPaper, drawTape, drawMarkerRing, photocopyImage, tornEdge };

const SHEET = { x: 90, y: 170, w: 900, h: 1470, tilt: 0.02 };
const TAB_COUNT = 6;
const TAB_HEIGHT = 230;
const TAB_TEXT = '이건광고';

function setTracking(ctx, px) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${px}px`;
}

function drawCardBackground(ctx, cork) {
  ctx.fillStyle = ctx.createPattern(cork, 'repeat');
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
}

/** 아래쪽 뜯어가는 탭(세로 글씨) — 두 개는 이미 뜯겨 나감 */
function drawTearTabs(ctx, cork) {
  const top = SHEET.h - TAB_HEIGHT;
  const tabW = SHEET.w / TAB_COUNT;
  ctx.save();
  ctx.setLineDash([14, 10]);
  ctx.strokeStyle = CARD_DEPS.PAPER_COLORS.tonerSoft;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, top);
  ctx.lineTo(SHEET.w, top);
  for (let i = 1; i < TAB_COUNT; i += 1) {
    ctx.moveTo(tabW * i, top);
    ctx.lineTo(tabW * i, SHEET.h);
  }
  ctx.stroke();
  ctx.restore();
  const gone = new Set([1, 4]);
  for (let i = 0; i < TAB_COUNT; i += 1) {
    const cx = tabW * i + tabW / 2;
    if (gone.has(i)) {
      // 뜯겨 나간 자리: 코르크가 비치고 윗부분만 종이 쪼가리가 남음
      ctx.save();
      ctx.beginPath();
      ctx.rect(tabW * i + 2, top + 26, tabW - 4, TAB_HEIGHT - 26);
      ctx.clip();
      ctx.fillStyle = ctx.createPattern(cork, 'repeat');
      ctx.fillRect(tabW * i, top, tabW, TAB_HEIGHT);
      ctx.restore();
      continue;
    }
    // 한글 세로쓰기: 글자를 눕히지 않고 위에서 아래로 쌓는다
    ctx.fillStyle = CARD_DEPS.PAPER_COLORS.toner;
    ctx.font = `50px ${CARD_DEPS.PAPER_FONTS.hand}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const chars = [...TAB_TEXT];
    const lineH = Math.min(46, (TAB_HEIGHT - 30) / chars.length);
    const startY = top + TAB_HEIGHT / 2 - (lineH * (chars.length - 1)) / 2;
    chars.forEach((ch, k) => ctx.fillText(ch, cx, startY + k * lineH));
  }
}

function drawPhoto(ctx, text, killer) {
  const size = 400;
  const x = (SHEET.w - size) / 2;
  const y = 270;
  ctx.fillStyle = CARD_DEPS.PAPER_COLORS.paperShade;
  ctx.fillRect(x, y, size, size);
  const logo = killer && killer.img ? CARD_DEPS.photocopyImage(killer.img, 320, CARD_DEPS.hashString(killer.id || 'k')) : null;
  if (logo) ctx.drawImage(logo, x + 40, y + 40, 320, 320);
  else {
    ctx.fillStyle = CARD_DEPS.PAPER_COLORS.toner;
    ctx.font = `180px ${CARD_DEPS.PAPER_FONTS.hand}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText([...text.killerName].slice(0, 3).join(''), SHEET.w / 2, y + size / 2 + 10, size - 40);
  }
  ctx.strokeStyle = CARD_DEPS.PAPER_COLORS.toner;
  ctx.lineWidth = 8;
  ctx.strokeRect(x, y, size, size);
}

function drawNoticeText(ctx, text) {
  const D = CARD_DEPS;
  const cx = SHEET.w / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = D.PAPER_COLORS.toner;
  ctx.font = `150px ${D.PAPER_FONTS.display}`;
  setTracking(ctx, -5);
  ctx.fillText(text.sniped ? '저격당했습니다' : '목숨 찾습니다', cx, 210, SHEET.w - 80);
  setTracking(ctx, 0);

  ctx.font = `86px ${D.PAPER_FONTS.hand}`;
  const who = text.sniped ? `범인: ${text.killerName}님` : `마지막 목격: ${text.killerName} 앞`;
  ctx.fillText(who, cx, 800, SHEET.w - 80);
  const whoWidth = Math.min(ctx.measureText(who).width, SHEET.w - 80);
  D.drawMarkerRing(ctx, cx, 774, whoWidth / 2 + 56, 70, 6);

  const rows = [['버틴 시간', text.survived.replace(' 버팀', '')], ['피한 광고', `${text.dodgedTotal}장`], ['아슬아슬', `${text.nearMisses}번`]];
  rows.forEach(([label, value], k) => {
    const y = 925 + k * 92;
    ctx.textAlign = 'center';
    ctx.font = `70px ${D.PAPER_FONTS.hand}`;
    ctx.fillText(label, cx - 150, y);
    ctx.textAlign = 'left';
    ctx.font = `700 70px ${D.PAPER_FONTS.type}`;
    setTracking(ctx, 2);
    ctx.fillText(value, cx + 10, y);
    setTracking(ctx, 0);
  });

  ctx.textAlign = 'center';
  if (text.rankLine) {
    ctx.fillStyle = D.PAPER_COLORS.marker;
    ctx.font = `72px ${D.PAPER_FONTS.hand}`;
    ctx.fillText(text.rankLine, cx, 1205, SHEET.w - 80);
  } else {
    ctx.font = `56px ${D.PAPER_FONTS.hand}`;
    ctx.fillStyle = D.PAPER_COLORS.tonerSoft;
    ctx.fillText('보신 분은 스토리에 붙여 주세요 · 사례 없음', cx, 1200, SHEET.w - 80);
  }
}

/** text: buildDeathCardText 결과, killer: { id, img(로드된 Image)|null } */
function drawDeathCard(canvas, text, killer = null) {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  const toner = CARD_DEPS.makeTonerTile(96, 7);
  const cork = CARD_DEPS.makeCorkTile(96, 3); // 배경·뜯긴 탭 자리에 같은 코르크를 한 번만 만들어 쓴다
  drawCardBackground(ctx, cork);

  ctx.save();
  ctx.translate(SHEET.x + SHEET.w / 2, SHEET.y + SHEET.h / 2);
  ctx.rotate(SHEET.tilt);
  ctx.translate(-SHEET.w / 2, -SHEET.h / 2);
  ctx.shadowColor = 'rgba(30, 18, 6, 0.45)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 14;
  CARD_DEPS.fillPaper(ctx, SHEET.w, SHEET.h, { color: CARD_DEPS.PAPER_COLORS.paper });
  ctx.shadowColor = 'transparent';
  CARD_DEPS.fillPaper(ctx, SHEET.w, SHEET.h, { color: CARD_DEPS.PAPER_COLORS.paper, toner });
  drawNoticeText(ctx, text);
  drawPhoto(ctx, text, killer);
  drawTearTabs(ctx, cork);
  ctx.restore();

  CARD_DEPS.drawTape(ctx, CARD_WIDTH / 2, SHEET.y - 4, 260, -0.03);
  CARD_DEPS.drawTape(ctx, SHEET.x + 30, SHEET.y + 40, 180, -0.7);
  CARD_DEPS.drawTape(ctx, SHEET.x + SHEET.w - 30, SHEET.y + 50, 180, 0.65);

  // 아래 포스트잇 — 광고 문구
  ctx.save();
  ctx.translate(CARD_WIDTH - 330, CARD_HEIGHT - 190);
  ctx.rotate(-0.05);
  ctx.fillStyle = CARD_DEPS.PAPER_COLORS.postit;
  ctx.shadowColor = 'rgba(30, 18, 6, 0.4)';
  ctx.shadowBlur = 16;
  ctx.shadowOffsetY = 8;
  ctx.fillRect(-250, -80, 500, 160);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = CARD_DEPS.PAPER_COLORS.toner;
  ctx.font = `62px ${CARD_DEPS.PAPER_FONTS.hand}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = text.challenge && text.challenge.won ? CARD_DEPS.PAPER_COLORS.marker : CARD_DEPS.PAPER_COLORS.toner;
  ctx.fillText(text.challenge ? text.challenge.text : '당신 광고도 여기 붙일 수 있음', 0, 0, 460);
  ctx.restore();
  return canvas;
}

/** 공유 시트 → 실패/미지원이면 PNG 다운로드. 반환: 'shared' | 'downloaded' | 'cancelled' */
async function shareDeathCard(canvas, text) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('카드 이미지를 만들지 못했어요');
  const file = new File([blob], 'death-card.png', { type: 'image/png' });
  if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: text.shareText });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      console.warn('[deathcard] share 실패 → 다운로드로 폴백', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'death-card.png';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
}

if (typeof module !== 'undefined') {
  module.exports = {
    CARD_WIDTH,
    CARD_HEIGHT,
    TOP_N,
    truncateName,
    formatSeconds,
    buildDeathCardText,
    formatTopPercent,
    challengeResult,
    drawDeathCard,
    shareDeathCard,
  };
}
