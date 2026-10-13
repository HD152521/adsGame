// 외부 백업(선택 기능) — S3 호환 저장소에 장부 백업 파일을 PUT 으로 올린다. 서명은 AWS Signature Version 4 를
//   Node 내장 crypto 로 직접 만든다(npm 의존성 없음).
//   켜는 법: 다섯 값이 모두 있을 때만 켜진다(하나라도 비면 꺼짐 — 로컬 백업만).
//     BACKUP_S3_ENDPOINT   https://… (예: Cloudflare R2 https://<계정>.r2.cloudflarestorage.com)
//     BACKUP_S3_BUCKET     버킷 이름(비공개 버킷이어야 한다 — 백업에는 결제 검증값이 들어 있다)
//     BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY   그 버킷에 쓰기만 되는 키 권장
//     BACKUP_S3_REGION     예: auto(R2), ap-northeast-2(AWS)
//   올리는 위치: {endpoint}/{bucket}/ad-dodge/{파일명} (경로 방식 — 대부분의 S3 호환 저장소가 받는다)
//
// 근거(추측 구현 금지 원칙): 서명 절차는 AWS 공식 문서 "Create a signed AWS API request"
//   (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html) 를 따르고,
//   AWS 공개 SigV4 테스트 스위트(https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4)의
//   get-vanilla · get-space-unnormalized · post-x-www-form-urlencoded 벡터로 서명 일치를 검증했다(server/sigv4.test.js).
//   S3 는 경로를 정규화하지 않고 조각마다 한 번만 인코딩한다(unnormalized 벡터와 같은 규칙).

const crypto = require('node:crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const S3_SERVICE = 's3';
const KEY_PREFIX = 'ad-dodge/';
const UPLOAD_TIMEOUT_MS = 30_000;
const S3_ENV = Object.freeze({
  endpoint: 'BACKUP_S3_ENDPOINT',
  bucket: 'BACKUP_S3_BUCKET',
  accessKeyId: 'BACKUP_S3_ACCESS_KEY',
  secretAccessKey: 'BACKUP_S3_SECRET_KEY',
  region: 'BACKUP_S3_REGION',
});

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 인코딩 — 영숫자와 -_.~ 만 그대로 */
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** 경로 → 정규 URI(조각마다 한 번 인코딩, 정규화 안 함) */
function canonicalUri(pathname) {
  const raw = pathname || '/';
  return raw.split('/').map((seg) => uriEncode(decodeURIComponentSafe(seg))).join('/');
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function canonicalQuery(searchParams) {
  return [...searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** 20150830T123600Z */
const amzDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/**
 * SigV4 서명 → { headers(원래 헤더 + host·x-amz-date·[x-amz-content-sha256]·authorization), signature, canonicalRequest, stringToSign }
 * signBody: true 면 x-amz-content-sha256 헤더를 넣고 서명한다(S3 는 필수).
 */
function signV4({ method, url, headers = {}, body = '', accessKeyId, secretAccessKey, region, service, now, signBody = true }) {
  const u = new URL(url);
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const all = { ...headers, host: u.host, 'x-amz-date': date, ...(signBody ? { 'x-amz-content-sha256': payloadHash } : {}) };
  const canon = Object.entries(all)
    .map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')])
    .sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = canon.map(([k]) => k).join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(u.pathname),
    canonicalQuery(u.searchParams),
    canon.map(([k, v]) => `${k}:${v}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const lowered = Object.fromEntries(canon.filter(([k]) => k !== 'host'));
  return {
    headers: { ...lowered, authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
    signature,
    canonicalRequest,
    stringToSign,
  };
}

/** 환경변수 → { config | null, missing: 빠진 이름들(일부만 있을 때), error } */
function readS3Config(env) {
  const values = Object.fromEntries(Object.entries(S3_ENV).map(([k, name]) => [k, String(env[name] || '').trim()]));
  const missing = Object.entries(S3_ENV).filter(([k]) => !values[k]).map(([, name]) => name);
  if (missing.length === Object.keys(S3_ENV).length) return { config: null, missing: [], error: null };
  if (missing.length > 0) return { config: null, missing, error: null };
  if (!/^https:\/\/[^/]+/i.test(values.endpoint)) return { config: null, missing: [], error: 'BACKUP_S3_ENDPOINT 는 https:// 주소여야 합니다' };
  return { config: { ...values, endpoint: values.endpoint.replace(/\/+$/, '') }, missing: [], error: null };
}

/** S3 업로더 → async ({ name, body }) — 실패하면 throw(응답 본문·키는 메시지에 넣지 않는다) */
function createS3Uploader({ config, fetch = globalThis.fetch, now = Date.now }) {
  return async function upload({ name, body }) {
    const url = `${config.endpoint}/${uriEncode(config.bucket)}/${KEY_PREFIX}${uriEncode(name)}`;
    const { headers } = signV4({
      method: 'PUT',
      url,
      headers: { 'content-type': 'application/json' },
      body,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: config.region,
      service: S3_SERVICE,
      now: now(),
    });
    let res;
    try {
      res = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`외부 저장소에 연결하지 못했습니다(${err.name})`);
    }
    if (!res.ok) throw new Error(`외부 저장소가 거부했습니다(HTTP ${res.status})`);
  };
}

module.exports = { signV4, canonicalUri, readS3Config, createS3Uploader, S3_ENV };
