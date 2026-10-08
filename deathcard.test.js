// deathcard.js 단위 테스트 — 사망 카드 문구 조립(순수 함수)만 검증한다.
//   캔버스 그리기·공유는 브라우저 수동 확인 대상(plan Validation 절).
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildDeathCardText, truncateName, formatSeconds, CARD_WIDTH, CARD_HEIGHT, TOP_N } = require('./deathcard.js');

const names = { A: '주간실험실', B: '샘플 광고주', C: '아주아주아주아주긴광고주이름입니다' };

test('카드 크기는 인스타 스토리 9:16 (1080×1920)', () => {
  assert.equal(CARD_WIDTH, 1080);
  assert.equal(CARD_HEIGHT, 1920);
});

test('formatSeconds: 소수점 1자리', () => {
  assert.equal(formatSeconds(12.44), '12.4초');
  assert.equal(formatSeconds(0), '0.0초');
});

test('truncateName: 12자 초과는 말줄임', () => {
  assert.equal(truncateName('주간실험실'), '주간실험실');
  assert.equal(truncateName('아주아주아주아주긴광고주이름입니다'), '아주아주아주아주긴광고주…');
});

test('buildDeathCardText: 헤드라인에 죽인 광고주 이름', () => {
  const t = buildDeathCardText({ killerId: 'A', survivedSeconds: 12.44, dodged: {}, names });
  assert.equal(t.headline, '당신은 주간실험실에게 죽었습니다');
  assert.equal(t.survived, '12.4초 버팀');
});

test('buildDeathCardText: 피한 광고 TOP3 — 많이 피한 순, 동률은 이름순', () => {
  const t = buildDeathCardText({
    killerId: 'A',
    survivedSeconds: 30,
    dodged: { A: 3, B: 7, C: 3, D: 1 },
    names: { ...names, D: '넷째' },
  });
  assert.equal(TOP_N, 3);
  assert.deepEqual(t.top.map((r) => r.count), [7, 3, 3]);
  assert.equal(t.top[0].name, '샘플 광고주');
  assert.deepEqual(t.top.slice(1).map((r) => r.name), ['아주아주아주아주긴광고주…', '주간실험실']);
});

test('buildDeathCardText: 하나도 못 피했으면 빈 TOP', () => {
  const t = buildDeathCardText({ killerId: 'A', survivedSeconds: 1, dodged: {}, names });
  assert.deepEqual(t.top, []);
});

test('buildDeathCardText: 이름을 모르는 광고주는 "알 수 없는 광고"', () => {
  const t = buildDeathCardText({ killerId: 'ZZ', survivedSeconds: 1, dodged: {}, names });
  assert.equal(t.headline, '당신은 알 수 없는 광고에게 죽었습니다');
});

test('buildDeathCardText: shareText에 생존 시간과 광고 문구', () => {
  const t = buildDeathCardText({ killerId: 'A', survivedSeconds: 5, dodged: {}, names });
  assert.match(t.shareText, /5\.0초/);
  assert.match(t.shareText, /주간실험실/);
});

test('[MEDIUM] truncateName: 합성 이모지(ZWJ)를 중간에서 자르지 않는다', () => {
  const family = '👨‍👩‍👧';
  const name = `광고주이름열한글자${family}뒤`; // 9자 + 가족 이모지(1글자) + 2자
  const out = truncateName(`${name}더길게`);
  assert.ok(out.includes(family), out);
  assert.ok(!out.includes('‍…'));
});

test('[M4] 저격 링크 판에서 저격 광고에 죽으면 "○○님의 광고에 당했습니다"', () => {
  const t = buildDeathCardText({ killerId: 'S', sniperId: 'S', survivedSeconds: 3, dodged: {}, names: { S: '민수' } });
  assert.equal(t.headline, '민수님의 광고에 당했습니다');
  assert.match(t.shareText, /민수/);
});

test('[M4] 저격 판이어도 다른 광고에 죽으면 기본 문구', () => {
  const t = buildDeathCardText({ killerId: 'A', sniperId: 'S', survivedSeconds: 3, dodged: {}, names: { A: '주간실험실', S: '민수' } });
  assert.equal(t.headline, '당신은 주간실험실에게 죽었습니다');
});


test('[게시판] dodgedTotal: 피한 광고 총 장수(분실 공고에 표시)', () => {
  const t = buildDeathCardText({ killerId: 'A', survivedSeconds: 3, dodged: { A: 3, B: 7, C: 0 }, names: { A: 'a', B: 'b', C: 'c' } });
  assert.equal(t.dodgedTotal, 10);
});

// ── 고도화: 백분위 · 도전 결과 · 아슬아슬 ──────────────────────────
const { formatTopPercent, challengeResult } = require('./deathcard.js');

test('formatTopPercent: 나보다 짧게 버틴 비율 → "상위 N%"(최소 1%), 비교 대상 없으면 null', () => {
  assert.equal(formatTopPercent(0.88), '상위 12%');
  assert.equal(formatTopPercent(0.999), '상위 1%');
  assert.equal(formatTopPercent(0), '상위 100%');
  assert.equal(formatTopPercent(null), null);
});

test('challengeResult: 도전 기록을 넘으면 격파, 못 넘으면 패배', () => {
  assert.deepEqual(challengeResult({ name: '민수', seconds: 18.2 }, 19), { won: true, text: '민수 격파! (18.2초 넘김)' });
  assert.deepEqual(challengeResult({ name: '민수', seconds: 18.2 }, 12.4), { won: false, text: '민수에게 졌다 (18.2초)' });
  assert.equal(challengeResult(null, 3), null);
});

test('buildDeathCardText: 아슬아슬 횟수·백분위·도전 결과가 문구에 들어간다', () => {
  const t = buildDeathCardText({
    killerId: 'A', survivedSeconds: 19, dodged: {}, names: { A: '동네치킨' },
    nearMisses: 4, percentile: { betterThan: 0.88, total: 120 }, challenge: { name: '민수', seconds: 18.2 },
  });
  assert.equal(t.nearMisses, 4);
  assert.equal(t.rankLine, '오늘 120판 중 상위 12%');
  assert.equal(t.challenge.won, true);
  assert.match(t.shareText, /상위 12%/);
  assert.match(t.shareText, /민수 격파/);
});

test('buildDeathCardText: 오늘 첫 판이면 "오늘 첫 기록"', () => {
  const t = buildDeathCardText({ killerId: 'A', survivedSeconds: 3, dodged: {}, names: {}, percentile: { betterThan: null, total: 1 } });
  assert.equal(t.rankLine, '오늘 첫 기록');
  const none = buildDeathCardText({ killerId: 'A', survivedSeconds: 3, dodged: {}, names: {} });
  assert.equal(none.rankLine, null, '집계 전(서버 응답 전·오프라인)');
});
