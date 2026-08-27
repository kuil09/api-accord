# API Accord 도메인 용어집

이 용어집은 코드, 데이터 모델, UI, MCP tool과 문서에서 같은 개념을 같은 이름으로 사용하기 위한 기준이다. 비슷한 일반 용어로 임의 치환하지 않는다.

## Organization

API Accord의 최상위 협업·보안 경계. 사용자, 팀, 서비스, 계약, 정책과 감사 사건이 Organization에 귀속된다. 서로 다른 Organization의 객체는 명시적 공유 계약 없이는 접근할 수 없다.

## Team

서비스, API, Operation 또는 정책을 책임지는 인간 집단. Team은 소유권과 필수 승인자 계산에 사용되며 principal 자체는 아니다.

## Principal

행위를 수행하고 권한과 감사 기록의 주체가 되는 신원.

- `human`: 사용자
- `agent`: AI 또는 자동화 에이전트
- `service`: 실행 서비스 계정
- `ci`: CI 실행자
- `integration`: GitHub, Gateway, observer 같은 외부 통합

## Scope

Principal이 수행할 수 있는 행위의 종류와 적용 가능한 리소스 범위. 예: `context:read`, `proposal:create`, `proposal:approve`, `spec:compile`.

## Service

독립적으로 소유·배포되는 제공자 또는 소비자 실행 단위. 저장소와 일대일일 필요는 없으며 하나의 Service가 여러 API를 제공하거나 소비할 수 있다.

## Provider

특정 API Contract 또는 Operation의 동작을 제공하는 Service와 책임 주체.

## Consumer

특정 Operation을 호출하거나 이벤트를 구독하고 그 동작에 의존하는 Service 또는 외부 클라이언트.

## API Workspace

하나의 API Contract와 관련 Service, Operation, Context, Proposal, Decision, Evidence와 Drift를 모아 보는 협업 공간. Git 저장소와 동일하지 않다.

## API Contract

제공자와 소비자 사이에서 합의된 기계·인간 판독 가능한 동작 계약의 논리적 식별자. OpenAPI 파일 하나보다 넓은 개념이며 여러 Contract Version을 가진다.

## Contract Version

특정 시점에 발행된 불변 계약 스냅샷. 원본 스펙, 정규화 표현, checksum, source revision과 해당 Decision Record를 연결한다.

## Operation

독립적으로 논의·소유·변경 영향 분석이 가능한 최소 API 동작 단위.

예:

- `POST /payments`
- `GET /orders/{orderId}`
- `PaymentCompleted` event
- `MerchantService.GetMerchant` RPC

## Schema

Operation에서 사용하는 요청·응답·오류·이벤트 데이터 구조. Schema 자체의 구조적 변경과 소비자가 특정 필드에 부여한 의미는 분리한다.

## Behavior

스키마만으로 표현되지 않는 API 동작 의미. 멱등성, 부작용, 처리 순서, 일관성, retry 가능성, latency, timeout, 오류 의미가 포함된다.

## Dependency Edge

Consumer가 특정 Operation에 어떻게 의존하는지 표현하는 방향성 관계. 단순 호출 여부가 아니라 사용 필드, 숨은 가정, 중요도, 허용 호환성, 담당자와 출처를 포함한다.

## Usage Declaration

Dependency Edge 안에서 Consumer가 실제로 사용하는 Operation, 요청·응답 필드, 오류와 상태값을 명시한 선언.

## Assumption

스펙이나 확정 정책으로 보장되지 않았지만 Consumer 또는 Provider가 사실처럼 의존하는 주장. Assumption은 숨기지 않고 출처와 신뢰도를 가진 Context Item으로 관리한다.

## Compatibility Policy

Consumer, API 또는 Organization이 허용하는 변경 범위. 예: additive field 허용, unknown enum 금지, nullable 변경 금지.

## Context Item

하나의 검증 가능한 맥락 주장. 최소한 statement, scope, type, author principal, source, confidence, 유효 기간과 정정 계보를 가진다.

## Context Scope

Context Item이 적용되는 범위. Organization, Service, API Contract, Operation, Dependency Edge 또는 Change Proposal이 될 수 있다.

## Source

Context Item, Decision, Evidence 또는 분석 결과의 근거가 되는 원본 참조. 문서, 코드 위치, commit, incident, discussion entry, runtime observation 등이 될 수 있다.

## Provenance

어떤 결과가 어떤 입력, 버전, principal, 모델·도구와 실행에서 만들어졌는지 역추적하는 정보. 단순 URL보다 넓다.

## Confidence

