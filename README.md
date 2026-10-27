# 팀 출퇴근 기록 서버

Node.js + SQLite로 만든 출퇴근 기록 서버입니다. 외부 패키지가 없고, 데이터는 파일 하나(`data/attendance.db`)에 저장됩니다.

- 이메일 가입, 비밀번호 로그인 (비밀번호는 scrypt로 암호화해 저장)
- 출근·퇴근 시각은 **서버 시계**로 기록 (브라우저 시계는 사용하지 않음)
- 하루 1회 출근, 퇴근 누락 표시, 수정 요청·승인, 관리자 보정(이력 보관, 삭제 없음)
- 선택 기능: 지정한 사내망 IP에서만 기록 허용
- 팀 현황: 오늘 현황, 팀 캘린더(이름을 누르면 출퇴근 시각), 날짜별 비교표, 월별 요약, CSV 저장

## 실행

필요한 것: **Node.js 22.13 이상**

```bash
npm start            # http://localhost:3000
npm test             # 서버 시험 (34개 항목)
```

처음 실행하면 **가입 코드**가 서버 로그에 한 번 표시됩니다. 가장 먼저 가입한 사람이 관리자가 되고, 관리자는 '팀 현황'의 `가입 코드 보기`에서 코드를 다시 볼 수 있습니다. 팀원에게는 서버 주소와 가입 코드를 알려 주세요.

## 설정 (환경 변수)

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 포트 |
| `DB_PATH` | `./data/attendance.db` | 데이터베이스 파일 (백업 대상) |
| `SIGNUP_CODE` | 자동 생성 | 가입 코드를 직접 정할 때 |
| `COOKIE_SECURE` | 0 | HTTPS로 운영하면 `1` |
| `TRUST_PROXY` | 0 | nginx·Render·Fly 같은 프록시 뒤에서 운영하면 `1` |
| `ALLOWED_IPS` | 비움(제한 없음) | 기록을 허용할 접속 IP. 쉼표로 구분, IPv4 대역 지원. 예: `203.0.113.10,10.0.0.0/8` |
| `TEAM_SIZE` | 9 | 화면에 표시하는 팀 인원 |
| `MAX_USERS` | 30 | 가입 가능한 최대 인원 |

## 운영

1. **HTTPS 필수.** 비밀번호가 오가므로 반드시 HTTPS 주소로 접속하게 하세요. 서버를 직접 띄우면 nginx나 Caddy 뒤에 두고 `COOKIE_SECURE=1`, `TRUST_PROXY=1`을 설정합니다. Render, Fly.io, Railway 같은 서비스는 HTTPS를 기본 제공합니다.
2. **데이터 보관.** 호스팅 서비스에서는 `DB_PATH`를 영구 디스크(볼륨)에 두세요. 디스크가 없으면 재배포할 때 기록이 사라집니다.
3. **Docker:**
   ```bash
   docker build -t team-attendance .
   docker run -d -p 3000:3000 -v attendance-data:/data -e COOKIE_SECURE=1 -e TRUST_PROXY=1 team-attendance
   ```
4. **백업.** 서버를 끄지 않고 `npm run backup`(또는 `npm run backup -- /경로/파일.db`)을 실행하면 복사본이 만들어집니다. 하루 한 번 자동 실행(cron)을 권합니다.
5. **퇴사자 처리.** 관리자가 `POST /api/admin/users/<id>/active` 로 `{"active": false}` 를 보내면 로그인이 막히고 기록은 그대로 남습니다.

## 부정 기록 방지 범위

| 항목 | 상태 |
|---|---|
| 출퇴근 시각 조작 (기기 시계 변경) | 서버 시각만 사용하므로 막힘 |
| 다른 사람 대신 기록 | 로그인한 본인 계정으로만 기록 가능 |
| 하루 중복 출근 | 막힘 |
| 기록 삭제·몰래 수정 | 삭제 기능 없음, 보정은 관리자만 가능하고 이전 값·사유가 남음 |
| 사무실 밖에서 기록 | `ALLOWED_IPS` 설정 시 막힘. 설정하지 않으면 막지 않음 |
| 계정·비밀번호를 빌려주는 경우 | 막지 못함 (생체 인증, 위치 확인은 포함하지 않음) |

급여 근거로 쓰거나 위치·IP 정보를 수집하는 경우, 개인정보 수집 목적과 동의 절차, 기록 보관 기간은 노무사 등 전문가와 확인하세요. 서버는 출근·퇴근 때의 접속 IP를 기록합니다(`attendance.in_ip`, `out_ip`).

## 구성

```
server.js        서버 전체 (API, 인증, DB)
public/          화면 (index.html, app.js, app.css)
scripts/backup.js
test.js          통합 시험
```

주요 API: `POST /api/signup` · `/api/login` · `/api/logout` · `/api/punch` · `GET /api/me` · `/api/records?month=YYYY-MM` · `POST /api/requests` · `/api/requests/:id/decide` · `/api/admin/records`
