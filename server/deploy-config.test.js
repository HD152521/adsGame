// 배포 구성 파일(Dockerfile·.dockerignore·fly.toml) 회귀 — 사람이 고치다 실수로 빠뜨리기 쉬운 줄을 붙잡는다.
//   실제 빌드·실행 확인은 README "컨테이너 로컬 확인"(podman build·run) 절차로 한다.
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('Dockerfile: 공식 경량 Node 20 이미지, 의존성 설치 없음, 데이터는 /data, 비root 로 강등하는 진입점', () => {
  const body = lines(read('Dockerfile'));
  assert.match(body.find((l) => l.startsWith('FROM ')), /^FROM node:20-alpine/);
  assert.ok(!body.some((l) => /npm (ci|install)|yarn|pnpm/.test(l)), '의존성 설치 금지(의존성 0)');
  assert.ok(body.some((l) => /DATA_DIR=\/data/.test(l)));
  assert.ok(body.some((l) => /chown .*node:node \/data|chown node:node \/data/.test(l)), '/data 는 node 사용자 소유');
  assert.match(body.find((l) => l.startsWith('CMD')), /server\/container-entry\.js/);
  assert.ok(body.some((l) => /^EXPOSE 8080$/.test(l)));
});

test('.dockerignore: 테스트·장부(data)·문서·로컬 스크립트를 이미지에 넣지 않는다', () => {
  const ignore = lines(read('.dockerignore'));
  for (const pattern of ['**/*.test.js', 'data', 'docs', 'start-test.cmd', 'dom-stub.js']) assert.ok(ignore.includes(pattern), `${pattern} 누락`);
});

test('fly.toml: 영구 볼륨 /data, 내부 포트 8080, https 강제, /api/health 헬스체크, 단일 인스턴스, 프록시 신뢰', () => {
  const toml = read('fly.toml');
  assert.match(toml, /^app = "adsgame"/m, '앱 이름은 실제 fly 앱(adsgame)');
  assert.match(toml, /^\s*SALES_OPEN = "0"/m, '사업자 등록·PG 심사 전에는 광고 접수 준비 중');
  assert.match(toml, /\[mounts\][^[]*destination = "\/data"/);
  assert.match(toml, /DATA_DIR = "\/data"/);
  assert.match(toml, /NODE_ENV = "production"/);
  assert.match(toml, /TRUST_PROXY = "1"/);
  assert.match(toml, /internal_port = 8080/);
  assert.match(toml, /force_https = true/);
  assert.match(toml, /path = "\/api\/health"/);
  assert.match(toml, /min_machines_running = 1/);
  assert.match(toml, /auto_stop_machines = "off"/);
  assert.match(toml, /단일 인스턴스/);
  assert.match(toml, /kill_signal = "SIGTERM"/);
  assert.ok(!/(ADMIN_TOKEN|TOSS_SECRET_KEY|WEBHOOK_SECRET|GOOGLE_VISION_API_KEY)\s*=/.test(toml), '비밀값은 fly.toml 에 적지 않는다(fly secrets)');
});
