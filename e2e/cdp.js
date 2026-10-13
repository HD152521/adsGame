// 작은 Chrome DevTools Protocol 드라이버(계획서 Step 7) — npm 의존성 없이 E2E 를 돌리려고 만들었다.
//   설치된 Chrome/Edge 를 --headless=new --remote-debugging-port=0 으로 띄우고,
//   Node 내장 WebSocket(Node 22+)으로 CDP 를 직접 주고받는다. Playwright 같은 패키지는 쓰지 않는다.
//
//   findBrowser()                 브라우저 실행 파일 찾기(E2E_BROWSER 환경변수 > 운영체제별 기본 설치 경로). 없으면 null
//   launchBrowser({ exe, ... })   헤드리스로 띄우고 DevTools ws 주소를 받아 연결 → { cdp, close() }
//   openPage(cdp, { ... })        새 탭 + 세션(flatten). 콘솔 오류·예외 수집, 대화상자(confirm) 자동 승인
//   page.evaluate / waitFor / click / setFiles / holdKey / drag / goto / front
//
//   외부 네트워크: 기본으로 127.0.0.1 밖 이름 풀이를 막는다(--host-resolver-rules). 테스트 광고 이동 주소용
//   가짜 도메인(mapHosts)만 127.0.0.1 로 돌린다 — 사망 시 광고 URL 이동이 실제 외부로 나가지 않는다.
//   실행 검증: apps/ad-dodge 안에서 node --test (e2e/e2e-support.test.js), 실제 흐름은 node e2e/run.js

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LAUNCH_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 15_000;
const WAIT_POLL_MS = 100;
// 게시판 글꼴(Google Fonts)은 외부라 E2E 에서는 일부러 막는다 — 그 네트워크 실패만 콘솔 오류에서 뺀다
const IGNORED_LOG_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

function windowsCandidates(env) {
  const roots = [env.PROGRAMFILES || 'C:\\Program Files', env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter(Boolean);
  const chrome = roots.map((r) => path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  const edge = roots.map((r) => path.win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  return [...chrome, ...edge];
}

const BROWSER_CANDIDATES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

/**
 * 브라우저 실행 파일 경로 | null.
 * E2E_BROWSER 를 줬으면 그것만 본다(없는 파일이면 null — 다른 브라우저로 몰래 바꿔 돌지 않게).
 */
function findBrowser({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (env.E2E_BROWSER) return exists(env.E2E_BROWSER) ? env.E2E_BROWSER : null;
  const candidates = platform === 'win32' ? windowsCandidates(env) : BROWSER_CANDIDATES[platform] || BROWSER_CANDIDATES.linux;
  return candidates.find((p) => exists(p)) || null;
}

/** 브라우저 stderr → "DevTools listening on ws://…" 의 주소 | null */
function parseDevToolsUrl(text) {
  const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(text));
  return m ? m[1] : null;
}

/** Log.entryAdded 항목 중 무시할 것(막아 둔 외부 글꼴의 네트워크 실패)인지 */
function isIgnorableLogEntry(entry) {
  if (!entry || entry.source !== 'network' || !entry.url) return false;
  try {
    return IGNORED_LOG_HOSTS.has(new URL(entry.url).hostname);
  } catch {
    return false;
  }
}

/** CDP 연결 — 요청/응답 짝 맞추기와 이벤트 구독만 한다 */
function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', resolve));
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`DevTools 에 연결하지 못했습니다: ${wsUrl}`)), { once: true });
  });
  const cdp = {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: ${CALL_TIMEOUT_MS}ms 안에 응답 없음`));
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve, reject, method, timer });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    /** 이벤트 구독 → 해제 함수 */
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      for (const { reject, method, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${method}: 연결 닫힘`));
      }
      pending.clear();
      ws.close();
      return closed;
    },
  };
  return opened.then(() => cdp);
}

