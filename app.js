// 앱 배선 — 화면 전환, 게임 루프, 서버 장부·실시간 이벤트, DOM 갱신. 판정은 game.js, 추첨은 shares.js,
//   그리기는 render.js, 구매는 buy.js, 서버 통신은 api.js.
//   서버가 없으면(정적 파일만) 하우스 시드 장부로 게임만 돈다 — 구매 버튼은 비활성.
//   Node에서 require하면 부팅하지 않는다 → 순수 함수(screenTransition, ledgerFromSeed)만 테스트.
//   실행 검증: apps/ad-dodge 안에서 node --test (view.test.js, index-html.test.js)

const APP_DEPS = typeof module !== 'undefined' ? require('./shares.js') : { computeShares, SLOT_PRICE, MAX_SLOTS, SNIPE_RATE };

const APP_TRANSITIONS = {
  start: { play: 'playing', buy: 'buying' },
  playing: { die: 'dead' },
  dead: { retry: 'playing', buy: 'buying', home: 'start' },
  buying: { close: 'start' },
};
const MAX_FRAME_SECONDS = 0.25; // 탭 복귀 등 긴 공백은 잘라서 순간이동 사망을 막는다
const BANNER_MS = 4000;
const RESYNC_MS = 30_000; // SSE 유실 대비 주기적 전체 재동기화
const BOARD_ROWS = 6;
const TAB_NAMES = 3; // 시작 전단 아래 뜯는 탭에 적는 광고 이름 수(마지막 탭은 "내 광고 붙이기")
const DEATH_PAUSE_MS = 450; // 맞은 순간 종이 조각이 흩어지는 걸 보여주고 나서 분실 공고로
const FONT_WAIT_MS = 1500;  // 캔버스 손글씨가 대체 글꼴로 굳지 않게 기다리는 상한
const CHALLENGE_NAME_KEY = 'ad-dodge:challenge-name';
const CANVAS_FONTS = ["34px 'Nanum Pen Script'", "150px 'Black Han Sans'", "700 76px 'Nanum Gothic Coding'"];
const REPORT_MESSAGES = {
  rights: '접수! 권리 침해는 바로 떼어 냈어요',
  default: '접수! 여러 명이 신고하면 자동으로 떼어 내요',
};

function screenTransition(screen, event) {
  const next = APP_TRANSITIONS[screen] && APP_TRANSITIONS[screen][event];
  return next || screen;
}

/** 서버 없이 열었을 때의 장부(서버 GET /api/ledger 와 같은 모양) */
function ledgerFromSeed(seed) {
  return {
    slotPrice: APP_DEPS.SLOT_PRICE,
    maxSlots: APP_DEPS.MAX_SLOTS,
    soldSlots: seed.filter((e) => !e.isHouse).reduce((sum, e) => sum + e.slots, 0),
    bossId: null,
    rules: { snipeRate: APP_DEPS.SNIPE_RATE },
    advertisers: APP_DEPS.computeShares(seed.map((e) => ({ ...e, logoUrl: e.logo }))),
  };
}

