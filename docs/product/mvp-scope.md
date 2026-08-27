# API Accord MVP 범위

- 관련 이슈: #1, #2, #23
- 기준 인수 시나리오: #22

## 1. MVP 목표

MVP는 기능 수가 아니라 다음 폐쇄 루프를 검증한다.

```text
API 등록
→ 소비 관계와 숨은 가정 수집
→ 변경 제안
→ 구조적 diff와 소비자별 의미 영향
→ 구조화된 토론과 결정
→ 스펙·정책·테스트 컴파일
→ 제공자·소비자 구현 증거
→ 배포와 런타임 관찰
→ Drift와 맥락 정정
```

루프의 일부만 제공하는 API 문서 사이트는 MVP가 아니다.

## 2. MVP 포함 범위

### 계정과 접근

- Organization과 Team
- Human, Agent, Service, CI, Integration Principal
- 조직·서비스·API·Operation 범위 RBAC
- scoped MCP credential 발급·철회·회전
- 중요 mutation 감사 기록

### 서비스와 계약 카탈로그

- Service 등록과 소유 Team 연결
- API Contract와 Provider Service 연결
- OpenAPI 3.0/3.1 import
- Contract Version, source revision과 checksum
- Operation, request/response/error/security 기본 표시

### 소비 관계

- Consumer Service와 Operation 연결
- 실제 사용 필드
- enum, nullability, status/error 의미 가정
- timeout, retry, idempotency와 부작용 기대
- 업무 중요도와 compatibility policy
- 명시 선언, 코드 추정, 런타임 관찰 출처 구분

### 맥락과 공론장

- 출처·작성자·범위·신뢰도·유효 기간을 가진 Context Item
- confirm, challenge, correct, narrow, add evidence, expire, supersede
- Question, Proposal, Objection, Constraint, Assumption, Evidence, Alternative, Correction, Acknowledgement
- Blocking Objection과 해결 상태
- Decision Record 승격과 대체 계보

### Change Proposal

- Draft부터 Accepted, 구현, 검증, 배포, 관찰, 완료까지 분리된 상태
- 구조적 스펙 diff
- Consumer별 Semantic Impact
- 필수 승인자와 Required Action
- Consumer readiness와 migration 기한
- stale 분석과 재계산

### 컴파일과 Git 연동

- 승인된 Decision에서 OpenAPI 변경 산출물 생성
- changelog, migration guide, provider/consumer contract test 초안
- GitHub App 또는 테스트 adapter를 통한 branch·PR·CI Evidence 연결
- PR merge와 Proposal 완료 상태 분리

### MCP와 Web

- 같은 도메인 서비스·권한·감사 규칙 사용
- Operation context 조회
- Consumer assumption과 영향 경로 조회
- Proposal 생성과 구조화 댓글
- Context 확인·반박·정정
- spec compile과 pending action 조회
- API Workspace, Operation, Proposal, Context Inspector, Action Inbox 핵심 화면

### Evidence와 관찰

- Provider·Consumer contract test 결과
- commit, PR, CI와 deployment revision
- Evidence staleness
- 기본 runtime schema/status/enum drift 탐지
- Drift를 Context correction 또는 Change Proposal 후보로 전환

### 제한된 구현 자동화

- L0 문서·분석
- L1 저장소별 구현 계획
- L2 검토 가능한 patch
- L3 branch·PR과 테스트 Evidence

자동 merge와 자동 배포는 포함하지 않는다.

## 3. MVP 제외 범위

- AsyncAPI, Protobuf, GraphQL 실제 importer 전체 지원
- 범용 API Gateway 또는 service mesh
- 범용 Git hosting
- 자동 production merge·deployment
- 원문 운영 payload 장기 보관
- 대규모 조직용 완전한 billing·SCIM·SAML
- 모든 AI provider의 세부 최적화
- 관계 그래프 전용 DB 도입
- 고급 runtime traffic replay
- 모든 언어·프레임워크용 SDK와 contract test adapter
- 스마트폰 우선 UI

제외 범위는 구조적으로 확장 가능해야 하지만 MVP 구현을 지연시키면 안 된다.

## 4. 기준 시나리오: `PaymentStatus.REVERSED`

### 현재 계약

`payment-service`는 다음 응답을 제공한다.

```yaml
Payment:
  type: object
  required: [id, status]
  properties:
    id:
      type: string
    status:
      type: string
      enum: [PENDING, APPROVED, CANCELLED]
    approvedAt:
      type: string
      format: date-time
      nullable: true
```

### 변경 제안

`PaymentStatus`에 `REVERSED`를 추가한다.

### 소비자 맥락

#### merchant-console