function hostResolverRules(mapHosts) {
  const maps = mapHosts.map((h) => `MAP ${h} 127.0.0.1`);
  return [...maps, 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', 'EXCLUDE localhost'].join(', ');
}

/** 헤드리스 브라우저를 띄우고 CDP 에 연결한다 → { cdp, close() } */
async function launchBrowser({ exe, profileDir, mapHosts = [], log = () => {} }) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--host-resolver-rules=${hostResolverRules(mapHosts)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--disable-breakpad', // 충돌 보고 도우미 프로세스가 임시 프로필을 늦게까지 잡고 있지 않게
    '--disable-crash-reporter',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const wsUrl = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`브라우저가 ${LAUNCH_TIMEOUT_MS / 1000}초 안에 DevTools 주소를 내지 않았습니다`)), LAUNCH_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      text += chunk;
      const url = parseDevToolsUrl(text);
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`브라우저가 바로 끝났습니다(코드 ${code})`));
    });
  });
  child.stderr.resume(); // 계속 읽어서 파이프가 차서 멈추지 않게
  log(`브라우저 연결: ${path.basename(exe)}`);
  const cdp = await connectCdp(wsUrl);
  const exited = new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
  return {
    cdp,
    async close() {
      await Promise.race([cdp.send('Browser.close').catch(() => null), new Promise((r) => setTimeout(r, 3000))]);
      await cdp.close().catch(() => null);
      if (child.exitCode === null) child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 새 탭 하나 → 페이지 도구.
 *   errors: 콘솔 오류(console.error)·잡히지 않은 예외·브라우저 로그 오류(막아 둔 외부 글꼴 제외) — { page, text }
 *   dialogs: 자동 승인한 confirm/alert 문구
 */
async function openPage(cdp, { width = 390, height = 844, mobile = true } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  const errors = [];
  const dialogs = [];
  let currentUrl = 'about:blank';
  cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params || {};
    if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      errors.push({ page: currentUrl, text: p.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      errors.push({ page: currentUrl, text: `예외: ${(d.exception && d.exception.description) || d.text}` });
    } else if (msg.method === 'Log.entryAdded' && p.entry.level === 'error' && !isIgnorableLogEntry(p.entry)) {
      errors.push({ page: currentUrl, text: `${p.entry.source}: ${p.entry.text} ${p.entry.url || ''}`.trim() });
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      dialogs.push(p.message);
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => null);
    } else if (msg.method === 'Page.frameNavigated' && !p.frame.parentId) {
      currentUrl = p.frame.url;
    }
  });
  await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable', 'DOM.enable'].map((m) => send(m)));
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });

  /** 페이지에서 식을 계산해 값으로 받는다(Promise 면 기다림). 예외는 그대로 던진다 */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate 실패: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    return r.result.value;
  };

  /** 식이 참(truthy)이 될 때까지 기다려 그 값을 돌려준다. 시간이 지나면 설명과 함께 실패 */
  const waitFor = async (expression, { timeout = 10_000, what = expression } = {}) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await evaluate(expression);
        if (last) return last;
      } catch (err) {
        last = err.message; // 이동 중에는 실행 컨텍스트가 바뀌어 실패할 수 있다 — 다시 시도
      }
      await sleep(WAIT_POLL_MS);
    }
    throw new Error(`기다리다 시간 초과(${timeout}ms): ${what} — 마지막 값 ${JSON.stringify(last)}`);
  };

  return {
    errors,
    dialogs,
    send,
    evaluate,
    waitFor,
    url: () => currentUrl,
    async goto(url) {
      const loaded = new Promise((resolve) => {
        const off = cdp.on((msg) => {
          if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') {
            off();
            resolve();
          }
        });
      });
      await send('Page.navigate', { url });
      await Promise.race([loaded, sleep(CALL_TIMEOUT_MS)]);
    },
    /** 요소를 찾아 화면 안으로 굴린 뒤 실제 마우스 클릭(사용자 동작으로 취급되는 입력 이벤트) */
    async click(selector) {
      const box = await waitFor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`, { what: `클릭할 요소 ${selector}` });
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    },
    /** input[type=file] 에 로컬 파일을 넣고 change 가 나게 한다 */
    async setFiles(selector, files) {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`파일 입력을 찾지 못했습니다: ${selector}`);
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    /** 키를 누르고 ms 동안 있다가 뗀다 */
    async holdKey(key, code, keyCode, ms) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode });
      await sleep(ms);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    },
    /** 손가락(마우스 포인터) 상대 드래그 */
    async drag(from, to, steps = 8) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i += 1) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        await sleep(16);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    },
    /** 이 탭을 앞으로 — 탭이 여럿이면 뒤쪽 탭은 document.hidden 이 되어 게임 루프가 멈춘다 */
    front: () => send('Page.bringToFront'),
    close: () => cdp.send('Target.closeTarget', { targetId }).catch(() => null),
  };
}

module.exports = { findBrowser, parseDevToolsUrl, isIgnorableLogEntry, connectCdp, launchBrowser, openPage, sleep, BROWSER_CANDIDATES };