/** 죽인 광고의 이동 주소(http/https만). 서버가 검증하지만 플레이어를 보내는 곳이라 한 번 더 확인한다. */
function redirectTarget(killerId, ledger) {
  const ad = ledger.advertisers.find((a) => a.id === killerId);
  if (!ad || !ad.landingUrl) return null;
  try {
    const u = new URL(ad.landingUrl);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function friendlyError(err) {
  console.error('[ad-dodge]', err);
  return '앗, 카드를 만들다 문제가 생겼어요. 화면을 캡처해서 공유해 주세요!';
}

function newSeed() {
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;
}

function makeTag(doc, text, cls) {
  const tag = doc.createElement('em');
  tag.textContent = text;
  if (cls) tag.className = cls;
  return tag;
}

function renderBoard(doc, ledger) {
  doc.getElementById('board-sold').textContent = ledger.soldSlots.toLocaleString('ko-KR');
  doc.getElementById('board-list').replaceChildren(
    ...ledger.advertisers.slice(0, BOARD_ROWS).map((s) => {
      const li = doc.createElement('li');
      const name = doc.createElement('span');
      name.textContent = s.name;
      if (s.id === ledger.bossId) name.append(' ', makeTag(doc, '보스', 'tag--boss'));
      if (s.isHouse) name.append(' ', makeTag(doc, '관리사무소'));
      if (s.kind === 'snipe') name.append(' ', makeTag(doc, '저격'));
      const pct = doc.createElement('b');
      pct.textContent = formatSharePercent(s.share);
      li.append(name, pct);
      return li;
    }),
  );
  doc.getElementById('rule-snipe').textContent = `${Math.round(ledger.rules.snipeRate * 100)}%`;
  renderTabs(doc, ledger);
}

/** 시작 전단 아래 뜯는 탭 — 지분 상위 광고 이름(세로 손글씨). 마지막 탭(내 광고 붙이기)은 HTML 고정 */
function renderTabs(doc, ledger) {
  // 광고 이름은 전부 보이게 두고, 첫 이름 뒤에 "이미 누가 뜯어 간" 빈 탭 하나를 끼워 게시판 느낌을 낸다
  const tabs = ledger.advertisers.slice(0, TAB_NAMES).map((s) => {
    const span = doc.createElement('span');
    span.className = 'tab';
    span.textContent = s.name;
    return span;
  });
  const gone = doc.createElement('span');
  gone.className = 'tab tab--gone';
  gone.setAttribute('aria-hidden', 'true');
  tabs.splice(Math.min(1, tabs.length), 0, gone);
  doc.getElementById('board-tabs').replaceChildren(...tabs);
}

function renderKillRanking(doc, ranking) {
  const section = doc.getElementById('kills');
  section.hidden = ranking.length === 0;
  doc.getElementById('kills-list').replaceChildren(
    ...ranking.slice(0, 5).map((r) => {
      const li = doc.createElement('li');
      const name = doc.createElement('span');
      name.textContent = r.name;
      const count = doc.createElement('b');
      count.textContent = `${r.kills.toLocaleString('ko-KR')}킬`;
      li.append(name, count);
      return li;
    }),
  );
}

function setupCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  let view = fitView(1, 1);
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view = fitView(rect.width, rect.height);
  };
  window.addEventListener('resize', resize);
  resize();
  return { ctx, getView: () => view };
}

/** 사망 카드(분실 공고). 로고는 복사기 처리를 거쳐 들어가고, 로고가 없거나(장부에서 빠짐 등)
 *  처리에 실패하면(교차 출처) 사진 칸에 이름을 손글씨로 쓴다 — paper.photocopyImage가 null을 돌려줌. */
function buildCard(doc, text, logo) {
  const canvas = doc.createElement('canvas');
  const killer = logo ? { id: logo.id, img: isImageReady(logo.img) ? logo.img : null } : null;
  drawDeathCard(canvas, text, killer);
  return { canvas, previewUrl: canvas.toDataURL('image/png') };
}

/** 장부 → 게임이 쓰는 파생값(이름표·로고·추첨기·보스). 장부가 바뀔 때마다 통째로 다시 만든다. */
function deriveLedger(ledger, snipeId) {
  const names = Object.fromEntries(ledger.advertisers.map((s) => [s.id, s.name]));
  return {
    ledger,
    names,
    logos: createLogoCache(ledger.advertisers, Image),
    pickAdId: createPicker(ledger.advertisers, snipeId),
    bossId: ledger.bossId,
    sniperName: snipeId && names[snipeId] ? names[snipeId] : null,
  };
}

function createBanner(el) {
  let timer = null;
  const textEl = el.querySelector('[data-banner-text]');
  return (text) => {
    textEl.textContent = text;
    el.hidden = false;
    el.classList.remove('is-live');
    void el.offsetWidth; // 애니메이션 재시작
    el.classList.add('is-live');
    clearTimeout(timer);
    timer = setTimeout(() => {
      el.hidden = true;
    }, BANNER_MS);
  };
}

async function loadServerState() {
  try {
    const [config, ledger] = await Promise.all([api.config(), api.ledger()]);
    return { online: true, config, ledger };
  } catch (err) {
    console.warn('[ad-dodge] 서버 없음 — 하우스 장부로만 플레이', err.message);
    return { online: false, config: { devDeposit: false }, ledger: ledgerFromSeed(SEED_LEDGER) };
  }
}

/** 화면 전환 — 오버레이 표시·입력 활성화를 한곳에서 */
function createScreens(doc, input) {
  const $ = (id) => doc.getElementById(id);
  let screen = 'start';
  const show = (next) => {
    screen = next;
    for (const [id, s] of [['screen-start', 'start'], ['screen-dead', 'dead'], ['screen-buy', 'buying']]) $(id).hidden = screen !== s;
    doc.body.dataset.screen = screen;
    input.setEnabled(screen === 'playing');
  };
  return { get: () => screen, show, go: (event) => show(screenTransition(screen, event)) };
}

