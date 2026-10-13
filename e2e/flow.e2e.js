// 핵심 흐름 E2E 시나리오(계획서 Step 7) — e2e/run.js 가 테스트 서버·헤드리스 브라우저를 띄운 뒤 부른다.
//   시작 → 플레이(키·드래그 입력 주입) → 사망 → 사망 카드(미리보기·저장) → 도전장 만들기 → 도전장 링크 열기 →
//   광고 붙이기(테스트 모드 무료, 로고 업로드) → 출연(장부 100%·게시판) → 내 광고에 맞아 사망 → 신고 →
//   관리자 화면에서 떼어 내기 → 게임 게시판·장부에서 사라짐 → 이동 주소 광고에 맞으면 그 주소로 즉시 이동 →
//   관리자 화면(Step 5·6): 환불 완료 폼·CSV 내려받기·최근 문제·관리 기록 → 모든 화면 콘솔 오류 0
//   게임 코드에 테스트 훅은 넣지 않았다 — 실제 입력 이벤트(CDP Input)와 실제 시간으로 돈다(가만히 있으면 수 초 안에 맞는다).
//   광고 이동 주소는 가짜 도메인(ad-landing.test)이고 브라우저가 127.0.0.1 로 풀어서 외부로 나가지 않는다.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { openPage, sleep } = require('./cdp.js');
const { writeTestPng } = require('./harness.js');

const DEATH_TIMEOUT_MS = 90_000; // 입력 주입 뒤 가만히 두면 보통 3~10초 안에 맞는다
const DOWNLOAD_TIMEOUT_MS = 10_000;
const LOGO_AD = 'E2E치킨';
const LANDING_AD = 'E2E이동';
const CHALLENGER = '도전자E2E';
const REFUND_MEMO = 'E2E 국민 이체 기록';

const js = (value) => JSON.stringify(value);

/** 페이지 안 간단 조작 — 값 넣기(입력 이벤트까지)·체크·글자 읽기 */
function domHelpers(page) {
  return {
    text: (selector) => page.evaluate(`(document.querySelector(${js(selector)}) || {}).textContent || ''`),
    hidden: (selector) => page.evaluate(`(() => { const el = document.querySelector(${js(selector)}); return !el || el.hidden || el.closest('[hidden]') !== null; })()`),
    fill: (selector, value) => page.evaluate(`(() => { const el = document.querySelector(${js(selector)}); el.value = ${js(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`),
    // 꾸민 체크박스·라디오는 화면 크기가 0일 수 있어 요소의 click() 으로 누른다
    check: (selector) => page.evaluate(`(() => { const el = document.querySelector(${js(selector)}); if (!el.checked) el.click(); return el.checked; })()`),
    screen: () => page.evaluate('document.body.dataset.screen'),
  };
}

/** 관리자 목록에서 이름이 든 줄의 버튼(글자로 찾음)에 표시를 달고 → 그 선택자 */
async function markAdminButton(page, adName, label) {
  const mark = `e2e-${Math.random().toString(36).slice(2)}`;
  const found = await page.waitFor(`(() => {
    const li = [...document.querySelectorAll('#admin-list > li')].find((l) => l.textContent.includes(${js(adName)}));
    const b = li && [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === ${js(label)});
    if (!b) return false;
    b.dataset.e2e = ${js(mark)};
    return true;
  })()`, { what: `관리자 목록 "${adName}" 의 [${label}] 버튼` });
  assert.ok(found);
  return `[data-e2e="${mark}"]`;
}

async function waitForDownload(dir, pattern) {
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const name = fs.readdirSync(dir).find((f) => pattern.test(f));
    if (name) return path.join(dir, name);
    await sleep(100);
  }
  throw new Error(`내려받기 파일이 생기지 않았습니다: ${pattern} (폴더 ${fs.readdirSync(dir).join(', ') || '비어 있음'})`);
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  assert.equal(res.status, 200, `${url} → ${res.status}`);
  return res.json();
}

