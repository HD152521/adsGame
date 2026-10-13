// AWS Signature Version 4 서명(외부 백업 업로드용) — AWS 공식 SigV4 테스트 스위트 값으로 서명 일치를 검증한다.
//   추측 구현 금지 원칙: 아래 기대값은 직접 계산한 것이 아니라 AWS 가 공개한 테스트 벡터를 그대로 옮긴 것이다.
//   출처(2026-10-13 확인): https://github.com/awslabs/aws-c-auth/tree/main/tests/aws-signing-test-suite/v4
//     · get-vanilla                  — 가장 기본 GET(본문 서명 없음)
//     · get-space-unnormalized       — 경로 인코딩(S3 처럼 경로 정규화 안 함, 공백 → %20)
//     · post-x-www-form-urlencoded   — 본문 서명(x-amz-content-sha256) + 추가 헤더
//   공통: AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, us-east-1, service "service", 2015-08-30T12:36:00Z
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { signV4, canonicalUri, readS3Config, createS3Uploader } = require('./sigv4.js');

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' };
const AT = Date.UTC(2015, 7, 30, 12, 36, 0);

test('[SigV4] 공식 벡터 get-vanilla — 정규 요청·서명 문자열·서명이 모두 일치', () => {
  const r = signV4({ ...CREDS, method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, now: AT, signBody: false });
  assert.equal(r.canonicalRequest, 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(r.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
  assert.equal(r.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(r.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(r.headers['x-amz-date'], '20150830T123600Z');
});

test('[SigV4] 공식 벡터 get-space-unnormalized — 경로의 공백은 %20, 정규화하지 않는다', () => {
  assert.equal(canonicalUri('/example space/'), '/example%20space/');
  const r = signV4({ ...CREDS, method: 'GET', url: 'https://example.amazonaws.com/example space/', headers: {}, now: AT, signBody: false });
  assert.equal(r.signature, '652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741');
});

test('[SigV4] 공식 벡터 post-x-www-form-urlencoded — 본문 해시(x-amz-content-sha256) 서명', () => {
  const r = signV4({
    ...CREDS,
    method: 'POST',
    url: 'https://example.amazonaws.com/',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '13' },
    body: 'Param1=value1',
    now: AT,
    signBody: true,
  });
  assert.equal(r.canonicalRequest, [
    'POST', '/', '',
    'content-length:13',
    'content-type:application/x-www-form-urlencoded',
    'host:example.amazonaws.com',
    'x-amz-content-sha256:9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
    'x-amz-date:20150830T123600Z',
    '',
    'content-length;content-type;host;x-amz-content-sha256;x-amz-date',
    '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
  ].join('\n'));
  assert.equal(r.signature, 'd3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b');
  assert.equal(r.headers['x-amz-content-sha256'], '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e');
});

test('[외부 백업] readS3Config: 다섯 값이 모두 있을 때만 켜진다, endpoint 는 https 만', () => {
  const full = { BACKUP_S3_ENDPOINT: 'https://s3.example.com/', BACKUP_S3_BUCKET: 'bk', BACKUP_S3_ACCESS_KEY: 'AK', BACKUP_S3_SECRET_KEY: 'SK', BACKUP_S3_REGION: 'auto' };
  assert.deepEqual(readS3Config(full), { config: { endpoint: 'https://s3.example.com', bucket: 'bk', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'auto' }, missing: [], error: null });
  const partial = readS3Config({ BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_S3_BUCKET: 'bk' });
  assert.equal(partial.config, null);
  assert.deepEqual(partial.missing, ['BACKUP_S3_ACCESS_KEY', 'BACKUP_S3_SECRET_KEY', 'BACKUP_S3_REGION']);
  assert.deepEqual(readS3Config({}), { config: null, missing: [], error: null }); // 하나도 없으면 그냥 꺼짐
  const http = readS3Config({ ...full, BACKUP_S3_ENDPOINT: 'http://s3.example.com' });
  assert.equal(http.config, null);
  assert.match(http.error, /https/);
});

test('[외부 백업] 업로더: 버킷/ad-dodge/파일명 으로 서명된 PUT, 본문 해시 포함, 실패 응답은 throw(응답 본문·비밀값 없이)', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('', { status: 200 });
  };
  const config = { endpoint: 'https://s3.example.com', bucket: 'my-bucket', accessKeyId: 'AKTEST', secretAccessKey: 'SECRET/KEY+VALUE', region: 'auto' };
  const upload = createS3Uploader({ config, fetch: fakeFetch, now: () => AT });
  await upload({ name: 'db-20261013-0300.json', body: Buffer.from('{"orders":{}}') });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://s3.example.com/my-bucket/ad-dodge/db-20261013-0300.json');
  assert.equal(calls[0].init.method, 'PUT');
  const h = calls[0].init.headers;
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKTEST\/20150830\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(h['x-amz-content-sha256'], require('node:crypto').createHash('sha256').update('{"orders":{}}').digest('hex'));
  assert.equal(JSON.stringify(h).includes('SECRET/KEY+VALUE'), false);

  const failing = createS3Uploader({ config, fetch: async () => new Response('<Error>AccessDenied for SECRET</Error>', { status: 403 }), now: () => AT });
  await assert.rejects(failing({ name: 'db.json', body: Buffer.from('x') }), (err) => /403/.test(err.message) && !err.message.includes('SECRET'));
});
