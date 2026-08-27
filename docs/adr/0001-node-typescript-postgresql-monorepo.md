# ADR-0001: Node.js·TypeScript·PostgreSQL 모노레포 기준선

- 상태: Accepted
- 날짜: 2026-08-27
- 결정자: Repository owner
- 관련 이슈: #2

## 맥락

API Accord는 Web UI, HTTP API, MCP, background worker, contract compiler와 외부 adapter가 같은 도메인 규칙을 공유해야 한다. 초기 단계에서 각 프로세스를 별도 저장소와 언어로 나누면 권한·상태 전이·계약 타입이 빠르게 갈라질 위험이 크다.

동시에 다음 요구가 있다.

- 인간과 AI 에이전트가 이해하기 쉬운 명시적 구조
- strict typecheck와 빠른 로컬 검증
- JSON·OpenAPI·MCP와 자연스러운 상호운용
- PostgreSQL transaction과 migration
- 후속 단계에서 프로세스를 분리 배포할 수 있는 경계
- 특정 클라우드나 웹 프레임워크에 조기 종속되지 않는 기반

## 결정

초기 기준선은 다음과 같다.

- Node.js 22 이상
- TypeScript strict mode
- npm workspaces 모노레포
- TypeScript project references
- PostgreSQL을 주 데이터 저장소로 사용
- `apps/web`, `apps/api`, `apps/worker`를 독립 실행 프로세스로 구성
- `packages/domain`, `packages/contracts`, `packages/config`, `packages/mcp`를 공용 경계로 구성
- HTTP 서버는 foundation 단계에서 Node 표준 라이브러리로 구현
- JSON 구조화 로그와 correlation ID 사용
- health와 readiness endpoint 분리
- GitHub Actions에서 lint, typecheck, test, build, migration과 smoke 검증

프레임워크는 실제 기능 요구가 구체화된 뒤 별도 ADR로 도입한다.

## 대안

### 여러 저장소와 독립 서비스

배포 독립성은 높지만 초기 도메인과 권한 모델이 확정되기 전에 계약 중복과 drift가 발생한다. 제품 자체가 해결하려는 문제를 내부 개발에서 재현할 가능성이 높아 기각했다.

### Go 또는 Rust 중심 백엔드

강한 타입과 배포 효율은 장점이다. 그러나 Web·MCP·OpenAPI 처리와 빠른 도메인 탐색에서 언어 경계 비용이 초기 가치보다 크다. 성능상 필요한 worker가 확인되면 별도 adapter로 도입할 수 있다.

### 대형 웹 프레임워크 즉시 도입

인증·라우팅·UI 생산성은 높을 수 있으나 제품 경계가 확정되지 않은 상태에서 프레임워크 관례가 도메인 모델을 주도할 위험이 있다. foundation에서는 표준 라이브러리와 얇은 adapter를 사용한다.

### pnpm 또는 Turborepo

대규모 모노레포에서는 이점이 있지만 초기 저장소에 별도 도구 체인을 추가한다. npm workspaces와 project references로 부족해지는 시점에 재검토한다.

## 결과

### 긍정적 결과

- 한 번의 설치로 모든 프로세스와 공용 패키지를 검증할 수 있다.
- Web, API, worker와 향후 MCP가 같은 타입·권한·도메인 서비스를 공유할 수 있다.
- 프레임워크를 도입하지 않아 초기 도메인 경계를 명시적으로 볼 수 있다.
- 각 app은 독립 포트와 entrypoint를 가지므로 이후 컨테이너 분리가 가능하다.

### 부정적 결과와 비용

- Node 단일 런타임에 초기 결합이 생긴다.
- 표준 HTTP 서버의 반복 코드는 기능 증가 전에 framework 도입 검토가 필요하다.
- npm workspace는 더 큰 규모에서 task caching과 의존성 격리가 부족할 수 있다.

### 후속 조치

- 인증, routing 또는 UI 복잡도가 실제로 증가하면 framework ADR 작성
- packages 간 의존 방향을 CI 또는 lint rule로 강화
- 배포 단위와 컨테이너 이미지는 운영환경 이슈에서 결정

## 검증 방법

- `npm install --no-audit --no-fund && npm run check` 성공
- 빈 DB에서 migration apply/rollback/reapply 성공
- web/API/worker health와 readiness 성공
- smoke test에서 PostgreSQL queue job 처리 성공
- app이 공용 package를 통해 타입을 공유하고 역방향 의존이 없는지 확인
