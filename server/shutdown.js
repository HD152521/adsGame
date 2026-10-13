// 종료 처리 — SIGTERM(호스팅 배포·재시작)·SIGINT(Ctrl+C)를 받으면 밀린 lazy 쓰기(놀이 기록)를
//   디스크에 쓰고(app.close → store.flush) 코드 0 으로 끝낸다. 쓰기가 실패하면 숨기지 않고 코드 1.
//   시그널이 연달아 와도 한 번만 정리한다. proc 은 테스트에서 가짜로 바꿔 끼운다.
//   실행 검증: apps/ad-dodge 안에서 node --test (server/shutdown.test.js)

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];

/** 시그널 핸들러 등록 → shutdown(signal) (직접 불러도 된다) */
function installShutdown({ app, proc = process, logger = console }) {
  let done = false;
  const shutdown = (signal) => {
    if (done) return;
    done = true;
    try {
      app.close(); // 밀린 놀이 기록(lazy)도 여기서 디스크에 쓴다
      logger.info(`[server] ${signal} — 장부를 디스크에 쓰고 종료합니다`);
      proc.exit(0);
    } catch (err) {
      logger.error('[server] 종료 정리 실패 —', err.message);
      proc.exit(1);
    }
  };
  for (const signal of SHUTDOWN_SIGNALS) proc.on(signal, () => shutdown(signal));
  return shutdown;
}

module.exports = { installShutdown, SHUTDOWN_SIGNALS };
