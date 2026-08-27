# API Accord 제품 불변 규칙

불변 규칙은 구현 방식과 무관하게 반드시 유지해야 하는 제품 헌법이다. 각 규칙은 테스트, DB 제약, 상태 전이 guard, 권한 정책 또는 감사 검사로 검증 가능해야 한다.

## 계약과 변경

### INV-001 — 모든 계약 변경은 Change Proposal을 가진다

발행된 Contract Version의 의미 또는 구조를 바꾸는 모든 행위는 원인이 되는 Change Proposal과 연결되어야 한다. 직접 파일 수정이나 Git merge만으로 계약을 발행할 수 없다.

### INV-002 — 계약 승인과 구현 상태를 합치지 않는다

`Accepted`, Provider 구현, Consumer readiness, Contract verification, Deployment, Observation은 독립 상태다. 하나의 성공이 다른 상태의 성공을 암시하지 않는다.

### INV-003 — 발행된 Contract Version은 불변이다

발행 이후에는 내용을 덮어쓰지 않는다. 수정은 새 Contract Version과 이를 정당화하는 Proposal·Decision으로만 가능하다.

### INV-004 — 문법적 호환성과 의미론적 호환성을 분리한다

Structural Diff의 additive/breaking 판정과 Consumer별 Semantic Impact는 별도 필드와 근거로 저장한다.

### INV-005 — 차단 반론과 필수 승인을 우회하지 않는다

해결되지 않은 Blocking Objection 또는 누락된 필수 승인자가 있으면 Accepted 또는 publish 전환을 거부한다. Override는 권한, 이유와 Decision Record를 요구한다.

### INV-006 — 폐기는 마지막 소비자 이행 전 완료되지 않는다

deprecated Operation이나 필드는 모든 확인된 Consumer가 migration을 완료하거나 명시적 예외 결정을 갖기 전 `Completed`가 될 수 없다.

## 소비 관계

### INV-007 — 영향 분석은 Operation과 Consumer 관계를 기준으로 한다

Service 간 단순 연결만으로 영향 없음 또는 안전을 단정하지 않는다. 사용 Operation, 필드, 오류, 동작과 정책을 확인한다.

### INV-008 — 소비자별 가정을 보존한다

서로 다른 Consumer가 동일 Operation에 대해 상충된 가정을 가져도 하나로 평균내거나 덮어쓰지 않는다. 충돌 상태와 각 출처를 유지한다.

### INV-009 — 영향 없음과 정보 부족을 구분한다

Dependency Edge가 없거나 최신 여부가 불명확한 경우 `none`이 아니라 `unknown` 또는 evidence 부족으로 표현한다.

### INV-010 — 관계 선언은 출처와 확인 시점을 가진다

명시적 등록, 코드 분석 추정, 런타임 관찰을 구분하고 마지막 확인 시점과 source revision을 유지한다.

## 맥락과 결정

### INV-011 — 모든 확정 맥락에는 출처·작성자·범위가 있다

`confirmed` Context Item은 statement만으로 생성할 수 없다. source, author principal, scope와 유효 시점을 요구한다.

### INV-012 — 정정은 과거를 파괴하지 않는다

잘못된 Context Item과 Decision을 삭제하거나 원문을 조용히 수정하지 않는다. Correction 또는 Supersede 사건으로 계보를 남긴다.

### INV-013 — 토론과 결정은 분리한다

토론 요약은 Decision Record가 아니다. 적용 범위, 이유, 제약, 거부 대안, 승인자와 유효 시점이 확정되어야 결정이 된다.

### INV-014 — 미해결 질문과 반대 의견은 요약에서 사라지지 않는다

AI 또는 인간 요약은 unresolved Question, Blocking Objection과 minority position을 명시적으로 보존한다.

### INV-015 — 오래된 맥락을 최신 사실처럼 반환하지 않는다

입력 source, Contract Version, code revision 또는 Dependency Edge가 바뀌면 파생 Context Bundle과 Impact Analysis를 stale로 표시한다.

## AI와 자동화

### INV-016 — AI 출력은 자동으로 사실이나 결정이 되지 않는다

AI가 생성한 Context의 기본 상태는 `unverified` 또는 `inferred`다. Confirmed Context와 Decision에는 별도 권한 행위가 필요하다.

### INV-017 — AI 결과는 provenance를 유지한다

