# 광고 피하기 서버 이미지 — 의존성 0(npm 설치 없음), Node 내장 모듈만 쓴다.
#   빌드: podman build -t ad-dodge .   (또는 docker build)
#   실행 확인 절차: README "배포 — 컨테이너·Fly.io"
#
#   실행 사용자: 서버는 node(uid 1000) 로 돈다. 컨테이너는 root 로 시작하지만 server/container-entry.js 가
#   데이터 볼륨(/data) 주인만 node 로 바꾸고 곧바로 권한을 내려놓은 뒤 서버를 띄운다 —
#   fly 볼륨은 처음 만들면 root 소유라 USER node 로만 띄우면 장부를 못 쓰기 때문.
#   (볼륨을 미리 node 소유로 준비했다면 `--user node` 로 처음부터 비root 로 띄워도 된다)
#
#   기본값은 운영 모드(NODE_ENV=production) — 설정이 빠지면 서버가 시작을 거부한다(안전한 쪽으로 실패).
#   로컬 확인은 실행할 때 -e NODE_ENV=development 로 바꾼다.
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

WORKDIR /app

# 코드는 root 소유(읽기 전용) — 서버(node 사용자)가 자기 코드를 고칠 수 없다. 제외 목록은 .dockerignore
COPY . .

RUN mkdir -p /data && chown node:node /data

EXPOSE 8080

# exec 형식 — node 가 PID 1 이 되어 SIGTERM 을 직접 받는다(server/shutdown.js 가 장부를 쓰고 종료)
CMD ["node", "server/container-entry.js"]
