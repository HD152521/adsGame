// 광고 1차 검수 — 계좌 발급 "전"에 거른다(거절될 광고가 입금되면 환불 비용이 생긴다).
//   이름: 길이·제어문자·URL/전화번호·욕설. 이미지: PNG/JPG/WEBP만, 실제 바이트 확인, 크기 상한.
//   SVG는 스크립트를 품을 수 있어 받지 않는다.
//
//   이미지 내용(선정성·폭력·얼굴) 판정은 classifier로 분리했다 — 외부 AI 이미지 필터 키가 생기면
//   같은 인터페이스({ classify({image}) → 'approve'|'review'|'reject' })로 꽂는다.
//   키가 없는 기본값(reviewAllClassifier)은 이미지 광고를 전부 관리자 승인 대기열로 보낸다.
//   실행 검증: apps/ad-dodge 안에서 node --test (server/moderation.test.js)

const NAME_MAX = 16;
const MAX_IMAGE_BYTES = 512 * 1024;

const CONTROL_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/;
const URL_LIKE = /(https?:\/\/|www\.|\.(com|kr|net|io|co|me|org|xyz|shop|link)\b)/i;
const PHONE_LIKE = /0\d{8,}/;
// 최소 목록 — 띄어쓰기·특수문자 우회는 normalizeForFilter가 막는다. 운영 중 신고로 보강한다.
const BANNED_WORDS = ['시발', '씨발', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '좆', '개새끼', '새끼', '느금', '니미', '섹스', '자살', '창녀', '한남', '김치녀'];

const IMAGE_TYPES = {
  'image/png': { ext: 'png', magic: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', magic: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
};
const DATA_URL = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/;

// 광고에 맞아 죽으면 이 주소로 즉시 이동한다 — 플레이어를 보내는 곳이므로 엄격하게.
const LANDING_URL_MAX = 300;
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

function graphemeLength(s) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s)].length;
  }
  return [...s].length;
}

function normalizeForFilter(s) {
  return s.toLowerCase().replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g, '');
}

/** → { name } | { error } */
function validateName(raw) {
  const name = String(raw ?? '').trim();
  if (name.length === 0) return { error: '광고 이름을 적어 주세요' };
  if (graphemeLength(name) > NAME_MAX) return { error: `이름은 ${NAME_MAX}자까지예요` };
  if (CONTROL_CHARS.test(name)) return { error: '이름에 쓸 수 없는 문자가 있어요' };
  if (URL_LIKE.test(name) || PHONE_LIKE.test(name.replace(/[\s-]/g, ''))) {
    return { error: '이름에 링크·전화번호는 넣을 수 없어요' };
  }
  const normalized = normalizeForFilter(name);
  if (BANNED_WORDS.some((w) => normalized.includes(w))) return { error: '사용할 수 없는 표현이 들어 있어요' };
  return { name };
}

/** data URL → { buffer, mime, ext } | { error } */
function decodeImage(dataUrl) {
  const m = DATA_URL.exec(String(dataUrl ?? ''));
  const type = m && IMAGE_TYPES[m[1]];
  if (!type) return { error: 'PNG·JPG·WEBP 이미지만 올릴 수 있어요' };
  const buffer = Buffer.from(m[2], 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) return { error: `이미지는 최대 ${MAX_IMAGE_BYTES / 1024}KB까지예요` };
  if (!type.magic(buffer)) return { error: 'PNG·JPG·WEBP 이미지만 올릴 수 있어요 (파일 내용이 형식과 달라요)' };
  return { buffer, mime: m[1], ext: type.ext };
}

/**
 * 광고주 이동 주소 → { url: string|null } | { error }. 비어 있으면 url=null(선택 항목).
 * http/https만, 스킴이 없으면 https로 본다. 계정정보가 박힌 주소·내부망 주소는 거부(피싱·SSRF 성격).
 */
function validateLandingUrl(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return { url: null };
  if (text.length > LANDING_URL_MAX) return { error: `이동 주소는 ${LANDING_URL_MAX}자까지예요` };
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  let parsed;
  try {
    parsed = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return { error: '이동 주소 형식이 올바르지 않아요' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: '이동 주소는 http(s) 주소만 쓸 수 있어요' };
  if (parsed.username || parsed.password) return { error: '이동 주소에 계정 정보를 넣을 수 없어요' };
  if (!parsed.hostname.includes('.') || PRIVATE_HOST.test(parsed.hostname)) return { error: '공개된 웹사이트 주소만 쓸 수 있어요' };
  if (parsed.href.length > LANDING_URL_MAX) return { error: `이동 주소는 ${LANDING_URL_MAX}자까지예요` };
  return { url: parsed.href };
}

/** 기본값: 이미지 광고·이동 주소가 있는 광고는 관리자 검토, 나머지 텍스트 광고(이름 필터 통과)는 승인 */
function reviewAllClassifier() {
  return { name: 'review-all', classify: async ({ image, landingUrl }) => (image || landingUrl ? 'review' : 'approve') };
}

/** 로컬 데모 전용(MODERATION_MODE=auto-approve) — 운영에서 쓰지 말 것 */
function autoApproveClassifier() {
  return { name: 'auto-approve', classify: async () => 'approve' };
}

module.exports = {
  NAME_MAX,
  MAX_IMAGE_BYTES,
  validateName,
  decodeImage,
  validateLandingUrl,
  reviewAllClassifier,
  autoApproveClassifier,
};
