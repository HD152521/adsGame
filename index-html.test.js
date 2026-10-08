// index.html 정적 검증 — 스크립트 로드 순서(의존 방향), 외부 스크립트 0, 필수 화면 요소 존재,
//   시드 장부가 실존 브랜드를 쓰지 않는지(상표권 — PRD Risks).
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);

test('스크립트는 의존 순서대로 로드된다(app.js가 마지막)', () => {
  assert.deepEqual(scripts, ['rng.js', 'paper.js', 'shares.js', 'game.js', 'seed-ledger.js', 'render.js', 'input.js', 'deathcard.js', 'sound.js', 'api.js', 'buy.js', 'app.js']);
});

test('외부(http/https/프로토콜 상대) 스크립트·스타일이 없다', () => {
  assert.doesNotMatch(html, /<script[^>]+src="(https?:)?\/\//);
  assert.doesNotMatch(html, /<link[^>]+href="(https?:)?\/\/[^"]*\.css/);
});

test('필수 화면 요소가 있다', () => {
  for (const id of ['screen-start', 'screen-dead', 'screen-buy', 'game-canvas', 'btn-play', 'btn-retry', 'btn-share', 'btn-home', 'btn-buy', 'btn-buy-dead', 'board-sold', 'board-list', 'rule-snipe', 'hud-time', 'hud-top', 'card-preview', 'live-banner', 'snipe-banner', 'snipe-name', 'kills', 'kills-list', 'report', 'report-status', 'share-status', 'buy-form', 'buy-step-form', 'buy-step-pay', 'buy-logo-field', 'buy-logo-preview', 'buy-amount', 'buy-share', 'buy-errors', 'buy-resume', 'btn-buy-submit', 'board-tabs', 'offline-note', 'pay-stamp', 'btn-sound', 'hud-target', 'challenge-banner', 'challenge-from', 'challenge-seconds', 'challenge-box', 'challenge-make', 'challenge-made', 'challenge-name', 'btn-challenge-make', 'challenge-url', 'btn-challenge-share', 'challenge-status', 'pay-stats', 'pay-stats-text', 'pay-topup', 'topup-slots', 'topup-consent', 'btn-topup', 'btn-buy-close', 'pay-status', 'pay-account-box', 'pay-bank', 'pay-account', 'pay-holder', 'pay-amount', 'pay-due', 'btn-dev-deposit', 'pay-snipe', 'pay-snipe-url', 'btn-copy-snipe']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
});

test('발사체 명칭은 "악당"이 아니라 "광고"', () => {
  assert.doesNotMatch(html, /악당/);
});

test('시드 장부: 모든 광고주는 하우스/샘플로 표시되고, 로고는 동일 출처 경로다', () => {
  const { SEED_LEDGER } = require('./seed-ledger.js');
  assert.ok(SEED_LEDGER.length > 0);
  for (const e of SEED_LEDGER) {
    assert.equal(e.isHouse, true, `${e.id}는 실제 구매가 아니므로 isHouse`);
    assert.match(e.logo, /^assets\/logos\/[a-z0-9-]+\.svg$/);
    assert.ok(fs.existsSync(path.join(__dirname, e.logo)), `${e.logo} 파일 존재`);
  }
});

test('[M2] 구매 폼: 필수 동의 3개 + 약관 링크 + 폼 필드 이름', () => {
  for (const n of ['kind', 'name', 'slots', 'logo', 'consentRights', 'consentDilution', 'consentRefund']) {
    assert.match(html, new RegExp(`name="${n}"`), n);
  }
  assert.match(html, /href="terms.html"/);
  assert.match(html, /희석/);
});

test('[M3] 관리자·약관 페이지는 외부 스크립트 없이 존재한다', () => {
  for (const f of ['admin.html', 'terms.html']) {
    const page = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.doesNotMatch(page, /<script[^>]+src="(https?:)?\/\//, f);
  }
  const terms = fs.readFileSync(path.join(__dirname, 'terms.html'), 'utf8');
  for (const must of ['희석', '환불', '임시', '노출 횟수']) assert.match(terms, new RegExp(must), must);
});

test('[이동 주소] 구매 폼에 이동 주소 입력칸, 시작 화면·약관에 "맞으면 이동" 공개', () => {
  assert.match(html, /name="landingUrl"/);
  assert.match(html, /광고주 사이트로 이동/);
  const terms = fs.readFileSync(path.join(__dirname, 'terms.html'), 'utf8');
  assert.match(terms, /사이트로 이동/);
});
