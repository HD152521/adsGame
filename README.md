# 이건 광고입니다 (ad-dodge)

디자인 방향: **게시판 복사 전단** — 코르크 게시판에 테이프·압정·스테이플로 붙인 복사지. 광고는 윗변이 뜯긴 쪽지,
로고는 복사기로 뽑은 흑백(관리자 검수 화면만 원본 색), 플레이어는 매직 졸라맨, 사망 카드는 "목숨 찾습니다" 분실 공고.
색 5개·글꼴 4역할·자간·기울기 규칙은 `style.css` 머리 주석, 질감 도구는 `paper.js`.

날아오는 광고주 로고를 피하는 모바일 웹 게임. 광고를 숨기지 않고 **게임의 적 그 자체**로 판다.

- PRD: `~/.claude/prds/ad-dodge-game.prd.md` · M1 계획: `~/.claude/plans/ad-dodge-game.plan.md`
- 주차 기록: [`weeks/w13-ad-dodge`](../../weeks/w13-ad-dodge/)

## 핵심 규칙 (공개 규칙 — 약관 `terms.html`과 같아야 한다)
- 판매 한도 1,000,000칸, 1칸 = 1,000원
- 등장 확률 = 내 칸 ÷ **팔린** 전체 칸 (새 구매가 오면 희석). 하우스 광고는 유료 광고가 0개일 때만 나온다. 확률만 약속하고 노출 횟수는 약속하지 않는다
- **보스** = 하우스 제외 최다 칸 광고(동률이면 먼저 결제). 크고 빠르지만 확률은 그대로
- **저격 링크**(`/?snipe=<id>`)로 들어온 판만 광고의 20%가 저격 광고
- 현금·경품 보상 없음

## 바이럴·재미·광고주 기능
- **사망 카드**: 오늘 백분위("오늘 120판 중 상위 12%"), 아슬아슬 횟수, 도전 결과가 들어간다
- **도전장**: 사망 화면에서 이름을 적어 `/?challenge=<id>` 링크 생성 → 받은 사람 시작 화면·HUD에 목표 기록, 결과 카드에 "격파!/졌다"
- **아슬아슬**: 쪽지가 몸을 스치고 지나가면 빨간 매직 "휙!"
- **전단 살포**: 30초마다 한쪽 가장자리에서 6~14장이 쏟아짐(1.5초 전 경고)
- **소리·진동**: Web Audio로 합성한 종이 소리(파일 없음). 플레이 중 오른쪽 아래에서 끄고 켬
- **광고 성과(참고 기록)**: 내 광고 보기에서 날아간 횟수·쓰러뜨린 수·사이트 이동 수 — 클라이언트 보고값이라 약속 아님
- **칸 추가**: 붙어 있는 내 광고에 칸만 더 얹기(주문번호가 소유 증명, 재검수 없음). 가림·복구는 원래 칸과 함께
- **관리자 고치기**: 붙어 있음·검수 대기·떼어 냄 목록에서 광고 이름·이동 주소·로고를 수정(칸 수·금액은 제외 — 거절·환불로). 같은 검증을 거치고 게임 화면에 바로 반영
- **자동 백업**: 서버가 1시간마다 `data/backups/`에 장부 사본(이틀치)

## 실행
의존성 0 (npm·번들러 없음). Node 20+.

```bash
cd apps/ad-dodge
node --test                      # 전체 테스트 (게임 + 서버 통합)

# 기능 테스트(결제 없이 바로 추가): start-test.cmd 더블클릭 → http://127.0.0.1:5173

# 로컬 서버 (모의 PG 입금 버튼 켬)
ADMIN_TOKEN=local-admin-token-1234 WEBHOOK_SECRET=local-webhook-secret-1234 DEV_DEPOSIT=1 node server/index.js
#  게임     http://localhost:5173
#  관리자   http://localhost:5173/admin.html  (토큰 = ADMIN_TOKEN)
```