Context Item의 확인 상태.

- `unverified`: 제기됐으나 검증되지 않음
- `inferred`: 근거에서 추론됨
- `confirmed`: 권한 있는 주체와 증거로 확인됨
- `disputed`: 충돌하거나 반박됨

## Correction

기존 Context Item이 틀렸거나 범위가 잘못됐음을 새 사건으로 기록하는 행위. 과거 항목을 삭제하지 않는다.

## Supersede

새 Context Item 또는 Decision이 기존 항목을 특정 시점부터 대체하는 관계. 과거 유효 기간과 이유는 유지한다.

## Stale

입력 계약, 코드, 관계 또는 근거 버전이 변경되어 현재 결론에 그대로 사용할 수 없는 상태. Stale은 거짓과 같지 않으며 재검토가 필요하다는 의미다.

## Structured Discussion

Question, Proposal, Objection, Constraint, Assumption, Evidence, Alternative, Correction, Acknowledgement 같은 발언 유형과 해결 상태를 가진 API 중심 토론.

## Blocking Objection

해결되거나 명시적으로 기각·waive되기 전에는 Change Proposal의 Accepted 전환을 막는 반론.

## Decision Record

구조화된 토론에서 확정된 결정, 이유, 제약, 적용 범위, 거부한 대안, 승인자와 유효 버전을 보존하는 불변 기록.

## Change Proposal

API Contract 또는 Operation의 의미·구조·정책을 바꾸기 위한 추적 가능한 제안. 스펙 diff뿐 아니라 이유, 영향 소비자, 호환성, migration, 승인, 구현, 테스트, 배포와 관찰 상태를 포함한다.

## Structural Diff

두 Contract Version 사이의 문법·스키마 구조 변화. 필드, type, enum, status code, path, security requirement 등의 변화다.

## Semantic Impact

구조적 변화가 특정 Consumer의 기대와 업무 동작에 미치는 실제 영향. 같은 Structural Diff도 Consumer별 Semantic Impact가 다를 수 있다.

## Impact Analysis

Structural Diff, Dependency Edge, Context Item과 Compatibility Policy를 결합해 Consumer별 위험, 필요한 조치, 승인자와 불확실성을 산출한 결과.

## Required Action

Change Proposal을 이행하기 위해 특정 Principal 또는 Team이 수행해야 하는 검토, 구현, 테스트, migration, 배포 또는 확인 작업.

## Consumer Readiness

특정 Consumer가 변경 계약을 수용할 준비가 되었는지 나타내는 독립 상태. 단순 확인 버튼이 아니라 필요한 Evidence와 version을 연결한다.

## Evidence

계약의 합의·구현·배포·관찰 상태를 뒷받침하는 검증 가능한 자료. commit, PR, provider/consumer contract test, deployment revision, canary, runtime observation 등이 있다.

## Waiver

필수 Evidence 또는 정책 조건을 권한 있는 Principal이 이유, 범위와 만료 기간을 명시해 일시적으로 면제하는 결정. 성공 Evidence로 위장하지 않는다.

## Deployment

특정 source revision과 Contract Version이 특정 환경에 배포된 사건. 계약 승인과 별개다.

## Observation

런타임 또는 테스트 환경에서 실제 동작을 수집한 결과. Observation은 계약을 자동 변경하지 않는다.

## Drift

발행 계약, 제공자 구현, Consumer 기대 또는 런타임 Observation 사이의 불일치. Drift Incident는 종류, 심각도, 빈도, 환경, 근거와 상태를 가진다.

## Context Bundle

특정 Operation 또는 Change Proposal에 관련된 사실, 가정, 충돌, 노후화, Evidence와 미해결 질문을 출처와 함께 조립한 읽기 모델. 원본 Context Item을 대체하지 않는다.

## Spec Compiler

Accepted Change Proposal과 Decision Record를 OpenAPI, 정책, changelog, migration guide, 계약 테스트 초안 등 재현 가능한 산출물로 변환하는 결정적 처리 과정.

## Implementation Task

Accepted Change Proposal의 Required Action을 특정 저장소·Service의 구현 작업으로 변환한 객체. 계약 변경과 코드 변경 사이의 연결 단위다.

## Audit Event

중요 행위의 principal, 시각, 대상, 이유, correlation ID와 이전·이후 상태를 append-only로 기록한 사건.

## Correlation ID

하나의 사용자·에이전트·통합 요청이 Web, API, worker와 외부 adapter를 통과하는 동안 공유하는 추적 식별자. Principal이나 권한을 대체하지 않는다.
