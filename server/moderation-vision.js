// 이미지 AI 검수 — Google Cloud Vision(SafeSearch + 얼굴 감지) 분류기.
//   server/moderation.js 의 classifier 인터페이스를 그대로 구현한다:
//     { name: 'vision', classify({ image, landingUrl }) → 'approve' | 'review' | 'reject' }  (async, 절대 throw 하지 않음)
//
// 판정 순서:
//   1) 이미지가 없으면(텍스트 광고) Vision 을 부르지 않는다 — 이동 주소가 있으면 검토, 없으면 승인(review-all 과 같음)
//   2) adult·violence·racy 중 하나라도 LIKELY·VERY_LIKELY 면 거절(얼굴·이동 주소와 상관없이)
//   3) 그중 하나라도 POSSIBLE·UNKNOWN 이면 검토
//   4) 얼굴이 하나라도 감지되면 검토(초상권 — 사람 얼굴은 관리자가 본다)
//   5) 이동 주소가 있으면 검토(기존 정책 유지)
//   6) 나머지는 승인
//   API 오류·타임아웃·형식이 이상한 응답은 전부 검토로 떨어진다 — 열린 채 실패(승인)하지 않는다.
//   이미지 속 글자(OCR) 욕설 검사는 하지 않는다(범위 밖).
//
// 근거 문서(구현 전 재확인할 것):
//   · POST https://vision.googleapis.com/v1/images:annotate
//     본문 { requests: [{ image: { content: base64 }, features: [{ type: 'SAFE_SEARCH_DETECTION' }, { type: 'FACE_DETECTION' }] }] }
//     https://cloud.google.com/vision/docs/reference/rest/v1/images/annotate
//   · 응답 responses[0].safeSearchAnnotation { adult, spoof, medical, violence, racy } — Likelihood 문자열
//     (UNKNOWN · VERY_UNLIKELY · UNLIKELY · POSSIBLE · LIKELY · VERY_LIKELY)
//     https://cloud.google.com/vision/docs/detecting-safe-search
//   · 응답 responses[0].faceAnnotations — 얼굴이 없으면 필드가 빠지거나 빈 배열
//   · 200 이어도 responses[0].error 가 올 수 있다
//   · API 키는 x-goog-api-key 헤더로 보낸다(쿼리 ?key= 는 주소째 로그에 남을 수 있어 쓰지 않는다)
//     https://cloud.google.com/docs/authentication/api-keys-use
//   키는 GOOGLE_VISION_API_KEY 환경변수로만 받는다(server/index.js). 로그·오류 메시지에 키를 싣지 않는다.
//   실행 검증: apps/ad-dodge 안에서 node --test (server/moderation-vision.test.js)

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const VISION_TIMEOUT_MS = 8000; // 광고 신청 화면이 기다리는 시간 — 넘으면 검토로 돌린다
const GRADED_FIELDS = ['adult', 'violence', 'racy']; // spoof(합성·패러디)·medical 은 판정에 쓰지 않는다
const LIKELIHOOD_VERDICT = Object.freeze({
  VERY_UNLIKELY: 'approve',
  UNLIKELY: 'approve',
  UNKNOWN: 'review',
  POSSIBLE: 'review',
  LIKELY: 'reject',
  VERY_LIKELY: 'reject',
});
const LOG_DETAIL_MAX = 120;

/** 텍스트를 로그에 남기기 전에 키를 지우고 길이를 자른다 */
function scrub(text, apiKey) {
  return String(text ?? '').split(apiKey).join('***').slice(0, LOG_DETAIL_MAX);
}

/** Vision 응답 본문 → 'approve'|'review'|'reject' 또는 이상하면 { problem } */
function judgeResponse(body) {
  const first = body && Array.isArray(body.responses) ? body.responses[0] : undefined;
  if (!first || typeof first !== 'object') return { problem: '응답에 responses[0] 이 없음' };
  if (first.error) return { problem: `응답 오류 ${first.error.code ?? ''} ${first.error.message ?? ''}` };
  const safe = first.safeSearchAnnotation;
  if (!safe || typeof safe !== 'object') return { problem: 'safeSearchAnnotation 없음' };
  const verdicts = GRADED_FIELDS.map((f) => LIKELIHOOD_VERDICT[safe[f]]);
  if (verdicts.some((v) => v === undefined)) return { problem: 'SafeSearch 등급 형식 이상' };
  const faces = first.faceAnnotations;
  if (faces !== undefined && !Array.isArray(faces)) return { problem: 'faceAnnotations 형식 이상' };

  if (verdicts.includes('reject')) return 'reject';
  if (verdicts.includes('review')) return 'review';
  if (faces && faces.length > 0) return 'review';
  return 'approve';
}

/**
 * Vision 분류기. apiKey 는 호출하는 쪽이 환경변수에서 읽어 넘긴다.
 * fetch·timeoutMs·log 는 테스트 주입용(기본: Node 내장 fetch, 8초, console.warn).
 */
function createVisionClassifier({ apiKey, fetch = globalThis.fetch, timeoutMs = VISION_TIMEOUT_MS, log = console.warn, endpoint = VISION_ENDPOINT } = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) throw new Error('MODERATION_MODE=vision 이면 GOOGLE_VISION_API_KEY 환경변수가 필요합니다');
  if (typeof fetch !== 'function') throw new Error('fetch 가 필요합니다(Node 18+)');

  function fail(reason) {
    log(`[vision] 이미지 검수 실패 → 관리자 검토로 돌립니다: ${scrub(reason, key)}`);
    return 'review';
  }

  async function annotate(image) {
    const request = {
      requests: [{ image: { content: image.buffer.toString('base64') }, features: [{ type: 'SAFE_SEARCH_DETECTION' }, { type: 'FACE_DETECTION' }] }],
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function judgeImage(image) {
    if (!Buffer.isBuffer(image.buffer) || image.buffer.length === 0) return fail('이미지 바이트 없음');
    let result;
    try {
      result = await annotate(image);
    } catch (err) {
      return fail(`연결 실패 ${err && err.name === 'TimeoutError' ? '(타임아웃)' : ''} ${err && err.message}`);
    }
    if (result.status !== 200) {
      const e = result.body && result.body.error;
      return fail(`HTTP ${result.status} ${(e && e.status) || ''} ${(e && e.message) || ''}`);
    }
    const verdict = judgeResponse(result.body);
    return typeof verdict === 'string' ? verdict : fail(verdict.problem);
  }

  async function classify({ image, landingUrl } = {}) {
    try {
      if (!image) return landingUrl ? 'review' : 'approve';
      const verdict = await judgeImage(image);
      if (verdict === 'approve' && landingUrl) return 'review';
      return verdict;
    } catch (err) {
      return fail(`예상 못 한 오류 ${err && err.message}`);
    }
  }

  return { name: 'vision', classify };
}

module.exports = { createVisionClassifier, VISION_ENDPOINT };