서버 없이 `python -m http.server`로 열어도 하우스 광고로 게임만 돈다(구매 버튼 비활성).

| 환경변수 | 설명 |
|---|---|
| `ADMIN_TOKEN` | 관리자 토큰 (필수, 16자+ · **운영 모드는 32자+**, 무작위 값: `openssl rand -hex 32`) |
| `PAYMENT_PROVIDER` | `mock`(기본, 모의 PG) / `toss`(토스페이먼츠 가상계좌). 다른 값이면 시작 거부. **운영 모드에서 `mock`(또는 비움)이면 시작 거부** |
| `WEBHOOK_SECRET` | 모의 PG 웹훅 서명 비밀값 (`PAYMENT_PROVIDER=mock`일 때 필수, 16자+) |
| `TOSS_SECRET_KEY` | 토스페이먼츠 **시크릿 키**(`test_sk_…`/`live_sk_…`). `PAYMENT_PROVIDER=toss`일 때 필수 — 없거나 형식이 틀리면 시작 거부. 호스팅 비밀값으로만 넣는다 |
| `TOSS_VA_BANK` | 가상계좌 은행 코드(선택, 기본 `20` 우리은행). 발급 가능 은행: 03·06·07·11·20·31·32·34·37·39·71·81·88 |
| `FREE_MODE=1` | 테스트 모드 — 결제 없이 주문 즉시 출연 (127.0.0.1 전용) |
| `DEV_DEPOSIT=1` | 입금 시뮬레이션 버튼·엔드포인트. **운영에서 켜면 공짜 광고가 된다** |
| `MODERATION_MODE` | `review-all`(기본: 이미지 광고는 관리자 승인) / `vision`(Google Vision SafeSearch·얼굴 감지 — 선정·폭력 높으면 거절, 애매·얼굴·이동 주소는 관리자 검토, API 실패도 검토) / `auto-approve`(로컬 데모 — 운영 모드에서는 시작 거부) |
| `GOOGLE_VISION_API_KEY` | `MODERATION_MODE=vision` 일 때 필수(없으면 시작 거부). 환경변수로만 넣고 로그에 찍지 않는다 |
| `HOST` | 기본 `0.0.0.0`. `FREE_MODE`·`DEV_DEPOSIT`이면 늘 `127.0.0.1` |
| `DATA_DIR` | 기본 `./data` (db.json + uploads/, git 제외) |
| `TRUST_PROXY=1` | 리버스 프록시 **한 단** 뒤에서 X-Forwarded-For **마지막 값**으로 접속 IP 판별(레이트 리밋·신고자 구분). Fly.io는 프록시 한 단이라 `fly.toml`에 `1`로 들어 있다. 프록시 없이 직접 받을 때는 켜지 말 것(클라이언트가 IP를 위조할 수 있다) |
| `NODE_ENV=production` | **운영 모드**(컨테이너 이미지 기본값). 아래 사업자 정보 필수 값이 비거나 형식이 틀리면, `FREE_MODE`·`DEV_DEPOSIT`이 켜져 있으면, `ADMIN_TOKEN`이 32자 미만이면, 모의 결제(`mock`)면 서버가 시작을 거부한다 |
| `PORT` | 기본 `5173` (컨테이너는 `8080`) |
| `BIZ_NAME` · `BIZ_OWNER` · `BIZ_REG_NO` · `BIZ_ADDRESS` · `BIZ_PHONE` · `BIZ_EMAIL` · `HOSTING_PROVIDER` | 사업자 정보(법정 표시) — 운영 모드 필수. `BIZ_REG_NO`는 000-00-00000, `BIZ_EMAIL`은 메일 형식 |
| `BIZ_MAIL_ORDER_NO` | 통신판매업 신고번호 — 운영 모드에서도 선택(PG 구매안전서비스 확인증 뒤에 신고하므로). 비면 화면에 "신고 준비 중" |