중요 주장과 산출물은 입력 객체 버전, source reference, 모델·prompt·tool 버전과 실행 principal을 역추적할 수 있어야 한다.

### INV-018 — AI는 승인 범위를 넘어 구현하지 않는다

Implementation Task의 코드 diff는 Accepted Proposal과 Decision이 허용한 동작·파일 범위를 벗어나면 중단하거나 재승인을 요구한다.

### INV-019 — AI 장애가 계약 원본을 손상시키지 않는다

모델 호출 실패, timeout 또는 비결정적 출력은 기존 Contract, Context와 Decision을 변경하지 않는다. 부분 결과는 실패 상태와 함께 보존한다.

### INV-020 — 자동화 등급은 명시적 정책을 따른다

문서 생성, 계획, patch, PR, merge, deployment 권한을 하나로 묶지 않는다. Organization·API·변경 위험별 허용 등급을 적용한다.

## Evidence와 관찰

### INV-021 — 구현 완료 선언은 증거를 요구한다

Provider·Consumer readiness와 Contract Verified 상태는 대상 Contract Version과 source revision에 귀속된 필수 Evidence가 있어야 한다.

### INV-022 — 오래된 Evidence는 성공으로 사용하지 않는다

계약, 코드 또는 test fixture가 바뀌면 이전 Evidence를 stale 또는 superseded로 처리한다.

### INV-023 — 실패·미실행·면제를 성공과 구분한다

`failed`, `skipped`, `not-run`, `waived`, `evidence-missing`을 `passed`로 합치지 않는다. UI와 API에서 상태를 그대로 노출한다.

### INV-024 — 런타임 관찰은 계약을 자동 변경하지 않는다

Observation은 Drift 또는 Context 후보를 생성할 수 있지만 Contract Version이나 Decision을 직접 수정하지 않는다.

### INV-025 — 표본 부족은 정상 판정이 아니다

관찰 기간이나 샘플 수가 정책에 미달하면 `healthy`가 아니라 `insufficient evidence`로 표현한다.

## 신원·권한·감사

### INV-026 — 모든 mutation은 실제 Principal에 귀속된다

인간, agent, service, CI, integration을 구분하고 익명 시스템 행위로 기록하지 않는다.

### INV-027 — 승인 권한과 구현 권한은 독립적이다

`proposal:approve`, `spec:compile`, `implementation:write`, `test:execute`, `runtime:observe` scope를 별도로 부여한다.

### INV-028 — 에이전트는 인간을 가장하지 않는다

대리 실행이 필요하면 initiating human과 executing agent를 모두 기록한다. 감사 로그의 actor를 인간으로 바꾸지 않는다.

### INV-029 — 조직 경계는 모든 인터페이스에서 동일하다

Web API, MCP, worker, GitHub webhook과 내부 query가 같은 Organization 격리와 scope 규칙을 적용한다.

### INV-030 — 중요 상태 변화는 append-only 감사 사건을 가진다

권한, Context 확인·정정, Proposal 상태·승인, spec publish, Evidence waiver와 Drift 처리에는 actor, 시각, 이유, correlation ID와 대상 버전이 남아야 한다.

## 데이터와 운영

### INV-031 — 비밀정보와 원문 payload는 기본 수집하지 않는다

토큰, authorization header, DB credential, 개인정보와 런타임 payload 원문을 로그 또는 AI 입력에 기본 포함하지 않는다.

### INV-032 — Migration은 순방향과 역방향을 함께 정의한다

DB 구조 변경에는 동일 ID의 up/down migration과 CI 검증이 필요하다. 이미 적용된 migration 파일을 사후 수정하지 않는다.

### INV-033 — Health와 Readiness를 구분한다

`/health`는 프로세스 생존, `/ready`는 의존성과 현재 역할을 수용할 준비가 됐음을 뜻한다. DB 장애 시 process health를 거짓 실패로 만들지 않고 readiness를 실패시킨다.

### INV-034 — 오류를 조용히 성공으로 변환하지 않는다

외부 연동, AI, migration, queue와 evidence 수집 실패는 명시적 실패·부분 실패·재시도 상태로 남긴다.

### INV-035 — 현재 상태에서 과거 상태를 재구성할 수 있다

중요 객체는 snapshot만 남기지 않고 사건, 버전과 supersede 관계를 통해 특정 시점의 계약·맥락·승인 상태를 재구성할 수 있어야 한다.
