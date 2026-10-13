// bizinfo.js — 하단 사업자 정보 표시(시작 화면·신청서·약관·개인정보처리방침 공용).
//   서버 /api/business 값을 textContent로만 넣고, 서버가 없거나(Vercel 정적 미리보기) 준비 전이면 "사업자 정보 준비 중".
//   실행: apps/ad-dodge 안에서 node --test
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Z = require('./bizinfo.js');

const READY = {
  ready: true,
  name: '주간실험실',
  owner: '홍길동',
  regNo: '123-45-67890',
  address: '서울특별시 어딘가 1',
  phone: '02-000-0000',
  email: 'help@example.com',
  mailOrderNo: '',
  hostingProvider: 'Fly.io',
};

/** innerHTML을 쓰면 바로 터지는 최소 DOM */
function fakeDoc() {
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      className: '',
      _text: '',
      append(...kids) {
        el.children.push(...kids);
      },
      replaceChildren(...kids) {
        el.children = [...kids];
        el._text = '';
      },
      get textContent() {
        return el._text + el.children.map((c) => c.textContent).join('');
      },
      set textContent(v) {
        el.children = [];
        el._text = String(v);
      },
      set innerHTML(_) {
        throw new Error('innerHTML 사용 금지');
      },
    };
    return el;
  };
  const nodes = [make('div'), make('div')];
  return { createElement: make, querySelectorAll: () => nodes, nodes };
}

test('businessRows: 준비 전·정보 없음이면 null', () => {
  assert.equal(Z.businessRows(null), null);
  assert.equal(Z.businessRows({ ...READY, ready: false }), null);
});

test('businessRows: 상호·대표·등록번호·통신판매업·주소·연락처·호스팅 순서, 신고번호가 비면 "신고 준비 중"', () => {
  const rows = Z.businessRows(READY);
  const labels = rows.map((r) => r.label);
  for (const l of ['상호', '대표', '사업자등록번호', '통신판매업 신고', '주소', '전화', '이메일', '호스팅']) assert.ok(labels.includes(l), l);
  assert.equal(rows.find((r) => r.label === '통신판매업 신고').value, '신고 준비 중');
  assert.equal(rows.find((r) => r.label === '상호').value, '주간실험실');
});

test('fillBusinessInfo: 값은 textContent로만 들어간다(태그 문자열도 글자 그대로)', () => {
  const doc = fakeDoc();
  const el = doc.createElement('div');
  Z.fillBusinessInfo(doc, el, { ...READY, name: '<img src=x onerror=alert(1)>' });
  assert.match(el.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(el.textContent, /123-45-67890/);
});

test('fillBusinessInfo: 정보가 없으면 "사업자 정보 준비 중"', () => {
  const doc = fakeDoc();
  const el = doc.createElement('div');
  Z.fillBusinessInfo(doc, el, null);
  assert.equal(el.textContent, Z.BIZ_PENDING_TEXT);
  assert.match(Z.BIZ_PENDING_TEXT, /사업자 정보 준비 중/);
});

test('loadBusinessInfo: 서버 없음(fetch 실패)·404·JSON 아님은 null', async () => {
  assert.equal(await Z.loadBusinessInfo(() => Promise.reject(new TypeError('Failed to fetch'))), null);
  assert.equal(await Z.loadBusinessInfo(async () => ({ ok: false, json: async () => ({}) })), null);
  assert.equal(await Z.loadBusinessInfo(async () => ({ ok: true, json: async () => { throw new SyntaxError('html'); } })), null);
  assert.deepEqual(await Z.loadBusinessInfo(async () => ({ ok: true, json: async () => READY })), READY);
});

test('bootBusinessInfo: 페이지의 모든 표시 칸을 한 번의 요청으로 채운다', async () => {
  const doc = fakeDoc();
  let calls = 0;
  await Z.bootBusinessInfo(doc, async (url) => {
    calls += 1;
    assert.equal(url, '/api/business');
    return { ok: true, json: async () => READY };
  });
  assert.equal(calls, 1);
  for (const n of doc.nodes) assert.match(n.textContent, /주간실험실/);
});

test('bootBusinessInfo: 서버가 없으면(정적 미리보기) 전부 "준비 중"', async () => {
  const doc = fakeDoc();
  await Z.bootBusinessInfo(doc, () => Promise.reject(new TypeError('Failed to fetch')));
  for (const n of doc.nodes) assert.equal(n.textContent, Z.BIZ_PENDING_TEXT);
});

test('bizinfo.js 는 innerHTML·insertAdjacentHTML·document.write 를 쓰지 않는다', () => {
  const src = fs.readFileSync(path.join(__dirname, 'bizinfo.js'), 'utf8');
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
