# 이건 광고입니다 (ad-dodge)

디자인 방향: **게시판 복사 전단** — 코르크 게시판에 테이프·압정·스테이플로 붙인 복사지. 광고는 윗변이 뜯긴 쪽지,
로고는 복사기로 뽑은 흑백(관리자 검수 화면만 원본 색), 플레이어는 매직 졸라맨, 사망 카드는 "목숨 찾습니다" 분실 공고.
색 5개·글꼴 4역할·자간·기울기 규칙은 `style.css` 머리 주석, 질감 도구는 `paper.js`.

날아오는 광고주 로고를 피하는 모바일 웹 게임. 광고를 숨기지 않고 **게임의 적 그 자체**로 판다.

- PRD: `~/.claude/prds/ad-dodge-game.prd.md` · M1 계획: `~/.claude/plans/ad-dodge-game.plan.md`
- 주차 기록: [`weeks/w13-ad-dodge`](../../weeks/w13-ad-dodge/) · 배포 준비 계획: [docs/launch-plan.md](docs/launch-plan.md)

## 운영 문서 — 여기부터 읽을 것
| 문서 | 언제 |
|---|---|
| 이 README "환경변수"·"배포 — Fly.io"·"백업과 복구" | 처음 배포할 때, 장부를 되돌릴 때 |
| [운영 매뉴얼 docs/operations.md](docs/operations.md) | 매일 — 검수·신고·환불 처리, 장애 대응, 관리자 토큰 교체 |
| [런칭 체크리스트 docs/launch-checklist.md](docs/launch-checklist.md) | 런칭 당일 — 사람 몫 H1~H8 와 기술 점검(미완료 □ 가 한눈에) |
| [실기기 체크리스트 docs/device-checklist.md](docs/device-checklist.md) | 배포 뒤 폰으로 확인할 때 |

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
- **자동 백업**: 서버가 1시간마다 `data/backups/`에 장부 사본(48개 = 이틀치). 외부 백업(선택)을 켜면 같은 파일을 S3 호환 저장소에도 올린다
- **환불 완료 기록**: 관리자 "환불 필요" 목록에서 주문별로 "환불 완료 처리"(처리 일시·메모). 환불 필요 → 환불 완료만 되고 되돌릴 수 없다.
  실제 돈은 운영자가 직접 이체한 뒤 기록만 한다(PG 환불 API 는 부르지 않는다). "환불 완료" 탭에서 기록을 본다
- **CSV 내보내기**: 관리자 화면 "이 목록 CSV로 내려받기" — 지금 탭의 주문(주문번호 앞 8자리·광고 이름·종류·칸·금액·상태·생성/입금/환불 일시·환불 메모).
  엑셀용 UTF-8 BOM·CRLF, `=`·`+`·`-`·`@`로 시작하는 셀은 앞에 `'`(CSV 인젝션 방지). 결제 secret·paymentKey 는 들어가지 않는다