- `id`, `status`, `approvedAt` 사용
- unknown enum을 허용하지 않는 parser
- 중요도 `high`
- `APPROVED`이면 `approvedAt`이 항상 존재한다고 가정

#### settlement-worker

- `status`로 정산 분기
- exhaustive switch에 default가 없음
- 알 수 없는 값에서 작업 실패 가능

#### mobile-app

- 구버전은 `CANCELLED`만 취소 상태로 인식
- 서버 또는 gateway의 compatibility mapping 필요
- 모든 사용자가 즉시 업데이트할 수 없음

### 기대 분석

```text
Structural Diff: additive enum value
Generic compatibility: additive / potentially breaking
Semantic Impact:
  merchant-console: blocking
  settlement-worker: blocking
  mobile-app: action-required with compatibility mapping
```

### 토론과 결정

최소한 다음 질문을 해결해야 한다.

- `REVERSED`는 기존 `CANCELLED`와 어떤 업무 의미가 다른가
- 구버전 mobile-app에는 어떤 값으로 매핑할 것인가
- 새 enum을 알 수 없는 값으로 처리하는 것이 조직 공통 정책인가
- Provider와 Consumer 배포 순서는 무엇인가
- 언제부터 mapping을 제거할 수 있는가

Decision Record에는 결정, 이유, 적용 범위, 제약, 거부 대안, 승인자와 유효 Contract Version이 포함된다.

### 구현과 증거

- Provider 스펙·직렬화 변경
- merchant-console parser와 UI 처리
- settlement-worker switch와 contract test
- mobile compatibility mapping과 제거 기한
- 각 source revision에 연결된 contract test Evidence
- 배포 환경과 Contract Version 연결
- 관찰 기간 동안 unknown enum parse 오류가 없다는 Observation

### 실패 경로

MVP는 다음을 조용히 성공 처리하지 않아야 한다.

- Blocking Objection이 남아 있음
- 필수 Consumer 승인 누락
- Dependency Edge 변경 후 stale Impact Analysis 사용
- Provider test만 있고 Consumer Evidence가 없음
- 과거 commit의 test 결과 재사용
- 관찰 표본이 부족함
- runtime에서 문서에 없는 상태값 발견

## 5. MVP 수직 슬라이스

### Slice A — Foundation

- 제품 헌법과 용어
- 실행 가능한 모노레포
- PostgreSQL, queue, migration, health/readiness, CI

### Slice B — Catalog and Context

- Service·API·Operation import
- Dependency Edge와 Context Item
- Operation 화면과 MCP 조회

### Slice C — Agreement

- Structured Discussion
- Decision Record
- Change Proposal 상태와 승인

### Slice D — Contract Intelligence

- Structural Diff
- Consumer Semantic Impact
- Required Action과 spec compile

### Slice E — Evidence Loop

- GitHub·CI Evidence
- Consumer readiness
- runtime Drift와 Context correction

### Slice F — Limited Implementation

- 승인된 Proposal에서 implementation plan과 PR 생성

각 Slice는 Web과 MCP 중 하나만 먼저 완성한 뒤 복제하지 않는다. 동일 도메인 서비스 위에 두 인터페이스를 수직으로 연결한다.

## 6. MVP 완료 조건

- OpenAPI를 반복 가능하게 import하고 Contract Version을 보존한다.
- Operation별 Consumer와 사용 필드·숨은 가정을 등록한다.
- enum 추가를 구조적으로 additive이지만 Consumer별 위험으로 판정한다.
- 미해결 반론과 필수 승인 없이 Accepted가 되지 않는다.
- Decision Record에서 새 스펙·changelog·migration·test 초안을 재현 가능하게 만든다.
- GitHub PR, commit, CI와 Consumer Evidence를 Contract Version에 연결한다.
- Web과 MCP가 같은 권한과 감사 결과를 반환한다.
- 배포 후 Drift를 탐지해 Context correction 또는 새 Proposal로 전환한다.
- AI 출력의 source, confidence, model/tool version과 staleness를 확인한다.
- 성공·실패 E2E가 한 명령과 CI에서 반복 가능하다.

## 7. 성공 지표

MVP 단계에서는 사용량보다 정확성과 폐쇄 루프를 측정한다.

- 영향받는 Consumer를 놓치지 않은 비율
- Impact Analysis에서 근거 경로가 존재하는 비율
- Confirmed Context 중 source와 scope가 완전한 비율
- stale Evidence와 Analysis가 차단된 비율
- Proposal에서 최초 요구부터 Observation까지 역추적 가능한 비율
- 사용자 정정이 원본 AI 주장과 계보로 남는 비율
- 기준 시나리오 성공·실패 E2E 재현성