### 운영 모드와 사업자 정보(법정 표시)
- 운영 모드 = `NODE_ENV=production` 하나로 정한다. 이 값이 없으면(로컬·`start-test.cmd`) 사업자 정보가 비어도 서버가 뜨고 화면에 "사업자 정보 준비 중"이 나온다.
- 서버는 `GET /api/business`로 값을 내주고(`ready` = 필수 값이 다 있음), `bizinfo.js`가 시작 화면·광고 신청서·`terms.html`·`privacy.html` 하단에 **textContent로만** 채운다.
- 서버가 없는 Vercel 정적 미리보기에서는 요청이 실패하므로 HTML에 적힌 "사업자 정보 준비 중"이 그대로 보인다.
- 실제 값은 코드·장부에 적지 않고 호스팅의 비밀 환경변수로만 넣는다.

### 결제 — 토스페이먼츠 가상계좌 (`PAYMENT_PROVIDER=toss`)
- 주문 → 서버가 `POST /v1/virtual-accounts`로 가상계좌를 받는다(유효 24시간, 멱등 키 `va-{orderId}`). 발급 실패 시 주문을 남기지 않는다.
- 응답의 `secret`(웹훅 검증값)·`paymentKey`는 주문에만 저장하고 **공개 API로 내보내지 않는다**(`data/db.json`·백업에는 들어 있으니 데이터 폴더를 공개하지 말 것).
- 입금 웹훅(`DEPOSIT_CALLBACK`) 처리 순서 — 웹훅 본문만 믿지 않는다:
  1. 본문 `orderId`로 저장된 `secret`을 찾는다 → 없으면 401(우리 주문 아님)
  2. 본문 `secret`과 비교 → 다르면 401(위조)
  3. `GET /v1/payments/orders/{orderId}`로 상태·금액을 다시 받는다 → 조회 상태가 `DONE`이고 금액이 주문과 같을 때만 반영(다르면 400, 반영 안 함)
  4. 같은 웹훅이 다시 와도 이미 반영된 주문은 그대로 200(멱등) — 토스는 200을 못 받으면 최대 7회 재전송한다
  5. 결제 조회가 안 되면(토스 장애) 503 → 토스 재전송 때 다시 확인