/** 플레이 시작 → 입력 주입(방향키·드래그) → 사망 화면까지 */
async function playUntilDeath(game, dom) {
  await game.click('#btn-play');
  await game.waitFor("document.body.dataset.screen === 'playing'", { what: '플레이 화면' });
  await game.holdKey('ArrowLeft', 'ArrowLeft', 37, 250);
  const canvas = await game.evaluate("(() => { const r = document.getElementById('game-canvas').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.7 }; })()");
  await game.drag(canvas, { x: canvas.x + 60, y: canvas.y - 40 });
  const clock = Number(await dom.text('#hud-time'));
  assert.ok(clock > 0, `플레이 중 시계가 흐른다(${clock}초)`);
  await game.waitFor("document.body.dataset.screen === 'dead'", { timeout: DEATH_TIMEOUT_MS, what: '사망 화면' });
}

function createReporter(log) {
  let n = 0;
  return async (title, fn) => {
    n += 1;
    const started = Date.now();
    const detail = await fn();
    log(`✔ ${String(n).padStart(2, '0')}. ${title}${detail ? ` — ${detail}` : ''} (${((Date.now() - started) / 1000).toFixed(1)}초)`);
  };
}

async function runFlow({ cdp, base, port, adminToken, dirs, landingHost, log }) {
  const step = createReporter(log);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dirs.downloadDir });
  const logoFile = writeTestPng(path.join(dirs.root, 'e2e-logo.png'));
  const game = await openPage(cdp);
  const dom = domHelpers(game);
  let landingOrderId = null;
  let admin = null; // 관리자 탭은 쓸 때 연다(탭이 여럿이면 뒤쪽 탭은 숨김 상태라 게임 루프가 멈춘다 → 게임 쪽은 front())
  let adm = null;

  await step('시작 화면 — 서버 장부(관리사무소 광고)·피하러 가기 버튼', async () => {
    await game.goto(`${base}/`);
    await game.waitFor("document.getElementById('board-list').children.length > 0", { what: '게시판 목록' });
    assert.equal(await dom.screen(), 'start');
    assert.equal(await dom.hidden('#offline-note'), true, '서버 연결됨(공사 중 문구 없음)');
    return `게시판 ${await game.evaluate("document.getElementById('board-list').children.length")}줄`;
  });

  await step('플레이(방향키·드래그 입력) → 사망', async () => {
    await playUntilDeath(game, dom);
    return `${await dom.text('#hud-time')}초 버팀`;
  });

  await step('사망 카드 — 1080×1920 미리보기 생성, 저장(공유 시트 없는 환경 → 내려받기)', async () => {
    const card = await game.waitFor(`(() => { const img = document.getElementById('card-preview'); return img.src.startsWith('data:image/png') && img.complete && img.naturalWidth ? { w: img.naturalWidth, h: img.naturalHeight, alt: img.alt } : null; })()`, { what: '사망 카드 미리보기' });
    assert.deepEqual([card.w, card.h], [1080, 1920]);
    assert.match(card.alt, /죽었습니다|당했습니다/);
    // 헤드리스는 OS 공유 시트를 누를 수 없다 — 인앱 브라우저처럼 파일 공유가 없는 경우의 대체 경로(내려받기)를 확인한다
    await game.evaluate("Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }), true");
    await game.click('#btn-share');
    await game.waitFor("document.getElementById('share-status').textContent.includes('저장했어요')", { what: '저장 안내' });
    const file = await waitForDownload(dirs.downloadDir, /^death-card.*\.png$/);
    assert.deepEqual([...fs.readFileSync(file).subarray(1, 4)], [0x50, 0x4e, 0x47]);
    return card.alt;
  });

  let challengeUrl = '';
  await step('도전장 만들기 → 링크 열기(시작 화면 포스트잇·HUD 목표)', async () => {
    await game.waitFor("!document.getElementById('challenge-box').hidden", { what: '도전장 칸' });
    await dom.fill('#challenge-name', CHALLENGER);
    await game.click('#btn-challenge-make');
    challengeUrl = await game.waitFor("(() => { const v = document.getElementById('challenge-url').value; return /\\?challenge=[a-f0-9]{10}$/.test(v) ? v : null; })()", { what: '도전장 링크' });
    assert.ok(challengeUrl.startsWith(`${base}/?challenge=`), challengeUrl);
    await game.goto(challengeUrl);
    await game.waitFor("!document.getElementById('challenge-banner').hidden", { what: '도전장 포스트잇' });
    assert.equal(await dom.text('#challenge-from'), CHALLENGER);
    assert.match(await dom.text('#hud-target'), /^목표 \d+\.\d초$/);
    return challengeUrl.replace(base, '');
  });

  await step('광고 붙이기 — 테스트 모드 무료 추가, 로고 업로드(복사기 미리보기)', async () => {
    await game.click('#btn-buy');
    await game.waitFor("document.body.dataset.screen === 'buying'", { what: '신청서 화면' });
    assert.match(await dom.text('#btn-buy-submit'), /테스트 모드/);
    await dom.fill('#buy-name', LOGO_AD);
    await game.setFiles('#buy-logo', [logoFile]);
    await game.waitFor("!document.getElementById('buy-logo-preview').hidden && document.getElementById('buy-logo-preview').src.startsWith('data:image/png')", { what: '로고 미리보기' });
    await dom.fill('#buy-slots', '3');
    assert.equal(await dom.text('#buy-amount'), '3,000원');
    for (const name of ['consentRights', 'consentDilution', 'consentRefund']) assert.equal(await dom.check(`#buy-form input[name="${name}"]`), true);
    await game.click('#btn-buy-submit');
    await game.waitFor("!document.getElementById('pay-stamp').hidden", { what: '"붙임" 도장' });
    return dom.text('#pay-status');
  });

  await step('출연 — 장부에 반영(확률 100%·3칸·로고 파일), 게시판에 보임', async () => {
    const ledger = await getJson(`${base}/api/ledger`);
    const ad = ledger.advertisers.find((a) => a.name === LOGO_AD);
    assert.ok(ad, JSON.stringify(ledger.advertisers.map((a) => a.name)));
    assert.equal(ledger.advertisers.length, 1, '유료 광고가 생기면 관리사무소 광고는 빠진다');
    assert.equal(ad.share, 1);
    assert.equal(ad.slots, 3);
    assert.equal(ledger.soldSlots, 3);
    assert.match(ad.logoUrl, /^\/uploads\/[a-f0-9]{12}\.png$/);
    assert.equal((await fetch(`${base}${ad.logoUrl}`)).status, 200);
    await game.click('#btn-buy-close');
    await game.waitFor(`document.body.dataset.screen === 'start' && document.getElementById('board-list').textContent.includes(${js(LOGO_AD)})`, { what: '게시판에 새 광고' });
    const row = await game.evaluate("document.querySelector('#board-list li').textContent");
    assert.match(row, /100%/);
    assert.equal(await dom.text('#board-sold'), '3');
    return row;
  });

  await step('내 광고에 맞아 사망 → 사망 카드에 광고 이름 → 신고 접수', async () => {
    await playUntilDeath(game, dom);
    const alt = await game.waitFor("document.getElementById('card-preview').alt", { what: '사망 카드' });
    assert.ok(alt.includes(LOGO_AD), alt);
    await game.click('#report summary');
    await game.click('#report [data-reason="other"]');
    await game.waitFor("document.getElementById('report-status').textContent.includes('접수')", { what: '신고 접수 문구' });
    return dom.text('#report-status');
  });

  await step('관리자 화면 — 신고 1건 보이고, 떼어 내기', async () => {
    admin = await openPage(cdp, { width: 1280, height: 900, mobile: false });
    adm = domHelpers(admin);
    await admin.front();
    await admin.goto(`${base}/admin.html`);
    await adm.fill('#admin-login input[name="token"]', adminToken);
    await admin.click('#admin-login button[type="submit"]');
    await admin.waitFor("document.getElementById('admin-status').textContent.endsWith('건')", { what: '검수 대기 목록' });
    await admin.click('#admin-tabs [data-status="active"]');
    await admin.waitFor(`[...document.querySelectorAll('#admin-list > li')].some((l) => l.textContent.includes(${js(LOGO_AD)}) && l.textContent.includes('신고 1'))`, { what: '붙어 있음 목록의 신고 1건' });
    await admin.click(await markAdminButton(admin, LOGO_AD, '떼어 내기'));
    await admin.waitFor(`![...document.querySelectorAll('#admin-list > li')].some((l) => l.textContent.includes(${js(LOGO_AD)}))`, { what: '붙어 있음 목록에서 빠짐' });
    await admin.click('#admin-tabs [data-status="hidden"]');
    await admin.waitFor(`[...document.querySelectorAll('#admin-list > li')].some((l) => l.textContent.includes(${js(LOGO_AD)}))`, { what: '떼어 냄 목록' });
    assert.ok(admin.dialogs.some((d) => d.includes('떼어 내기')), JSON.stringify(admin.dialogs));
    return '떼어 냄 목록으로 이동';
  });

  await step('게임에서 사라짐 — 열려 있던 게임 화면 게시판(실시간)·장부', async () => {
    await game.front();
    await game.waitFor(`!document.getElementById('board-list').textContent.includes(${js(LOGO_AD)})`, { what: '게임 게시판에서 빠짐' });
    const ledger = await getJson(`${base}/api/ledger`);
    assert.equal(ledger.advertisers.some((a) => a.name === LOGO_AD), false);
    assert.equal(ledger.soldSlots, 0);
    return `장부: ${ledger.advertisers.map((a) => a.name).join(', ')}`;
  });

  await step('이동 주소 광고에 맞으면 그 주소로 즉시 이동(로컬 가짜 도메인)', async () => {
    const landing = `http://${landingHost}:${port}/terms.html?from=e2e-ad`;
    await game.click('#btn-home');
    await game.click('#btn-buy');
    await game.waitFor("document.body.dataset.screen === 'buying'", { what: '신청서 화면' });
    await dom.check('#buy-form input[name="kind"][value="snipe"]');
    await dom.fill('#buy-name', LANDING_AD);
    await dom.fill('#buy-url', landing);
    for (const name of ['consentRights', 'consentDilution', 'consentRefund']) await dom.check(`#buy-form input[name="${name}"]`);
    const previous = await game.evaluate("document.getElementById('buy-step-pay').dataset.orderId || ''");
    await game.click('#btn-buy-submit');
    // 도장은 앞 주문 것이 남아 있을 수 있다 — 새 주문번호가 들어오고 결제 단계가 보일 때까지 기다린다
    landingOrderId = await game.waitFor(`(() => { const pay = document.getElementById('buy-step-pay'); const id = pay.dataset.orderId; return id && id !== ${js(previous)} && !pay.hidden && !document.getElementById('pay-stamp').hidden ? id : null; })()`, { what: '새 주문 "붙임" 도장' });
    await game.click('#btn-buy-close');
    await game.waitFor(`document.getElementById('board-list').textContent.includes(${js(LANDING_AD)})`, { what: '게시판에 이동 광고' });
    await game.click('#btn-play');
    await game.waitFor("document.body.dataset.screen === 'playing'", { what: '플레이 화면' });
    const href = await game.waitFor(`location.href.startsWith(${js(`http://${landingHost}:${port}/terms.html`)}) && document.readyState === 'complete' ? location.href : null`, { timeout: DEATH_TIMEOUT_MS, what: '광고 이동 주소 도착' });
    assert.equal(href, landing);
    assert.match(await game.evaluate('document.title'), /약관/);
    // 사이트 이동은 sendBeacon 으로 광고 성과에 남는다(하루 한 번)
    const order = await waitForValue(async () => {
      const o = await getJson(`${base}/api/orders/${landingOrderId}`);
      return { ok: Boolean(o.stats && o.stats.visits >= 1), value: o };
    }, '광고 성과의 사이트 이동 1회');
    return `${href.replace(`:${port}`, ':{포트}')} · 사이트 이동 ${order.stats.visits}회`;
  });

  await step('관리자 화면(Step 5·6) — 삭제·환불 → 환불 완료 폼으로 기록', async () => {
    await admin.front();
    await admin.click('#admin-tabs [data-status="active"]');
    await admin.click(await markAdminButton(admin, LANDING_AD, '삭제·환불'));
    await admin.click('#admin-tabs [data-status="refund_required"]');
    await admin.click(await markAdminButton(admin, LANDING_AD, '환불 완료 처리'));
    const form = await admin.waitFor("(() => { const f = document.querySelector('#admin-list .admin__edit'); if (!f) return null; const at = f.querySelector('input[type=datetime-local]'); return at && at.value ? { at: at.value, note: f.querySelector('small').textContent } : null; })()", { what: '환불 완료 폼' });
    assert.match(form.note, /되돌릴 수 없습니다/);
    await adm.fill('#admin-list .admin__edit input[type=text]', REFUND_MEMO);
    await admin.click('#admin-list .admin__edit button[type=submit]');
    await admin.waitFor(`![...document.querySelectorAll('#admin-list > li')].some((l) => l.textContent.includes(${js(LANDING_AD)}))`, { what: '환불 필요 목록에서 빠짐' }).catch(async (err) => {
      throw new Error(`${err.message} — 폼 오류 문구: ${await adm.text('#admin-list .admin__edit-error')}`);
    });
    await admin.click('#admin-tabs [data-status="refunded"]');
    const row = await admin.waitFor(`(() => { const li = [...document.querySelectorAll('#admin-list > li')].find((l) => l.textContent.includes(${js(LANDING_AD)})); const r = li && li.querySelector('.admin__refund'); return r ? r.textContent : null; })()`, { what: '환불 완료 기록 줄' });
    assert.ok(row.includes(REFUND_MEMO), row);
    return row;
  });

  await step('관리자 화면 — CSV 내려받기(BOM·환불 완료 행)', async () => {
    await admin.click('#admin-export');
    const file = await waitForDownload(dirs.downloadDir, /^ad-dodge-orders-\d{8}-refunded\.csv$/);
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8');
    assert.ok(text.includes(`,${LANDING_AD},`) && text.includes('환불 완료') && text.includes(REFUND_MEMO), text);
    assert.equal(text.includes(landingOrderId), false, '전체 주문번호는 CSV 에 없다');
    return `${path.basename(file)} ${bytes.length}바이트`;
  });

  await step('관리자 화면 — 최근 문제·관리 기록(감사 로그) 렌더', async () => {
    await admin.waitFor("!document.getElementById('admin-errors').hidden && document.getElementById('admin-errors-count').textContent !== ''", { what: '최근 문제 칸' });
    const errorsCount = await adm.text('#admin-errors-count');
    assert.equal(errorsCount, '없음', `최근 문제: ${await adm.text('#admin-errors-list')}`);
    await admin.waitFor("!document.getElementById('admin-audit').hidden && document.getElementById('admin-audit-list').textContent.includes('CSV 내려받기')", { what: '관리 기록의 CSV 내려받기' });
    const audit = await adm.text('#admin-audit-list');
    for (const action of ['떼어 내기', '거절·환불', '환불 완료', 'CSV 내려받기']) assert.ok(audit.includes(action), `관리 기록에 ${action}`);
    assert.equal(audit.includes(adminToken), false, '관리 기록에 토큰 원문 없음');
    return `최근 문제 ${errorsCount} · 관리 기록 ${await adm.text('#admin-audit-count')}`;
  });

  await step('콘솔 오류 0 — 게임·관리자 화면 전체', async () => {
    const all = [...game.errors.map((e) => ({ ...e, tab: '게임' })), ...admin.errors.map((e) => ({ ...e, tab: '관리자' }))];
    assert.deepEqual(all, [], `콘솔 오류:\n${all.map((e) => `[${e.tab}] ${e.page} ${e.text}`).join('\n')}`);
    return `게임 ${game.errors.length} · 관리자 ${admin.errors.length}`;
  });

  await game.close();
  await admin.close();
}

/** fn() → { ok, value } 가 ok 일 때까지(Node 쪽에서 서버 API 를 다시 물어봄) */
async function waitForValue(fn, what, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last.ok) return last.value;
    await sleep(200);
  }
  throw new Error(`기다리다 시간 초과(${timeout}ms): ${what} — 마지막 값 ${JSON.stringify(last && last.value)}`);
}

module.exports = { runFlow };
