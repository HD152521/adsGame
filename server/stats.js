// 판 기록·백분위·도전장·광고 성과·킬 순위 — 돈과 무관한 "놀이 기록". 주문 서비스(orders.js)가 묶어서 쓴다.
//   전부 클라이언트가 보내는 값이라 위조될 수 있다 → 범위 자르기·장부에 있는 광고만·판당 상한으로 피해를 묶는다.
//   광고주에게는 "참고용 기록"으로만 보여주고 약속하지 않는다(약속은 확률뿐 — PRD 핵심 규칙).
//   실행 검증: apps/ad-dodge 안에서 node --test (server/orders.test.js)

const crypto = require('node:crypto');
const { validateName } = require('./moderation.js');

const KST_OFFSET_MS = 9 * 3600 * 1000;
const MAX_RUN_SECONDS = 600;       // 10분 넘게 버틴 기록은 10분으로
const BUCKET_PER_SECOND = 10;      // 0.1초 단위로 센다
const SEEN_CAP_PER_AD = 500;       // 한 판에서 한 광고가 이보다 많이 나올 수는 없다
const SEEN_CAP_PER_RUN = 2000;
const KILL_RANKING_SIZE = 10;
const MAX_CHALLENGES = 5000;
const CHALLENGE_KEY_PREFIX = 'c_'; // 숫자처럼 보이는 키는 객체 순서가 바뀌므로 접두사로 "넣은 순서"를 지킨다

function parseSeconds(raw) {
  const s = Number(raw);
  if (!Number.isFinite(s) || s < 0) throw new Error('기록이 올바르지 않아요');
  return Math.min(MAX_RUN_SECONDS, s);
}

function createStatsService({ store, now, getLedger }) {
  const todayKey = () => new Date(now() + KST_OFFSET_MS).toISOString().slice(0, 10);
  const ledgerById = () => new Map(getLedger().advertisers.map((a) => [a.id, a]));

  function bumpAdStats(s, advId, delta) {
    const prev = s.adStats[advId] || { seen: 0, kills: 0, visits: 0 };
    return {
      ...s.adStats,
      [advId]: { seen: prev.seen + (delta.seen || 0), kills: prev.kills + (delta.kills || 0), visits: prev.visits + (delta.visits || 0) },
    };
  }

  /** 오늘 킬 수(순위용) + 누적 광고 성과의 킬 */
  function recordKill(advId) {
    if (!ledgerById().has(advId)) throw new Error('장부에 없는 광고입니다');
    const day = todayKey();
    store.update((s) => {
      const counts = s.kills[day] || {};
      return { ...s, kills: { [day]: { ...counts, [advId]: (counts[advId] || 0) + 1 } }, adStats: bumpAdStats(s, advId, { kills: 1 }) };
    }, { lazy: true });
  }

  /** 한 판에서 보고된 등장 수 — 장부에 있는 광고만, 광고당·판당 상한 */
  function sanitizeSeen(seen, byId) {
    const out = {};
    let total = 0;
    for (const [id, raw] of Object.entries(seen || {})) {
      if (!byId.has(id)) continue;
      const n = Math.max(0, Math.min(SEEN_CAP_PER_AD, Math.floor(Number(raw) || 0), SEEN_CAP_PER_RUN - total));
      if (n > 0) {
        out[id] = n;
        total += n;
      }
    }
    return out;
  }

  /**
   * 한 판 기록 → 오늘 백분위. betterThan = 오늘 앞선 판들 중 나보다 짧게 버틴 비율(첫 판이면 null).
   * 등장 수·킬·사이트 이동도 함께 쌓는다.
   */
  function recordRun({ seconds, killerId = null, seen = {}, redirected = false }) {
    // redirected는 HTTP 층(app.js)에서 "같은 사람·같은 광고 하루 한 번"으로 이미 걸러져 들어온다
    const sec = parseSeconds(seconds);
    const byId = ledgerById();
    const cleanSeen = sanitizeSeen(seen, byId);
    const day = todayKey();
    const mine = Math.floor(sec * BUCKET_PER_SECOND);
    const runs = store.read().runs[day] || { buckets: {}, total: 0 };
    const below = Object.entries(runs.buckets).reduce((sum, [b, n]) => (Number(b) < mine ? sum + n : sum), 0);
    const betterThan = runs.total > 0 ? below / runs.total : null;

    store.update((s) => {
      let adStats = s.adStats;
      for (const [id, n] of Object.entries(cleanSeen)) adStats = bumpAdStats({ ...s, adStats }, id, { seen: n });
      const killer = killerId && byId.get(killerId);
      if (killer && redirected && killer.landingUrl) adStats = bumpAdStats({ ...s, adStats }, killerId, { visits: 1 });
      const next = { buckets: { ...runs.buckets, [mine]: (runs.buckets[mine] || 0) + 1 }, total: runs.total + 1 };
      return { ...s, adStats, runs: { [day]: next } }; // 오늘 것만 유지
    }, { lazy: true });
    if (killerId && byId.has(killerId)) recordKill(killerId);
    return { betterThan, total: runs.total + 1 };
  }

  function statsFor(advId) {
    const s = store.read().adStats[advId];
    return s ? { ...s } : { seen: 0, kills: 0, visits: 0 };
  }

  function getKillRanking() {
    const counts = store.read().kills[todayKey()] || {};
    const byId = ledgerById();
    return Object.entries(counts)
      .filter(([id]) => byId.has(id))
      .map(([id, kills]) => ({ id, name: byId.get(id).name, isHouse: byId.get(id).isHouse, kills }))
      .sort((a, b) => b.kills - a.kills)
      .slice(0, KILL_RANKING_SIZE);
  }

  /** 도전장: "민수 18.2초 — 넘어봐". 이름은 광고 이름과 같은 필터를 거친다 */
  function createChallenge({ name: rawName, seconds }) {
    const { name, error } = validateName(rawName);
    if (error) throw new Error(error);
    const sec = Math.round(parseSeconds(seconds) * 10) / 10;
    const id = crypto.randomBytes(5).toString('hex');
    store.update((s) => {
      const challenges = { ...s.challenges, [CHALLENGE_KEY_PREFIX + id]: { name, seconds: sec, createdAt: now() } };
      const keys = Object.keys(challenges);
      if (keys.length > MAX_CHALLENGES) delete challenges[keys[0]]; // 넣은 순서 = 가장 오래된 것(정렬 없음)
      return { ...s, challenges };
    }, { lazy: true });
    return { id, name, seconds: sec };
  }

  function getChallenge(id) {
    const c = store.read().challenges[CHALLENGE_KEY_PREFIX + id];
    return c ? { id, name: c.name, seconds: c.seconds } : null;
  }

  return { recordKill, recordRun, statsFor, getKillRanking, createChallenge, getChallenge };
}

module.exports = { createStatsService, MAX_RUN_SECONDS, MAX_CHALLENGES };
