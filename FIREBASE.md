# Firebase 연결·운영 안내

현재 코드/에뮬레이터 검증까지 준비되어 있습니다. 실제 Firebase 프로젝트·도메인·결제 계정·비밀값은 연결하지 않았으며 배포 명령은 실행하지 않았습니다.

## 구성

- Firebase Hosting: 웹 화면과 HTTPS. /api/**를 서울(asia-northeast3) Cloud Functions v2 api로 전달.
- Cloud Functions: 서버 로그인, 직원별 권한, 정산 계산, 서명 및 월 마감 트랜잭션.
- Firebase Authentication: Email/Password 제공자를 사용하되 사용자 화면에서는 영문 아이디만 입력.
- Cloud Firestore Standard, Native mode: 서울 asia-northeast3 위치 권장. 생성 후 위치 변경 제약을 확인.
- 서명은 현재 Firestore 별도 문서에 저장하므로 Cloud Storage 버킷은 필수가 아닙니다.
- Firestore 클라이언트 보안 규칙은 전체 거부입니다. Admin SDK API만 앱의 권한 검사 후 읽고 씁니다.

## 처음 연결

1. Firebase Console에서 매장 소유 Google 계정으로 프로젝트를 생성하고 실제 프로젝트 ID를 확인합니다.
2. Functions v2 배포에는 일반적으로 Blaze 사용량 기반 결제 연결이 필요합니다.
   예산 알림은 지출 상한이 아닙니다. Functions maxInstances=3도 전체 비용 상한을 보장하지 않습니다.
   프로젝트/결제 생성은 이 작업에서 수행하지 않았습니다.
3. Firestore Native 데이터베이스를 만들고 위치를 선택합니다.
4. Authentication → Sign-in method에서 Email/Password를 켭니다.
   Firebase Password policy는 기본 6자 이상으로 유지하고 프로젝트의 가입/로그인 API 쿼터를 확인합니다.
5. Firebase 프로젝트 웹 앱 설정의 Web API key를 확인합니다. 이는 공개 설정 키이며 서비스 계정 비밀키와 다릅니다.
6. 개발 PC에서 Firebase CLI에 본인 계정으로 인증합니다. 이 환경은 자동 로그인/계정 선택을 하지 않았습니다.
7. .firebaserc의 기본 demo-double-y를 실제 프로젝트로 바꾸거나 명령마다 --project 실제ID를 명시합니다.
   데모 프로젝트에 운영 배포하지 마세요.
8. 루트 .env.<실제프로젝트ID> 파일에 WEB_API_KEY를 설정합니다.
   템플릿은 firebase/.env.example이며 실제 값이 들어간 .env.*는 Git에서 제외합니다.
   기본 도메인은 https://<프로젝트ID>.web.app입니다. 사용자 도메인은 PUBLIC_ORIGIN도 같이 지정합니다.
9. 최초 관리자 설정 코드를 Secret Manager에 저장합니다.

    npx firebase functions:secrets:set SETUP_TOKEN --project 실제프로젝트ID

SETUP_TOKEN은 충분히 긴 임의값을 사용하고 채팅/소스에 붙여넣지 않습니다.
서버 서비스 계정 키 JSON을 브라우저, public, Git 저장소에 넣지 않습니다.
Functions는 런타임 서비스 계정(ADC)을 사용합니다.

## 배포할 때

요청 범위에 외부 게시 금지가 있어 현재 배포는 하지 않았습니다.
준비된 코드 확인 후 운영자가 명시적으로 배포하는 명령입니다.

    npx firebase deploy --project 실제프로젝트ID --only firestore:rules,firestore:indexes
    npx firebase deploy --project 실제프로젝트ID --only functions:payroll,hosting

인덱스가 모두 Enabled가 된 후 운영을 시작합니다.
첫 배포 시 API 활성화·서비스 계정 IAM·Cloud Build 권한 등이 프로젝트 정책에 따라 추가로 필요할 수 있습니다.
기본 공개 주소의 설정 화면에서 SETUP_TOKEN으로 최초 관리자 계정을 1개 만들고 구성원/직원 계정을 발급합니다.
초기 관리자 생성은 Firestore 단일 트랜잭션으로 잠급니다. 임의 회원 가입 화면은 없습니다.

실기기에서 두 관리자/직원 계정으로 로그인해 다른 직원 자료 접근 차단,
폰 터치 서명, 세션 복귀, 동시 수업 입력, 다짐 가져오기, 월 마감 후 수정 차단을 확인합니다.
실제 기기 HTTPS 연결과 현장 네트워크 검증은 아직 수행하지 않았습니다.

## 비밀번호와 계정 운영

- 아이디마다 내부 인증 이메일이 생성됩니다. 실제 메일을 받지 않으므로 자동 이메일 비밀번호 복구 기능은 제공하지 않습니다.
- 직원 비밀번호는 앱의 관리자 초기화 기능으로 재발급하며 첫 로그인 때 변경합니다.
- 관리자 모두 접근을 잃었을 때는 프로젝트 소유자가 Admin SDK로 특정 UID의 비밀번호를 초기화한 뒤 앱 계정 active/must_change/version을 검토해야 합니다.
- Auth와 Firestore를 아우르는 단일 트랜잭션은 없으므로 계정 생성 실패 시 미완료 Auth 계정을 보상 삭제합니다.
  비밀번호 초기화는 기존 세션을 먼저 무효화하고 진행합니다. Auth 변경 실패 시 차단/임시 상태를 남겨 접근이 열리지 않도록 합니다.
  시스템 중단으로 프로필 없는 Auth 계정이 남으면 Console에서 UID와 accounts 문서를 대조한 후 미완료 계정만 정리합니다.
- Firebase 관리자 서비스 계정은 강한 권한을 갖습니다. 직원에게 Console/IAM 접근 권한을 주지 않습니다.
- member-mode는 해당 기기의 서버 세션 전체를 잠급니다. 다른 기기의 선생님 세션까지 모두 잠그는 기능은 아닙니다.

## 백업·복원

Firestore의 복제는 별도 백업을 대신하지 않습니다. Console 또는 Google Cloud 도구에서
관리형 예약 백업과 필요 시 PITR을 활성화하고 보관 기간/비용을 확인합니다.
이 작업에서 실제 백업 스케줄은 활성화하지 않았습니다.

운영 시작 전 최소 일 1회 예약 백업, 별도 프로젝트/버킷의 주기적 내보내기,
접근권한 제한과 월 1회 격리 복원 점검을 권장합니다.
Auth 계정도 Firebase CLI auth:export 등으로 별도 보관하며 복원 시 UID를 유지합니다.
Auth 내보내기 파일의 비밀번호 해시·프로젝트 해시 설정은 민감 정보이며 공개 저장소에 넣으면 안 됩니다.

    FIREBASE_PROJECT_ID=원본프로젝트 npm run firebase:export

이 명령은 Firestore 문서만 JSONL+체크섬으로 보관합니다. 세션·로그인 시도·멱등성 캐시는 제외합니다.
Auth 비밀번호는 포함하지 않으며 서명 좌표·계정 메타데이터·급여 등 개인정보가 포함됩니다.
내보내기는 운영 트랜잭션 시점 일관성을 보장하는 관리형 백업을 대체하지 않습니다.
프로젝트 전체 시점 복구에는 관리형 백업/내보내기를 사용합니다.

    FIREBASE_PROJECT_ID=격리대상프로젝트 CONFIRM_FIREBASE_RESTORE=격리대상프로젝트 npm run firebase:restore -- 백업경로.jsonl

대상이 완전히 비어 있어야 하며 기존 DB에 덮어쓰지 않습니다. 실패한 복원은 격리 프로젝트에서 점검 후 새 대상으로 재실행합니다.
Auth는 같은 UID로 별도로 복원해야 로그인됩니다. 검증 전 운영 앱의 프로젝트를 전환하지 않습니다.

## 조회와 규모

회원/계약/수업/서명은 독립 문서이며 전체 JSON 한 문서 누적 방식이 아닙니다.
급여는 해당 월 자료, 서명 회차는 해당 회원권 자료만 읽습니다.
월 범위 서버 조회 12000건, 회원권 최대 등록횟수 10000회, 일괄 회원 이관 40건,
다짐 가져오기 200건, 단일 트랜잭션 쓰기 450건의 보호 한도를 둡니다.
초과하면 조용히 누락하지 않고 오류를 반환합니다.

Firestore는 읽은 문서 수 등에 따라 과금됩니다. 월별 조회/서명 상태 검사에도 읽기 비용이 발생합니다.
현재는 단일 지점용 거래 잠금 문서(control/state)를 사용하므로 고빈도 다지점 운영에는 잠금/집계를 지점별로 나누는 작업이 필요합니다.
관측된 에뮬레이터 통과는 실서비스의 네트워크·IAM·인덱스·과금·모든 기기 동작을 보증하지 않습니다.

## 데이터 이전

외부 프로그램은 회원명 대신 members.id 또는 검증된 external_ref를 기준으로 연결합니다.
contracts.id, lessons.id, signature.lesson_id, payroll snapshot 참조를 유지합니다.
현재 SQLite → Firebase 실데이터 자동 이관은 실행하지 않았습니다. 기존 DB가 있다면 원본 보관,
격리 이관·건수/잔여횟수/매출/급여/서명 해시 대조를 먼저 완료해야 합니다.

## 이번 검증 범위

Auth/Firestore 에뮬레이터 통합 검사, 기존 정산 회귀 검사, Chromium 모바일 터치 서명·월말 전체 흐름을 실행합니다.
Functions v2의 실제 진입점과 Hosting /api rewrite도 로컬에서 검사했습니다.
클라우드 작업 환경에서 Firebase CLI 15.34.2가 로컬 요청에까지 외부 HTTP 프록시를 적용하는 문제는
CLI의 loopback 요청만 직접 연결하도록 일시 보정해 검사한 뒤 의존성 원본으로 되돌렸습니다.
외부 요청의 환경 프록시나 네트워크 정책은 변경하지 않았습니다. 앱 코드의 우회 기능은 아닙니다.
에뮬레이터는 호스트 Node 24로 실행했고 배포 런타임 설정은 Node 22입니다.
실제 프로젝트 배포 후 IAM·인덱스·환경변수·Secret Manager·HTTPS·현장 기기를 별도로 확인해야 합니다.

## 숫자 4자리 PIN 로그인

앱 비밀번호에는 숫자 4자리(앞자리 0 포함) 또는 기존 6~128자를 사용할 수 있습니다.
Firebase 자체의 6자 제한은 바꾸지 않습니다. 4자리 입력은 서버에서 계정별 256비트 무작위 키와 HMAC-SHA256으로
Firebase용 긴 인증값을 만들고, 앱 서버의 로그인 횟수 제한을 거쳐 검증합니다. 고정 접두사만 붙이는 방식이 아닙니다.
PIN 원문은 저장하지 않으며 계정의 pin_key는 서버 전용 accounts 문서에만 보관하고 브라우저 응답에서 제외합니다.
비밀번호 변경/초기화 때 새 키로 교체하고 기존 세션을 무효화합니다. 일반 6자 이상 계정은 변환 없이 계속 로그인합니다.
PIN 키도 인증 관련 민감정보이므로 Firestore 내보내기·복원 파일을 제한된 접근으로 보관해야 합니다.
4자리 PIN은 선택지가 1만 개이므로 관리자 계정에는 긴 비밀번호를 권장합니다.
직원의 기존 비밀번호가 자동으로 PIN으로 바뀌는 것은 아니며 본인 변경 또는 관리자 초기화를 이용합니다.
Firebase Console에서 PIN 원문을 직접 비밀번호로 설정하지 말고 앱의 계정 메뉴를 사용합니다.
