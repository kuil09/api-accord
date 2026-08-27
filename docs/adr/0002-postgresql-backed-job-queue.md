# ADR-0002: 초기 작업 큐를 PostgreSQL로 구현

- 상태: Accepted
- 날짜: 2026-08-27
- 결정자: Repository owner
- 관련 이슈: #2

## 맥락

API Accord는 spec import, context assembly, impact analysis, notification, evidence 수집과 runtime observation 같은 비동기 작업이 필요하다. foundation 단계에서도 worker 프로세스와 재시도 가능한 작업 경계를 검증해야 한다.

별도 broker를 즉시 도입하면 운영 요소와 장애 모드가 늘어난다. MVP 트래픽과 처리량은 아직 알 수 없고, 대부분의 작업은 PostgreSQL에 저장된 계약 객체와 transactionally 연결될 가능성이 높다.

## 결정

초기 작업 큐는 PostgreSQL의 `job_queue` 테이블과 `FOR UPDATE SKIP LOCKED`를 사용한다.

- job은 type, JSON payload, status, priority, attempts, max attempts, available time, lock owner와 오류를 가진다.
- worker는 짧은 transaction 안에서 하나의 job을 claim한다.
- 성공 시 completed, 실패 시 재시도 가능 여부에 따라 pending 또는 failed로 전환한다.
- 알 수 없는 job type은 성공 처리하지 않는다.
- queue schema는 reversible migration으로 관리한다.
- queue 연결은 worker readiness의 필수 조건이다.

## 대안

### Redis·Valkey 기반 큐

낮은 latency와 성숙한 라이브러리가 장점이지만 별도 persistence·backup·운영 경계가 생긴다. 초기에는 PostgreSQL transaction과 일관된 감사가 더 중요하다.

### Kafka 또는 NATS

이벤트 스트리밍과 대규모 처리에는 적합하지만 foundation과 MVP 요구에 비해 운영 비용과 개념 복잡도가 과도하다.

### 프로세스 메모리 큐

구현은 단순하지만 재시작 시 작업과 근거를 잃고 다중 worker에서 안전하지 않다. 제품의 append-only·evidence 원칙과 맞지 않는다.

## 결과

### 긍정적 결과

- PostgreSQL 하나로 로컬 개발과 CI를 구성한다.
- 작업 상태와 도메인 변경을 같은 DB에서 transactionally 연결할 수 있다.
- `SKIP LOCKED`로 여러 worker가 같은 job을 중복 claim하지 않는다.
- migration과 SQL을 직접 관찰할 수 있어 AI 에이전트가 동작을 이해하기 쉽다.

### 부정적 결과와 비용

- polling 부하와 latency가 있다.
- 장시간 작업, 고처리량, 복잡한 scheduling에서는 전용 broker보다 불리하다.
- job payload schema를 application layer에서 별도로 검증해야 한다.

### 재검토 조건

다음 중 하나가 확인되면 전용 broker 도입 ADR을 작성한다.

- PostgreSQL queue polling이 주 DB latency에 유의미한 영향을 줌
- 처리량 또는 지연 요구를 충족하지 못함
- topic fan-out, ordered stream, replay가 핵심 요구가 됨
- 여러 region 또는 독립 장애 도메인이 필요함

## 검증 방법

- 두 worker가 `SKIP LOCKED`로 같은 job을 중복 처리하지 않는 integration test
- 실패 job의 retry와 max attempts 전환 검증
- worker readiness에서 DB/queue 장애 검증
- smoke test에서 실제 job insert와 completed 전환 검증
