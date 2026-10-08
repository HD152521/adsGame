// 소리·진동 — 파일 없이 Web Audio로 종이 소리를 합성한다(의존성·용량 0).
//   종이 바스락(광고 등장), 휙(아슬아슬), 스테이플러 쾅(전단 살포·게시 완료), 찢어짐(맞음), 경고 딸깍.
//   소리는 사용자가 처음 누른 순간(피하러 가기)부터 켤 수 있다(브라우저 자동재생 정책).
//   켜기/끄기는 기기에 기억한다(localStorage — 막혀 있어도 게임은 돈다).
//   순수 부분(설정 읽기·사건 판정)은 sound.test.js가 검증한다.

const SOUND_STORAGE_KEY = 'ad-dodge:muted';
const SPAWN_SOUND_GAP_MS = 140; // 광고가 몰려 나와도 바스락이 겹쳐 시끄럽지 않게
const HIT_VIBRATE_MS = [60, 40, 90];

function loadMuted(storage) {
  try {
    return storage.getItem(SOUND_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(storage, muted) {
  try {
    storage.setItem(SOUND_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* 저장 불가 — 이번 방문 동안만 유지 */
  }
}

function totalSeen(seen) {
  return Object.values(seen || {}).reduce((a, b) => a + b, 0);
}

/** 이전·다음 게임 상태 → 이번 프레임에 난 사건들 */
function gameEvents(prev, next) {
  const events = [];
  if (totalSeen(next.seen) > totalSeen(prev.seen)) events.push('spawn');
  if (next.nearMisses > prev.nearMisses) events.push('whoosh');
  if (next.waves > prev.waves) events.push('wave');
  if (next.waveWarning && !prev.waveWarning) events.push('warning');
  if (next.dead && !prev.dead) events.push('hit');
  return events;
}

// ── 브라우저 전용 ─────────────────────────────────────────────

function createSound(storage) {
  let muted = loadMuted(storage);
  let ctx = null;
  let noise = null;
  let lastSpawn = 0;

  const ensure = () => {
    if (ctx || typeof window === 'undefined') return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const len = ctx.sampleRate;
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
    return ctx;
  };

  /** 걸러낸 잡음 한 번 — 종이 소리의 재료 */
  const burst = ({ dur, type, freq, q = 1, gain = 0.3, sweepTo = null, delay = 0 }) => {
    const c = ensure();
    if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = noise;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    filter.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(c.destination);
    src.start(t0, Math.random() * 0.5, dur + 0.05);
  };

  const thump = (delay = 0) => {
    const c = ensure();
    if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(140, t0);
    o.frequency.exponentialRampToValueAtTime(50, t0 + 0.12);
    g.gain.setValueAtTime(0.5, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + 0.16);
  };

  const sounds = {
    spawn: () => burst({ dur: 0.09, type: 'bandpass', freq: 3200, q: 0.8, gain: 0.08 }),
    whoosh: () => burst({ dur: 0.22, type: 'bandpass', freq: 600, sweepTo: 4200, q: 1.4, gain: 0.25 }),
    warning: () => {
      burst({ dur: 0.04, type: 'highpass', freq: 5000, gain: 0.25 });
      burst({ dur: 0.04, type: 'highpass', freq: 5000, gain: 0.25, delay: 0.12 });
    },
    staple: () => {
      thump();
      burst({ dur: 0.05, type: 'highpass', freq: 3500, gain: 0.35, delay: 0.01 });
    },
    wave: () => {
      sounds.staple();
      burst({ dur: 0.5, type: 'bandpass', freq: 2500, q: 0.6, gain: 0.18, delay: 0.05 });
    },
    hit: () => {
      burst({ dur: 0.35, type: 'bandpass', freq: 1800, sweepTo: 400, q: 0.9, gain: 0.4 });
      if (!muted && typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(HIT_VIBRATE_MS);
    },
  };

  return {
    /** 첫 사용자 동작에서 호출 — 브라우저가 소리를 허락하는 시점 */
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
    },
    play(name) {
      if (name === 'spawn') {
        const now = Date.now();
        if (now - lastSpawn < SPAWN_SOUND_GAP_MS) return;
        lastSpawn = now;
      }
      try {
        if (sounds[name]) sounds[name]();
      } catch (err) {
        console.warn('[sound] 재생 실패', name, err);
      }
    },
    isMuted: () => muted,
    setMuted(value) {
      muted = value;
      saveMuted(storage, value);
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { loadMuted, saveMuted, gameEvents, createSound, SOUND_STORAGE_KEY };
}