- 토스 개발자센터 웹훅에는 **`DEPOSIT_CALLBACK`만** 등록한다(`PAYMENT_STATUS_CHANGED`까지 등록하면 같은 입금에 두 번 오고, 그쪽 형식은 검증값이 없어 401로 거부된다).
- `PAYMENT_PROVIDER=toss`면 `DEV_DEPOSIT=1`이어도 모의 입금 엔드포인트는 꺼진다.
- 근거 문서: [가상계좌 발급](https://docs.tosspayments.com/reference#가상계좌-발급-요청) · [orderId로 결제 조회](https://docs.tosspayments.com/reference#orderid로-결제-조회) · [웹훅 이벤트](https://docs.tosspayments.com/reference/using-api/webhook-events#deposit_callback) · [웹훅 재전송](https://docs.tosspayments.com/guides/v2/webhook) · [인증](https://docs.tosspayments.com/reference/using-api/authorization) · [은행 코드](https://docs.tosspayments.com/codes/org-codes)
- 단위 테스트(`server/payments-toss.test.js`, `server/app-toss.test.js`)는 문서 샘플 형식의 가짜 응답으로만 돈다 — 실제 네트워크 호출 없음.

#### 실제 연결 확인 절차 (사람이 — PG 계약·테스트 키 발급 뒤)
1. [토스페이먼츠 개발자센터](https://developers.tosspayments.com) → API 키에서 **테스트 시크릿 키**(`test_sk_…`)를 복사한다. 클라이언트 키(`test_ck_…`)가 아니다.
2. 개발자센터 → 웹훅 → 엔드포인트 `https://{배포 주소}/api/payments/webhook`, 이벤트 **`DEPOSIT_CALLBACK`** 등록. (로컬이면 외부에서 닿는 터널 주소 필요)
3. 서버 실행: `PAYMENT_PROVIDER=toss TOSS_SECRET_KEY=test_sk_… ADMIN_TOKEN=… node server/index.js` → 로그에 `결제=toss` 확인
4. 사이트에서 저격 광고 1칸 주문 → 화면에 우리은행(또는 `TOSS_VA_BANK`) 계좌번호가 나오는지, 개발자센터 결제 내역에 같은 주문번호가 `WAITING_FOR_DEPOSIT`으로 보이는지 확인
5. 테스트 모드에서 같은 금액을 입금 처리한다(테스트 가상계좌 입금 방법은 개발자센터·문서 안내를 따른다 — 이 저장소에서 확인하지 못한 부분) → 서버 로그에 경고 없이 주문이 `active`(이미지 광고면 `pending_review`)가 되는지 확인
6. 위조 확인: `curl -X POST https://{배포 주소}/api/payments/webhook -H 'content-type: application/json' -d '{"orderId":"{주문번호}","secret":"wrong","status":"DONE"}'` → 401
7. 개발자센터 웹훅 전송 기록에서 같은 이벤트 **재전송** → 200이 오고 장부 칸 수가 늘지 않는지(멱등) 확인
8. 운영 키(`live_sk_…`)로 바꿀 때는 `NODE_ENV=production`과 함께 넣고, 첫 실결제는 소액으로 한 번 더 4~5를 확인한다

## 배포 — 컨테이너·Fly.io (계획서 Step 4)
파일 저장소(볼륨 위 `db.json` 하나)라 **단일 인스턴스 전용**이다. 머신을 2대 이상 띄우면 장부가 갈라진다 — 수평 확장 금지.

| 파일 | 내용 |
|---|---|
| `Dockerfile` | `node:20-alpine`, 의존성 설치 없음, 코드는 root 소유(읽기 전용), `DATA_DIR=/data`, 포트 8080, 기본 `NODE_ENV=production` |
| `server/container-entry.js` | 컨테이너 진입점 — root로 시작했으면 `/data` 주인만 node(uid 1000)로 바꾸고 **즉시 권한을 내려놓은 뒤** 서버를 띄운다(Fly 새 볼륨은 root 소유라서). 서버 코드는 root로 돌지 않는다 |
| `.dockerignore` | 테스트(`*.test.js`)·`data/`·`docs/`·`start-test.cmd`·배포 설정 파일 제외 |
| `fly.toml` | 앱 이름 placeholder(`ad-dodge-CHANGE-ME`), 볼륨 `/data`, 내부 포트 8080, `force_https`, 헬스체크 `GET /api/health`, 머신 1대 고정(자동 정지 끔), `TRUST_PROXY=1` |

- **헬스체크** `GET /api/health` — 장부(`db.json`)를 실제로 읽고 JSON으로 풀 수 있으면 `200 {"ok":true}`, 못 읽으면(깨짐·볼륨 없음) `503 {"ok":false}`. 장부가 아직 없으면(첫 주문 전) 데이터 폴더 접근만 본다. 응답에 경로·비밀값 없음, 원인은 서버 로그 `[health]`에만. 인증 없이 열려 있고 매번 장부를 읽으므로 IP별 분당 30회 리밋(넘으면 429) — fly 탐침(15초 간격, 분당 4회)에는 넉넉하다.
- **종료** — SIGTERM(배포·재시작)·SIGINT를 받으면 모아 두던 놀이 기록(lazy 쓰기)을 디스크에 쓰고 코드 0으로 끝난다(`server/shutdown.js`). `fly.toml`의 `kill_signal`·`kill_timeout` 참고.

### 컨테이너 로컬 확인 (podman — docker도 같은 명령)
```bash
cd apps/ad-dodge
podman build -t ad-dodge .
# 로컬 모드(운영 모드 끔, 모의 결제). FREE_MODE·DEV_DEPOSIT 은 127.0.0.1 에만 열려서 컨테이너 밖에서 안 보인다 — 쓰지 말 것
podman run -d --name ad-dodge-local -p 5180:8080   -e NODE_ENV=development -e ADMIN_TOKEN=local-admin-token-1234 -e WEBHOOK_SECRET=local-webhook-secret-1234 ad-dodge
curl -i http://127.0.0.1:5180/api/health      # 200 {"ok":true}
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5180/   # 200
podman stop ad-dodge-local                     # SIGTERM → 로그에 "장부를 디스크에 쓰고 종료합니다", 종료 코드 0
podman rm -f ad-dodge-local && podman rmi ad-dodge
```
Windows의 podman(WSL)에서 `127.0.0.1:5180`이 빈 응답이면 포트 중계(wslrelay) 문제다 — `podman machine ssh "ip -4 addr show eth0"`로 VM IP를 얻어 `http://{VM IP}:5180`으로 확인한다.

### Fly.io 배포 절차 (사람이 — 계정·결제 수단 필요)
1. `fly auth login` → `fly.toml`의 `app` 이름을 정해 바꾸고 `fly apps create {이름}`
2. 볼륨 하나: `fly volumes create ad_dodge_data --region nrt --size 1` (머신 1대 = 볼륨 1개)
3. 비밀값은 `fly secrets set`으로만(파일·코드에 적지 않는다):
   `fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32) TOSS_SECRET_KEY=live_sk_… BIZ_NAME=… BIZ_OWNER=… BIZ_REG_NO=… BIZ_ADDRESS=… BIZ_PHONE=… BIZ_EMAIL=…`
   (선택) `BIZ_MAIL_ORDER_NO`, `TOSS_VA_BANK`, `MODERATION_MODE=vision` + `GOOGLE_VISION_API_KEY`
4. `fly deploy` → `fly logs`에서 `운영모드=켜짐, 결제=toss` 확인. 설정이 빠졌으면 `[config] …` 줄을 남기고 시작을 거부한다
5. `fly scale count 1` 로 1대 고정 확인(`fly status`). 절대 2대 이상으로 늘리지 않는다
6. `https://{이름}.fly.dev/api/health` → 200, `http://`로 열면 https로 넘어가는지 확인
7. 토스 개발자센터 웹훅 주소를 `https://{도메인}/api/payments/webhook`으로 등록(위 결제 절차)
8. 백업: 볼륨 안 `/data/backups/`에 1시간마다 쌓인다. 볼륨 스냅샷(`fly volumes snapshots list`)도 켜져 있는지 확인. 복구는 `fly ssh console`로 `/data/db.json`을 백업본으로 바꾸고 `fly machine restart`

## Vercel (정적 미리보기)
Vercel은 서버리스라 `server/`(장부 파일·업로드·SSE)가 돌지 않는다. 올리면 **게임만** 동작하고(관리사무소 광고만 날아옴),
광고 구매는 "게시판 공사 중"으로 꺼진다. 실서비스는 영구 디스크가 있는 Node 호스팅(계획서 Step 4: Fly.io)에서.
- 프레임워크 프리셋: Other · 빌드 명령 없음 · 출력 디렉터리: 루트
- `.vercelignore`로 서버 코드·테스트는 배포에서 뺀다, `vercel.json`이 서버와 같은 보안 헤더를 붙인다
- 배포 준비 계획: `docs/launch-plan.md`

## 구조
| 파일 | 역할 |
|---|---|
| `shares.js` | 지분·가중 추첨·보스·저격 추첨기 (순수, 서버와 공유) |
| `game.js` | 시뮬레이션: 스폰·이동·충돌·난이도·보스 (순수) |
| `paper.js` | 질감 도구: 뜯긴 가장자리·복사기 로고 처리·토너·코르크·테이프·매직 동그라미·졸라맨 |
| `render.js` / `input.js` | 캔버스 그리기(쪽지 캐시) / 상대 드래그·방향키 |
| `deathcard.js` | 사망 카드(저격 문구 포함) 1080×1920 + 공유 |
| `api.js` / `buy.js` | 서버 API·SSE / 구매 화면(가상계좌·폴링·저격 링크) |
| `app.js` | 화면 전환·루프·실시간 배너·킬 순위·신고 배선 |
| `admin.html` / `terms.html` / `privacy.html` | 관리자 검수 / 약관 초안 / 개인정보처리방침 초안 |
| `bizinfo.js` | 하단 사업자 정보 표시(`/api/business` → textContent, 서버 없으면 "준비 중") |
| `server/orders.js` | 주문 상태기계: 입금 대기 → (검수) → 출연 / 가림 / 환불 필요 |
| `server/payments.js` | PG 인터페이스 + **모의 PG** (가상계좌·HMAC 서명 웹훅) + 제공자 선택(`PAYMENT_PROVIDER`) |
| `server/payments-toss.js` | **토스페이먼츠 가상계좌** provider (발급·웹훅 secret 검증·결제 조회 재확인) |
| `server/moderation.js` | 이름 필터·이미지 형식 검증 + 분류기 인터페이스 |
| `server/moderation-vision.js` | Google Vision 이미지 검수 분류기(SafeSearch + 얼굴 감지, 실패 시 검토) |
| `server/app.js` | HTTP 라우팅·레이트 리밋·관리자 인증·정적 파일(허용 목록) |
| `server/stats.js` | 판 기록·오늘 백분위·도전장·광고 성과·킬 순위(위조 가능한 값이라 범위·상한으로 묶음) |
| `server/backup.js` | 장부 주기 백업 |
| `server/business.js` | 사업자 정보 환경변수 읽기·운영 모드 시작 점검(관리자 토큰 32자·모의 결제 금지 포함) |
| `server/health.js` | 헬스체크(`/api/health`) — 장부 읽기 가능 여부 |
| `server/shutdown.js` | SIGTERM·SIGINT → lazy 쓰기 flush 후 종료 |
| `server/container-entry.js` | 컨테이너 진입점 — 볼륨 주인 넘기고 비root로 강등 |
| `sound.js` | 종이 소리 합성·음소거 |

## 실제 운영 전에 바꿀 것
1. **실제 PG 연결 확인** — 토스페이먼츠 provider는 구현됨(`PAYMENT_PROVIDER=toss`). PG 계약·키 발급 후 위 "실제 연결 확인 절차"대로 확인. 환불(취소)은 아직 관리자 수동
2. **이미지 자동 필터** — 외부 AI 필터 키로 `classify()` 구현(선정성·폭력·얼굴). 없으면 관리자 수동 승인
3. 사업자 정보 환경변수(`BIZ_*`·`HOSTING_PROVIDER`)를 호스팅 비밀값으로 넣고 `NODE_ENV=production`으로 띄우기. `privacy.html`의 PG사 이름 채우기
4. 호스팅 — 파일 저장소를 쓰므로 영구 디스크가 있는 단일 Node 인스턴스 (서버리스 불가). 구성은 끝남(`Dockerfile`·`fly.toml`) — 위 "Fly.io 배포 절차"대로 사람이 계정을 만들어 배포

## 난이도 튜닝
`game.js` 상단 상수. 0~40초는 빠르게 오르고, 이후 "연장전"에서 속도·등장 간격·동시 개수가 천천히 계속 올라 상한(SPEED_CAP·SPAWN_INTERVAL_FLOOR·MAX_PROJECTILES_CAP)에서 멈춘다.
광고는 플레이어 쪽으로 1초에 최대 `homingAt(t)`만큼 꺾이고(14°/s → 49°/s), 플레이어를 지나치면 더 꺾지 않는다(유도 미사일 아님).
바꾼 뒤 `node --test`의 봇 생존시간 테스트가 회귀를 잡는다. 현재: 가만히 약 2.6초, 단순 회피 봇 중앙값 약 21초(상위 10% 약 40초).