/** 장부 상태 — 가장 최근 요청의 응답만 반영(응답 역전 방지), 반영될 때마다 onApply(world) */
function createWorldStore({ doc, server, snipeId, onApply }) {
  const $ = (id) => doc.getElementById(id);
  const gate = createLatestGate();
  let world = deriveLedger(server.ledger, snipeId);
  const apply = (ledger) => {
    world = deriveLedger(ledger, snipeId);
    renderBoard(doc, ledger);
    const top = ledger.advertisers[0];
    $('hud-top').textContent = top ? `${top.name} ${formatSharePercent(top.share)}` : '-';
    $('snipe-banner').hidden = !world.sniperName;
    $('snipe-name').textContent = world.sniperName || '';
    onApply(world);
  };
  const refresh = () => {
    if (!server.online) return Promise.resolve();
    const token = gate.next();
    return api
      .ledger()
      .then((ledger) => {
        if (gate.isLatest(token)) apply(ledger);
      })
      .catch((err) => console.warn('[ad-dodge] 장부 갱신 실패', err));
  };
  return { get: () => world, apply, refresh };
}

/** 게임 세션 — 고정 타임스텝 루프. 판정은 game.js, 이번 프레임에 일어난 사건은 onEvents로(소리) */
function createSession({ doc, surface, input, screens, getWorld, onDeath, onEvents }) {
  let game = createGame();
  let rng = createRng(newSeed());
  let lastTime = null;
  let acc = 0;
  let deathTimer = null;
  const frame = (now) => {
    requestAnimationFrame(frame);
    if (screens.get() === 'playing' && !doc.hidden) {
      const dt = lastTime === null ? 0 : Math.min((now - lastTime) / 1000, MAX_FRAME_SECONDS);
      acc += dt;
      const world = getWorld();
      const before = game;
      while (acc >= FIXED_DT && !game.dead) {
        game = step(game, input.target(), FIXED_DT, rng, world.pickAdId, { bossId: world.bossId });
        acc -= FIXED_DT;
      }
      if (game !== before) onEvents(gameEvents(before, game));
      doc.getElementById('hud-time').textContent = game.t.toFixed(1);
      if (game.dead && !deathTimer) {
        const fallen = game;
        deathTimer = setTimeout(() => onDeath(fallen), DEATH_PAUSE_MS);
      }
    }
    lastTime = now;
    drawFrame(surface.ctx, game, surface.getView(), getWorld().logos);
  };
  doc.addEventListener('visibilitychange', () => {
    lastTime = null;
  });
  return {
    reset() {
      clearTimeout(deathTimer);
      deathTimer = null;
      game = createGame();
      rng = createRng(newSeed());
      acc = 0;
      lastTime = null;
      input.reset();
    },
    player: () => game.player,
    removeAdvertiser(advId) {
      game = removeAdvertiser(game, advId);
    },
    keepOnly(idSet) {
      game = keepAdvertisers(game, idSet);
    },
    run: () => requestAnimationFrame(frame),
  };
}

function safeStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 도전장 만들기(사망 화면) — 이름은 기기에 기억, 링크는 공유 시트 또는 복사 */
function createChallengeBox({ doc, server }) {
  const $ = (id) => doc.getElementById(id);
  const storage = safeStorage();
  let seconds = 0;
  try {
    $('challenge-name').value = (storage && storage.getItem(CHALLENGE_NAME_KEY)) || '';
  } catch {
    /* 저장소 막힘 — 빈 칸으로 */
  }
  $('btn-challenge-make').addEventListener('click', async () => {
    const button = $('btn-challenge-make');
    const name = $('challenge-name').value.trim();
    if (!name) {
      $('challenge-status').textContent = '도전장에 적을 이름을 써 주세요';
      return;
    }
    button.disabled = true;
    try {
      const c = await api.createChallenge(name, seconds);
      try {
        if (storage) storage.setItem(CHALLENGE_NAME_KEY, name);
      } catch {
        /* 무시 */
      }
      $('challenge-url').value = buildChallengeUrl(location.origin, c.id);
      $('challenge-make').hidden = true;
      $('challenge-made').hidden = false;
      $('challenge-status').textContent = `${c.name} ${c.seconds}초 — 넘어 보라고 보내세요`;
    } catch (err) {
      $('challenge-status').textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });
  $('btn-challenge-share').addEventListener('click', async () => {
    const url = $('challenge-url').value;
    const text = `${$('challenge-name').value.trim()} ${seconds.toFixed(1)}초 버팀. 넘어봐`;
    try {
      if (navigator.share) await navigator.share({ url, text });
      else {
        await navigator.clipboard.writeText(url);
        $('challenge-status').textContent = '링크를 복사했어요!';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      $('challenge-url').select();
      $('challenge-status').textContent = '링크를 길게 눌러 복사해 주세요';
    }
  });
  return {
    reset(survivedSeconds) {
      seconds = survivedSeconds;
      $('challenge-box').hidden = !server.online;
      $('challenge-make').hidden = false;
      $('challenge-made').hidden = true;
      $('challenge-status').textContent = '';
    },
  };
}

/** 사망 화면 — 기록 전송(백분위)·광고주 사이트 이동·카드·공유·신고·도전장 */
function createDeathScreen({ doc, server, snipeId, getWorld, getChallenge }) {
  const $ = (id) => doc.getElementById(id);
  const challengeBox = createChallengeBox({ doc, server });
  let card = null;
  let killerId = null;
  let round = 0;

  const paint = (textInput, logo) => {
    const text = buildDeathCardText(textInput);
    try {
      card = { ...buildCard(doc, text, logo), text };
      $('card-preview').src = card.previewUrl;
      $('card-preview').alt = `${text.headline}. ${text.survived}${text.rankLine ? `. ${text.rankLine}` : ''}`;
    } catch (err) {
      card = null;
      $('share-status').textContent = friendlyError(err);
    }
  };

  $('btn-share').addEventListener('click', async () => {
    const button = $('btn-share');
    // 공유 시트가 열려 있는 동안 다시 누르면 InvalidStateError("An earlier share has not yet completed")
    if (!card || button.disabled) return;
    button.disabled = true;
    try {
      const result = await shareDeathCard(card.canvas, card.text);
      if (result === 'downloaded') $('share-status').textContent = '이미지를 저장했어요. 스토리에 올려 주세요!';
    } catch (err) {
      $('share-status').textContent = friendlyError(err);
    } finally {
      button.disabled = false;
    }
  });

  $('report').addEventListener('click', async (e) => {
    const reason = e.target.dataset && e.target.dataset.reason;
    if (!reason || !killerId) return;
    try {
      await api.report(killerId, reason);
      $('report-status').textContent = REPORT_MESSAGES[reason] || REPORT_MESSAGES.default;
    } catch (err) {
      $('report-status').textContent = err.message;
    }
  });

  return {
    show(game) {
      const world = getWorld();
      round += 1;
      const myRound = round;
      killerId = game.killerId;
      const run = { seconds: game.t, killerId, seen: game.seen };
      // 광고에 맞으면 그 광고주 사이트로 즉시 이동(사용자 결정 — 공개 규칙으로 시작 화면·약관에 명시)
      const target = redirectTarget(killerId, world.ledger);
      if (target) {
        if (server.online) api.runBeacon({ ...run, redirected: true });
        location.assign(target);
        return;
      }
      $('share-status').textContent = '';
      $('report-status').textContent = '';
      $('report').hidden = !server.online;
      challengeBox.reset(game.t);
      const textInput = {
        killerId, sniperId: snipeId, survivedSeconds: game.t, dodged: game.dodged, names: world.names,
        nearMisses: game.nearMisses, challenge: getChallenge(),
      };
      const logo = world.logos.get(killerId);
      paint(textInput, logo);
      if (!server.online) return;
      api
        .run(run)
        .then((percentile) => {
          if (myRound === round) paint({ ...textInput, percentile }, logo); // 다음 판이 시작됐으면 버림
        })
        .catch((err) => console.warn('[ad-dodge] 기록 전송 실패', err.message));
    },
  };
}

/** 실시간 광고 전쟁 — purchase 배너, takedown 즉시 제거, 재연결·주기 재동기화(SSE는 유실분을 다시 안 보낸다) */
function wireRealtime({ server, worldStore, session, banner, sound }) {
  if (!server.online) return;
  api.subscribe({
    purchase: (data) => {
      worldStore.refresh().then(() => {
        banner(purchaseBannerText(data));
        sound.play('staple');
      });
    },
    takedown: ({ advertiserId }) => {
      session.removeAdvertiser(advertiserId);
      worldStore.refresh();
    },
    reconnect: () => worldStore.refresh(),
  });
  setInterval(() => worldStore.refresh(), RESYNC_MS);
}

function wireSoundToggle(doc, sound) {
  const button = doc.getElementById('btn-sound');
  const paintButton = () => {
    const on = !sound.isMuted();
    button.textContent = on ? '소리 켬' : '소리 끔';
    button.setAttribute('aria-pressed', String(on));
  };
  button.addEventListener('click', () => {
    sound.unlock();
    sound.setMuted(!sound.isMuted());
    paintButton();
  });
  paintButton();
}

function wireButtons({ doc, screens, session, buyFlow, refreshKills, sound }) {
  const $ = (id) => doc.getElementById(id);
  const startRound = (event) => {
    sound.unlock();
    session.reset();
    screens.go(event);
  };
  $('btn-play').addEventListener('click', () => startRound('play'));
  $('btn-retry').addEventListener('click', () => startRound('retry'));
  $('btn-home').addEventListener('click', () => {
    screens.go('home');
    refreshKills();
  });
  for (const id of ['btn-buy', 'btn-buy-dead']) {
    $(id).disabled = !buyFlow;
    $(id).addEventListener('click', () => {
      if (!buyFlow) return;
      screens.go('buy');
      buyFlow.open();
    });
  }
  if (!buyFlow) $('btn-buy').textContent = '게시판 공사 중';
  wireSoundToggle(doc, sound);
}

/** 도전장 링크로 들어왔으면 시작 화면에 포스트잇 + HUD에 목표 기록 */
function loadChallenge(doc, server, id) {
  if (!id || !server.online) return Promise.resolve(null);
  return api
    .challenge(id)
    .then((c) => {
      doc.getElementById('challenge-from').textContent = c.name;
      doc.getElementById('challenge-seconds').textContent = c.seconds.toFixed(1);
      doc.getElementById('challenge-banner').hidden = false;
      doc.getElementById('hud-target').textContent = `목표 ${c.seconds.toFixed(1)}초`;
      doc.getElementById('hud-target').hidden = false;
      return c;
    })
    .catch((err) => {
      console.warn('[ad-dodge] 도전장을 못 읽었어요', err.message);
      return null;
    });
}

/** 캔버스(쪽지·분실 공고)는 그리는 순간의 글꼴로 굳으므로, 손글씨·제목 글꼴을 잠깐 기다린다 */
function waitForFonts(doc) {
  if (!doc.fonts || !doc.fonts.load) return Promise.resolve();
  const loads = Promise.all(CANVAS_FONTS.map((f) => doc.fonts.load(f).catch(() => null)));
  return Promise.race([loads, new Promise((r) => setTimeout(r, FONT_WAIT_MS))]);
}

async function bootApp() {
  const doc = document;
  const $ = (id) => doc.getElementById(id);
  const snipeId = readSnipeId(location.search);
  const [server] = await Promise.all([loadServerState(), waitForFonts(doc)]);
  $('offline-note').hidden = server.online;
  const sound = createSound(safeStorage());
  let challenge = null;
  loadChallenge(doc, server, readChallengeId(location.search)).then((c) => {
    challenge = c;
  });

  const surface = setupCanvas($('game-canvas'));
  let session = null;
  const input = createInput($('game-canvas'), surface.getView, () => session.player());
  const screens = createScreens(doc, input);
  const worldStore = createWorldStore({
    doc,
    server,
    snipeId,
    // 재동기화로 장부에서 빠진 광고(유실된 takedown)는 날아가던 것도 지운다
    onApply: (world) => session && session.keepOnly(new Set(world.ledger.advertisers.map((a) => a.id))),
  });
  const death = createDeathScreen({ doc, server, snipeId, getWorld: worldStore.get, getChallenge: () => challenge });
  session = createSession({
    doc,
    surface,
    input,
    screens,
    getWorld: worldStore.get,
    onEvents: (events) => events.forEach((e) => sound.play(e)),
    onDeath: (game) => {
      screens.go('die');
      death.show(game);
    },
  });
  const refreshKills = () => (server.online ? api.killRanking().then((r) => renderKillRanking(doc, r)).catch(() => {}) : Promise.resolve());
  const buyFlow = server.online
    ? createBuyFlow({
      doc,
      api,
      getLedger: () => worldStore.get().ledger,
      config: server.config,
      onPosted: () => sound.play('staple'),
      onClose: () => {
        screens.go('close');
        worldStore.refresh();
      },
    })
    : null;

  wireButtons({ doc, screens, session, buyFlow, refreshKills, sound });
  wireRealtime({ server, worldStore, session, banner: createBanner($('live-banner')), sound });
  worldStore.apply(server.ledger);
  refreshKills();
  screens.show('start');
  session.run();
}

if (typeof module !== 'undefined') {
  module.exports = { screenTransition, ledgerFromSeed, redirectTarget };
} else if (typeof document !== 'undefined') {
  bootApp();
}