- **최근 문제**: 서버 500 오류·웹훅 검증 실패·PG 장애·백업 실패·관리자 토큰 실패 반복 차단·감사 기록 실패 최근 50건을 관리자 화면 맨 위에 보여준다(메모리 — 재시작하면 비워짐).
  요청 본문·쿼리는 남기지 않고, 설명 안의 비밀값(관리자 토큰·웹훅 비밀값·토스 키·S3 키·긴 주문번호)은 가린다. 종류별 조치는 [운영 매뉴얼](docs/operations.md#장애-대응)
- **관리 기록(감사 로그)**: 승인·거절·가림·복구·수정·환불 완료·CSV 내보내기를 누가(가린 IP + 토큰 지문)·언제·무엇(주문번호 앞 8자리)으로 장부에 남긴다(최근 2,000건)

## 실행 (로컬)
의존성 0 (npm·번들러 없음). Node 20+ (브라우저 E2E 만 Node 22+).

```bash
cd apps/ad-dodge
node --test                      # 전체 테스트 (게임 + 서버 통합 + 문서 정합성)
node e2e/run.js                  # 브라우저 E2E (헤드리스 Chrome/Edge — 아래 "E2E·실기기 확인")

# 기능 테스트(결제 없이 바로 추가): start-test.cmd 더블클릭 → http://127.0.0.1:5173

# 로컬 서버 (모의 PG 입금 버튼 켬) — 아래 토큰·비밀값은 로컬 전용 예시. 운영 모드에서는 시작이 거부된다
ADMIN_TOKEN=local-admin-token-1234 WEBHOOK_SECRET=local-webhook-secret-1234 DEV_DEPOSIT=1 node server/index.js
#  게임     http://localhost:5173
#  관리자   http://localhost:5173/admin.html  (토큰 = ADMIN_TOKEN)
```

서버 없이 `python -m http.server`로 열어도 하우스 광고로 게임만 돈다(구매 버튼 비활성).
`node --test` 의 `launch-docs.test.js` 는 아래 환경변수 표가 코드가 읽는 이름과 1:1 인지, 운영 문서·링크가 있는지 본다 — 코드에 환경변수를 더하면 표도 같이 고칠 것.

### E2E·실기기 확인 (계획서 Step 7)
- **브라우저 E2E**: `node e2e/run.js` — 설치된 Chrome(없으면 Edge)을 `--headless=new`로 띄우고 Node 내장 WebSocket(**Node 22+**)으로
  DevTools 프로토콜을 직접 다룬다(`e2e/cdp.js`, npm 패키지 없음). 다른 경로의 브라우저는 `E2E_BROWSER=실행 파일 경로`.
  - 흐름(`e2e/flow.e2e.js`): 시작 → 플레이(방향키·드래그 입력 주입) → 사망 → 사망 카드 생성·저장 → 도전장 만들기·링크 열기 →
    광고 붙이기(테스트 모드 무료, 로고 업로드) → 출연(장부 100%·게시판) → 내 광고에 맞아 사망 → 신고 → 관리자 화면에서 떼어 내기 →
    게임 게시판·장부에서 사라짐 → 이동 주소 광고에 맞으면 그 주소로 즉시 이동 → 관리자 화면(환불 완료 폼·CSV 내려받기·최근 문제·관리 기록) → 콘솔 오류 0
  - 서버는 운영체제 임시 폴더의 data·`FREE_MODE=1`·`MODERATION_MODE=auto-approve`·임의 포트로 자식 프로세스로 띄우고, 끝나면 브라우저·서버·임시 폴더를 정리한다.
    저장소 `data/`는 건드리지 않는다(실행 전후 지문 비교 출력). 부모 셸의 운영 환경변수(`NODE_ENV`·`TOSS_*`·`BIZ_*` 등)는 자식 서버에 넘기지 않는다(`e2e/harness.js`).
  - 브라우저는 127.0.0.1 밖 주소를 풀지 않는다. 테스트 광고 이동 주소는 가짜 도메인 `ad-landing.test` → 127.0.0.1 로 돌려서 외부로 나가지 않는다
    (게시판 글꼴 Google Fonts 도 막히므로 그 네트워크 실패만 콘솔 오류에서 뺀다). 게임 코드에 테스트 훅은 없다.
  - 종료 코드: **0 통과 / 1 실패 / 2 건너뜀**(브라우저를 못 찾음·Node 22 미만 — 안내 문구 출력). 기본 `node --test`에는 섞이지 않는다
    (느리고 브라우저 필요). `e2e/e2e-support.test.js`(브라우저 없이 도는 도구 단위 테스트)만 `node --test`에 들어간다.
- **실기기 수동 확인**: [실기기 체크리스트](docs/device-checklist.md) — 인스타그램 인앱(iOS·안드로이드)·iOS 사파리·안드로이드 크롬별
  터치·멀티터치, 소리 아이콘(무음 모드), 사망 카드 저장/공유(인앱 다운로드 제약), 광고 URL 이동, 가상계좌 화면, 가로/세로·노치 안전 영역, 저사양 프레임.
  실기기는 루프백 전용 테스트 모드에 닿지 않으므로 배포 주소(토스 테스트 키)로 사람이 확인한다.

## 환경변수
코드(`server/index.js`·`server/business.js`·`server/payments.js`·`server/moderation.js`·`server/sigv4.js`·`server/container-entry.js`·`e2e/cdp.js`)가 읽는 이름 전부다.
**실제 값은 이 문서·코드·장부에 적지 않는다** — 운영 값은 `fly secrets set` 으로만 넣고, 비밀이 아닌 고정값은 `fly.toml [env]` 에 있다.
"필수" 칸: **운영** = `NODE_ENV=production` 에서 없으면(또는 틀리면) 서버가 시작을 거부 / **조건** = 괄호 안 조건일 때 필수 / **선택** = 없어도 뜬다 / **금지** = 운영 모드에서 켜면 시작 거부.

| 이름 | 필수 | 운영 값 예시(형식) | 설명 |
|---|---|---|---|
| `NODE_ENV` | 운영 | `production` (`fly.toml`·컨테이너 기본값) | **운영 모드** 스위치. 켜지면 사업자 정보 필수 값, 관리자 토큰 강도, `toss` 결제, `FREE_MODE`·`DEV_DEPOSIT`·`auto-approve` 금지를 시작 전에 점검하고 하나라도 틀리면 `[config] …` 줄을 남기고 시작을 거부한다. 로컬 컨테이너 확인은 `development` |
| `ADMIN_TOKEN` | 필수(늘) | `openssl rand -hex 32` 출력(hex 64자) | 관리자 토큰. 늘 16자+, **운영 모드는 32자+ · 서로 다른 문자 10종+ · 로컬 기본값·자리표시 낱말(`local-admin-token`·`changeme` 등) 금지**. 관리자 경로는 IP별 분당 120회, 토큰 실패 5분 10회 초과 시 15분 429. 교체는 [운영 매뉴얼](docs/operations.md#관리자-토큰-교체) |
| `SALES_OPEN` | 선택 | `0` (`fly.toml`, 접수 열 때 `1`) | `0` 이면 광고 접수 준비 중 — 주문·칸 추가·결제 웹훅을 503 으로 닫고 게임만 연다. 이때는 사업자 정보(`BIZ_*`)·결제 키 없이도 운영 모드로 뜬다. 기본 `1`(접수 열림) |
| `PAYMENT_PROVIDER` | 운영(`toss`) | `toss` (`fly.toml`) | `mock`(기본, 모의 PG) / `toss`(토스페이먼츠 가상계좌). 다른 값이면 시작 거부. **운영 모드에서 `mock`(또는 비움)이면 시작 거부** |
| `TOSS_SECRET_KEY` | 조건(`toss`) | `live_sk_…` (테스트는 `test_sk_…`) | 토스페이먼츠 **시크릿 키**. 클라이언트 키(`…_ck_…`)가 아니다. 없거나 형식이 틀리면 시작 거부. `test_sk_` 면 시작 로그에 "실제 돈은 오가지 않습니다" 경고 |
| `TOSS_VA_BANK` | 선택 | `20` (2자리 은행 코드) | 가상계좌 은행 코드(기본 `20` 우리은행). 발급 가능: 03·06·07·11·20·31·32·34·37·39·71·81·88. 목록 밖이면 시작 거부 |
| `WEBHOOK_SECRET` | 조건(`mock`) | 로컬만 — 16자+ 아무 문자열 | 모의 PG 웹훅 HMAC 서명 비밀값. `PAYMENT_PROVIDER=mock`(로컬)일 때만 읽고 필수. 운영(`toss`)에서는 쓰지 않는다 — 토스 웹훅은 주문마다 받은 `secret` 으로 검증 |
| `MODERATION_MODE` | 선택 | `review-all` 또는 `vision` | 이미지 검수 방식. `review-all`(기본: 이미지·이동 주소 광고는 관리자 승인) / `vision`(Google Vision SafeSearch·얼굴 감지) / `auto-approve`(로컬 데모 — **운영 모드 금지**). 차이는 [운영 매뉴얼](docs/operations.md#검수) |
| `GOOGLE_VISION_API_KEY` | 조건(`vision`) | Google Cloud API 키(`AIza…`) | `MODERATION_MODE=vision` 일 때 필수(없으면 시작 거부). 헤더로만 보내고 로그에 찍지 않는다. Vision API 만 허용하도록 키 제한 권장 |
| `FREE_MODE` | 금지 | 운영에서는 넣지 않는다(로컬 `1`) | 테스트 모드 — 결제 없이 주문 즉시 출연. 켜면 127.0.0.1 에만 열린다. `start-test.cmd`·E2E 전용 |
| `DEV_DEPOSIT` | 금지 | 운영에서는 넣지 않는다(로컬 `1`) | 모의 입금 버튼·엔드포인트(`mock` 일 때만). 켜면 127.0.0.1 에만 열린다. **운영에서 켜면 공짜 광고가 된다** |
| `HOST` | 선택 | `0.0.0.0` (`fly.toml`) | 듣는 주소(기본 `0.0.0.0`). `FREE_MODE`·`DEV_DEPOSIT` 이면 이 값과 상관없이 `127.0.0.1` |
| `PORT` | 선택 | `8080` (`fly.toml`·컨테이너) | 듣는 포트(로컬 기본 `5173`). `fly.toml` 의 `internal_port` 와 같아야 한다 |
| `DATA_DIR` | 선택 | `/data` (`fly.toml`·컨테이너) | 장부 `db.json`·`uploads/`·`backups/` 가 사는 폴더(로컬 기본 `./data`, git 제외). 운영은 반드시 영구 볼륨 경로 |
| `TRUST_PROXY` | 선택 | `1` (`fly.toml`) | `1` 이면 X-Forwarded-For **마지막 값**을 접속 IP 로 본다(레이트 리밋·신고자 구분·관리자 차단). Fly.io 는 프록시 한 단이라 `1`. 프록시 없이 직접 받을 때는 켜지 말 것(IP 위조 가능) |
| `BIZ_NAME` | 운영 | 상호(예: ○○상회) | 사업자 정보(법정 표시) — 시작 화면·신청서·약관·처리방침 하단에 textContent 로 표시 |
| `BIZ_OWNER` | 운영 | 대표자 이름 | 사업자 정보 |
| `BIZ_REG_NO` | 운영 | `000-00-00000` | 사업자등록번호 — 숫자 10자리(하이픈 허용), 아니면 시작 거부 |
| `BIZ_ADDRESS` | 운영 | 사업장 주소 | 사업자 정보 |
| `BIZ_PHONE` | 운영 | `010-0000-0000` 형식 | 사업자 정보(고객 문의 전화) |
| `BIZ_EMAIL` | 운영 | `name@example.com` 형식 | 사업자 정보 — 메일 형식이 아니면 시작 거부 |
| `BIZ_MAIL_ORDER_NO` | 선택 | `제0000-지역-0000호` | 통신판매업 신고번호 — PG 구매안전서비스 확인증 뒤에 신고하므로(H3 → H4) 운영 모드에서도 선택. 비면 화면에 "신고 준비 중" |
| `HOSTING_PROVIDER` | 운영 | `Fly.io` (`fly.toml`) | 호스팅 제공자 상호(법정 표시) |
| `BACKUP_S3_ENDPOINT` | 선택(다섯 묶음) | `https://<계정>.r2.cloudflarestorage.com` | **외부 백업** — 아래 다섯 값이 **모두** 있을 때만 켜진다(일부만 있으면 경고 후 꺼짐). `https://` 만 허용 |
| `BACKUP_S3_BUCKET` | 선택(다섯 묶음) | 버킷 이름 | 백업이 `{ENDPOINT}/{BUCKET}/ad-dodge/db-YYYYMMDD-HHMM.json` 에 PUT(SigV4) 된다. 버킷은 **비공개**(백업에 결제 검증값이 들어 있다) |
| `BACKUP_S3_ACCESS_KEY` | 선택(다섯 묶음) | 그 버킷 쓰기 전용 키 ID | 외부 백업 액세스 키 ID |
| `BACKUP_S3_SECRET_KEY` | 선택(다섯 묶음) | 시크릿 액세스 키 | 외부 백업 시크릿 키 — 오류 문구에서 가려진다 |
| `BACKUP_S3_REGION` | 선택(다섯 묶음) | `auto`(R2) / `ap-northeast-2`(AWS 서울) | SigV4 서명 리전 |
| `E2E_BROWSER` | 선택(E2E 전용) | 브라우저 실행 파일 경로 | `node e2e/run.js` 가 쓸 Chrome/Edge 경로. 운영 서버는 읽지 않는다 |

### 운영 모드와 사업자 정보(법정 표시)
- 운영 모드 = `NODE_ENV=production` 하나로 정한다. 이 값이 없으면(로컬·`start-test.cmd`) 사업자 정보가 비어도 서버가 뜨고 화면에 "사업자 정보 준비 중"이 나온다.
- 서버는 `GET /api/business`로 값을 내주고(`ready` = 필수 값이 다 있음), `bizinfo.js`가 시작 화면·광고 신청서·`terms.html`·`privacy.html` 하단에 **textContent로만** 채운다.
- 서버가 없는 Vercel 정적 미리보기에서는 요청이 실패하므로 HTML에 적힌 "사업자 정보 준비 중"이 그대로 보인다.

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
3. 배포 서버에 테스트 키를 넣는다: `fly secrets set TOSS_SECRET_KEY=test_sk_…` → `fly logs` 에서 `결제=toss` 와 테스트 키 경고 확인
4. 사이트에서 저격 광고 1칸 주문 → 화면에 우리은행(또는 `TOSS_VA_BANK`) 계좌번호가 나오는지, 개발자센터 결제 내역에 같은 주문번호가 `WAITING_FOR_DEPOSIT`으로 보이는지 확인
5. 테스트 모드에서 같은 금액을 입금 처리한다(테스트 가상계좌 입금 방법은 개발자센터·문서 안내를 따른다 — 이 저장소에서 확인하지 못한 부분) → 서버 로그에 경고 없이 주문이 `active`(이미지 광고면 `pending_review`)가 되는지 확인
6. 위조 확인: `curl -X POST https://{배포 주소}/api/payments/webhook -H 'content-type: application/json' -d '{"orderId":"{주문번호}","secret":"wrong","status":"DONE"}'` → 401
7. 개발자센터 웹훅 전송 기록에서 같은 이벤트 **재전송** → 200이 오고 장부 칸 수가 늘지 않는지(멱등) 확인
8. 운영 키(`live_sk_…`)로 바꿀 때는 `fly secrets set TOSS_SECRET_KEY=live_sk_…` 로 교체하고, 첫 실결제는 소액으로 한 번 더 4~5를 확인한다

## 배포 — Fly.io
파일 저장소(볼륨 위 `db.json` 하나)라 **단일 인스턴스 전용**이다. 머신을 2대 이상 띄우면 장부가 갈라진다 — 수평 확장 금지.
아래 명령은 Fly.io 공식 문서(flyctl) 형식대로 적었다. **실제 계정에서는 아직 돌려 보지 않았다**(계정이 사람 몫 H7) — 첫 배포 때 출력이 다르면 이 절을 고칠 것.

| 파일 | 내용 |
|---|---|
| `Dockerfile` | `node:20-alpine`, 의존성 설치 없음, 코드는 root 소유(읽기 전용), `DATA_DIR=/data`, 포트 8080, 기본 `NODE_ENV=production`, `CMD ["node", "server/container-entry.js"]` |
| `server/container-entry.js` | 컨테이너 진입점 — root로 시작했으면 `/data` 주인만 node(uid 1000)로 바꾸고 **즉시 권한을 내려놓은 뒤** 서버를 띄운다(Fly 새 볼륨은 root 소유라서). 서버 코드는 root로 돌지 않는다 |
| `.dockerignore` | 테스트(`*.test.js`)·`data/`·`docs/`·`e2e/`·`start-test.cmd`·배포 설정 파일 제외 |
| `fly.toml` | 앱 이름 `adsgame`, 리전 `nrt`, 볼륨 `ad_dodge_data` → `/data`, 내부 포트 8080, `force_https`, 헬스체크 `GET /api/health`, 머신 1대(자동 정지 끔), 비밀 아닌 `[env]`(`NODE_ENV`·`PORT`·`HOST`·`DATA_DIR`·`TRUST_PROXY`·`PAYMENT_PROVIDER`·`SALES_OPEN`·`HOSTING_PROVIDER`) |

### 처음 배포 (사람이 — 계정·결제 수단 필요)
`apps/ad-dodge` 폴더에서 한다. `{앱}` = 정한 앱 이름, `{도메인}` = 산 도메인(H2).
1. 로그인·앱 만들기: `fly auth login` → (다른 이름을 쓰려면 `fly.toml` 의 `app = "adsgame"` 을 바꾸고) `fly apps create {앱}`
2. 볼륨 하나(머신 1대 = 볼륨 1개): `fly volumes create ad_dodge_data --region nrt --size 1` → `fly volumes list` 로 하나뿐인지 확인
3. 비밀값은 `fly secrets set` 으로만 넣는다(파일·코드·셸 기록에 남기지 않게 — 토큰은 바로 비밀번호 관리자에 보관):
   ```bash
   fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32)
   fly secrets set TOSS_SECRET_KEY=live_sk_…            # 처음엔 test_sk_… 로 연결 확인(위 "실제 연결 확인 절차")
   fly secrets set BIZ_NAME=… BIZ_OWNER=… BIZ_REG_NO=000-00-00000 BIZ_ADDRESS=… BIZ_PHONE=… BIZ_EMAIL=…
   # 선택: BIZ_MAIL_ORDER_NO=…  TOSS_VA_BANK=20  MODERATION_MODE=vision GOOGLE_VISION_API_KEY=…
   # 선택(외부 백업): BACKUP_S3_ENDPOINT=https://… BACKUP_S3_BUCKET=… BACKUP_S3_ACCESS_KEY=… BACKUP_S3_SECRET_KEY=… BACKUP_S3_REGION=…
   fly secrets list                                      # 이름만 보인다(값은 안 보임) — 위 환경변수 표의 "운영" 칸이 다 있는지
   ```
   관리자 토큰은 `fly secrets set` 직후에 따로 볼 방법이 없다 — 위처럼 넣기 전에 `openssl rand -hex 32` 출력을 먼저 비밀번호 관리자에 적고 그 값을 넣는 편이 안전하다.
4. 배포: `fly deploy` → `fly logs` 에서 `[server] … (운영모드=켜짐, 테스트모드=꺼짐, 결제=toss, 모의입금=꺼짐, 검수=…, 외부백업=…)` 확인.
   설정이 빠졌으면 `[config] … 환경변수가 필요합니다` 줄을 남기고 시작을 거부한다 → 그 이름을 `fly secrets set` 하면 자동으로 다시 뜬다
5. 1대 확인: `fly status` (머신 1대). `fly scale count 1` 외의 숫자는 절대 쓰지 않는다
6. 헬스체크 확인(아래 "헬스체크") → `http://` 로 열면 `https://` 로 넘어가는지
7. 도메인: `fly certs add {도메인}` → 안내되는 DNS 레코드를 등록 → `fly certs show {도메인}` 에서 발급 확인
8. 토스 개발자센터 웹훅 주소를 `https://{도메인}/api/payments/webhook`(이벤트 `DEPOSIT_CALLBACK`)으로 등록
9. 런칭 당일 나머지는 [런칭 체크리스트](docs/launch-checklist.md)

### 다시 배포·로그·설정 바꾸기
- 코드 바꾼 뒤: `fly deploy` (볼륨은 그대로 붙는다. SIGTERM → 밀린 놀이 기록을 쓰고 종료 → 새 머신 시작)
- 로그: `fly logs` (실시간). 시작 줄 `[server]`, 설정 오류 `[config]`, 헬스 실패 원인 `[health]`, 백업 `[backup]`
- 비밀값 바꾸기: `fly secrets set 이름=값` — 넣으면 머신이 새 값으로 다시 뜬다. 지우기: `fly secrets unset 이름`
- 머신 재시작: `fly machine list` 로 id 확인 → `fly machine restart {머신 id}`

### 헬스체크
- `GET /api/health` — 장부(`db.json`)를 실제로 읽고 JSON으로 풀 수 있으면 `200 {"ok":true}`, 못 읽으면(깨짐·볼륨 없음) `503 {"ok":false}`. 장부가 아직 없으면(첫 주문 전) 데이터 폴더 접근만 본다.
- 확인: `curl -i https://{도메인}/api/health` → `HTTP/2 200` 과 `{"ok":true}`. fly 쪽 판정은 `fly checks list` 또는 `fly status`.
- 응답에 경로·비밀값 없음, 원인은 서버 로그 `[health]` 에만. 인증 없이 열려 있고 매번 장부를 읽으므로 IP별 분당 30회 리밋(넘으면 429) — fly 탐침(15초 간격, 분당 4회)에는 넉넉하다.
- **종료** — SIGTERM(배포·재시작)·SIGINT를 받으면 모아 두던 놀이 기록(lazy 쓰기)을 디스크에 쓰고 코드 0으로 끝난다(`server/shutdown.js`). `fly.toml`의 `kill_signal`·`kill_timeout` 참고.

### 백업과 복구
백업은 세 곳에 있다. **장부(`/data/db.json`)는 돈 기록이 든 유일한 파일**이라, 되돌리면 백업 시각 뒤의 주문·입금·관리 작업이 장부에서 사라진다(아래 "복구 뒤 맞춰 보기" 필수).

| 갈래 | 어디 | 주기·보관 | 언제 쓰나 |
|---|---|---|---|
| 로컬 `backups/` | 볼륨 안 `/data/backups/db-YYYYMMDD-HHMM.json`(UTC) | 1시간마다, 최근 48개(이틀) | 장부 내용만 잘못됐을 때(잘못된 관리 작업·깨진 파일) — 가장 빠름 |
| 볼륨 스냅샷 | Fly 가 볼륨 전체(장부·로고·백업)를 찍는다 | 하루 1번 자동, 기본 5일 보관 | 볼륨이 통째로 망가졌거나 지워졌을 때 |
| 외부 S3(선택) | `{버킷}/ad-dodge/db-YYYYMMDD-HHMM.json` | 로컬 백업과 같은 파일을 매시간 올림(지우지 않음 — 버킷 수명 규칙으로 정리) | 볼륨·스냅샷 모두 못 쓸 때, 이틀보다 오래된 시점이 필요할 때 |

- 확인: `fly ssh console -C "ls -l /data/backups"` · `fly volumes list` → `fly volumes snapshots list {볼륨 id}` · 외부는 버킷에서 `ad-dodge/` 목록
- 큰 작업 전 수동 스냅샷: `fly volumes snapshots create {볼륨 id}`

#### 복구 공통 — 서버를 멈추고 바꾼다
서버는 장부를 메모리에 들고 있다가 주문·관리 작업 때마다(그리고 종료 직전에) **메모리 내용으로 `db.json` 을 통째로 다시 쓴다**.
돌고 있는 서버 밑에서 파일만 바꾸면 다음 쓰기가 복구를 덮어 버린다. 그래서 머신을 "잠자기 명령"으로 바꿔 서버를 멈춘 채 파일을 바꾼다.
(장부가 깨져 서버가 아예 못 뜨는 경우에도 이 방법이면 볼륨에 들어갈 수 있다.)
```bash
fly machine list                                                     # {머신 id}
fly machine update {머신 id} --command "sleep 3600" --skip-health-checks -y   # 서버 대신 sleep — 이 동안 사이트는 503
```

#### 복구 1 — 로컬 `backups/` 에서
```bash
fly ssh console -C "ls -l /data/backups"                             # 되돌릴 시각 고르기(파일 이름은 UTC)
fly ssh console -C "cp /data/db.json /data/db.json.before-restore"   # 지금 장부 보관(깨졌어도 원인 확인용)
fly ssh console -C "cp /data/backups/db-YYYYMMDD-HHMM.json /data/db.json"
fly machine update {머신 id} --command "node server/container-entry.js" -y   # 원래 명령(Dockerfile CMD)으로 되돌림
fly logs                                                             # [server] 시작 줄 확인 → 아래 헬스체크
```

#### 복구 2 — 볼륨 스냅샷에서 (볼륨 통째로)
스냅샷은 새 볼륨으로만 되살릴 수 있다. 옛 머신을 먼저 멈춰 **두 대가 동시에 돌지 않게** 한다.
```bash
fly volumes list                                                     # 지금 볼륨 id (지워졌으면 fly volumes list --all — 지운 지 24시간 안)
fly volumes snapshots list {볼륨 id}                                 # 되돌릴 스냅샷 id
fly volumes create ad_dodge_data --snapshot-id {스냅샷 id} --region nrt --size 1   # 새 볼륨 id 가 나온다
fly machine stop {옛 머신 id}
fly machine clone {옛 머신 id} --region nrt --attach-volume {새 볼륨 id}:/data
fly status                                                           # 새 머신이 돌고 헬스체크 통과하는지 → 아래 헬스체크
fly machine destroy {옛 머신 id}                                     # 확인이 끝난 뒤에만
fly volumes destroy {옛 볼륨 id}                                     # 되돌릴 일이 없다고 확신한 뒤에만(지우면 복구 불가)
```

#### 복구 3 — 외부 S3 에서
1. 버킷 `ad-dodge/` 에서 되돌릴 파일(`db-YYYYMMDD-HHMM.json`)을 내 PC 로 내려받는다(저장소 웹 콘솔, 또는 `aws s3 cp s3://{버킷}/ad-dodge/db-….json . --endpoint-url {ENDPOINT}`)
2. JSON 이 맞는지 본다: `node -e "JSON.parse(require('fs').readFileSync('db-….json','utf8'))"` (오류 없으면 통과)
3. 위 "복구 공통"으로 서버를 멈추고, 파일을 볼륨에 올린다: `fly ssh sftp shell` → `put db-….json /data/db.json.restore` → 나가기
4. `fly ssh console -C "cp /data/db.json /data/db.json.before-restore"` → `fly ssh console -C "cp /data/db.json.restore /data/db.json"`
5. `fly machine update {머신 id} --command "node server/container-entry.js" -y` → `fly logs` → 헬스체크

#### 복구 뒤 맞춰 보기 (세 갈래 공통)
- `/api/health` 200, 관리자 화면이 열리고 "붙어 있음" 목록이 예상과 같은지
- **백업 시각 뒤에 들어온 입금**: 토스 개발자센터 결제 내역에서 백업 시각(UTC → KST +9시간) 이후 `DONE` 주문을 찾는다. 장부에서 사라진 주문은
  웹훅이 이미 200 을 받아 다시 오지 않는다 → 입금자에게 연락해 환불(사람이)하고 기록을 남긴다([운영 매뉴얼 — 환불](docs/operations.md#환불-처리))
- 업로드 로고(`/data/uploads/`)는 복구 1·3 에서 되돌리지 않는다(장부에 없는 파일은 쓰이지 않을 뿐 해가 없다)
- 확인이 끝나면 `/data/db.json.before-restore`·`/data/db.json.restore` 는 지워도 된다(`fly ssh console -C "rm /data/db.json.restore"`)

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

## Vercel (정적 미리보기)
Vercel은 서버리스라 `server/`(장부 파일·업로드·SSE)가 돌지 않는다. 올리면 **게임만** 동작하고(관리사무소 광고만 날아옴),
광고 구매는 "게시판 공사 중"으로 꺼진다. 실서비스는 위 Fly.io 에서.
- 프레임워크 프리셋: Other · 빌드 명령 없음 · 출력 디렉터리: 루트
- `.vercelignore`로 서버 코드·테스트는 배포에서 뺀다, `vercel.json`이 서버와 같은 보안 헤더를 붙인다

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
| `server/orders.js` | 주문 상태기계: 입금 대기 → (검수) → 출연 / 가림 / 환불 필요 → 환불 완료(기록) |
| `server/payments.js` | PG 인터페이스 + **모의 PG** (가상계좌·HMAC 서명 웹훅) + 제공자 선택(`PAYMENT_PROVIDER`) |
| `server/payments-toss.js` | **토스페이먼츠 가상계좌** provider (발급·웹훅 secret 검증·결제 조회 재확인) |
| `server/moderation.js` | 이름 필터·이미지 형식 검증 + 분류기 인터페이스(`MODERATION_MODE`) |
| `server/moderation-vision.js` | Google Vision 이미지 검수 분류기(SafeSearch + 얼굴 감지, 실패 시 검토) |
| `server/app.js` | HTTP 라우팅·레이트 리밋·관리자 인증·정적 파일(허용 목록) |
| `server/admin-guard.js` / `server/audit-log.js` | 관리자 경로 레이트 리밋·무차별 대입 차단 / 관리 기록(감사 로그) |
| `server/stats.js` | 판 기록·오늘 백분위·도전장·광고 성과·킬 순위(위조 가능한 값이라 범위·상한으로 묶음) |
| `server/store.js` | 장부 파일 저장소(통째 교체·원자적 쓰기·놀이 기록 모아 쓰기) |
| `server/backup.js` | 장부 주기 백업(+ 외부 업로드 선택, 실패는 "최근 문제"로) |
| `server/sigv4.js` | 외부 백업 — AWS SigV4 서명(내장 crypto)·S3 호환 PUT 업로더·`BACKUP_S3_*` 읽기 |
| `server/export-csv.js` | 주문 CSV(BOM·CRLF·이스케이프·CSV 인젝션 방지, 허용한 열만) |
| `server/error-log.js` | 최근 문제 링버퍼(50건, 비밀값 가림) |
| `server/business.js` | 사업자 정보 환경변수 읽기·운영 모드 시작 점검(관리자 토큰 강도·모의 결제 금지 포함) |
| `server/health.js` | 헬스체크(`/api/health`) — 장부 읽기 가능 여부 |
| `server/shutdown.js` | SIGTERM·SIGINT → lazy 쓰기 flush 후 종료 |
| `server/container-entry.js` | 컨테이너 진입점 — 볼륨 주인 넘기고 비root로 강등 |
| `sound.js` | 종이 소리 합성·음소거 |
| `e2e/run.js` · `e2e/flow.e2e.js` | 브라우저 E2E 실행기(임시 폴더·테스트 서버·헤드리스 브라우저 정리) · 핵심 흐름 시나리오 |
| `e2e/cdp.js` · `e2e/harness.js` | DevTools 프로토콜 드라이버(내장 WebSocket) · 테스트 서버 환경변수·임시 폴더·업로드용 PNG |
| `launch-docs.test.js` | 문서 정합성 — 환경변수 표 ↔ 코드, 배포·복구 명령, 운영 문서·체크리스트·링크, 비밀값 모양 문자열 없음 |
| `docs/operations.md` · `docs/launch-checklist.md` · `docs/device-checklist.md` | 운영 매뉴얼 · 런칭 당일 체크리스트 · 실기기 체크리스트 |

## 실제 운영 전에 남은 것
코드 쪽 준비(계획서 Step 1~8)는 끝났다. 남은 것은 전부 사람 몫이고 [런칭 체크리스트](docs/launch-checklist.md)에 □ 로 모아 두었다 —
사업자 등록·도메인·PG 계약·통신판매업 신고·게임 등급분류·Vision 키·Fly.io 계정·실기기 확인, 그리고 `privacy.html` 의 PG사 이름 채우기.

## 난이도 튜닝
`game.js` 상단 상수. 0~40초는 빠르게 오르고, 이후 "연장전"에서 속도·등장 간격·동시 개수가 천천히 계속 올라 상한(SPEED_CAP·SPAWN_INTERVAL_FLOOR·MAX_PROJECTILES_CAP)에서 멈춘다.
광고는 플레이어 쪽으로 1초에 최대 `homingAt(t)`만큼 꺾이고(14°/s → 49°/s), 플레이어를 지나치면 더 꺾지 않는다(유도 미사일 아님).
바꾼 뒤 `node --test`의 봇 생존시간 테스트가 회귀를 잡는다. 현재: 가만히 약 2.6초, 단순 회피 봇 중앙값 약 21초(상위 10% 약 40초).
