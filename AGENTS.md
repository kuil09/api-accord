# API Accord Agent Guide

이 문서는 저장소에 참여하는 인간과 AI 에이전트가 제품 목적을 훼손하지 않고 작업하기 위한 실행 규칙이다. 하위 디렉터리에 더 구체적인 `AGENTS.md`가 생기면 해당 범위에서는 하위 규칙이 우선한다.

## 1. 제품 목적

API Accord는 API 스펙 파일을 보기 좋게 표시하는 제품이 아니다. 다음 네 가지를 하나의 추적 가능한 흐름으로 연결한다.

1. 제공자와 소비자 사이의 계약
2. 문서 밖에서 형성된 기대와 맥락
3. 변경에 대한 반론, 제약, 승인과 결정
4. 코드, 테스트, 배포와 런타임 관찰 증거

모든 구현 판단은 [제품 비전](docs/product/vision.md), [용어집](docs/product/domain-glossary.md), [불변 규칙](docs/product/invariants.md), [MVP 범위](docs/product/mvp-scope.md)를 기준으로 한다.

## 2. 절대 규칙

- AI가 생성하거나 추론한 내용을 자동으로 `confirmed fact`, `Decision` 또는 승인 상태로 만들지 않는다.
- 기존 맥락, 결정, 승인, 증거와 감사 사건을 조용히 덮어쓰거나 삭제하지 않는다.
- API 계약 승인과 코드 PR merge, 배포 완료를 하나의 상태로 합치지 않는다.
- `breaking/non-breaking` 판정을 구조적 스키마 diff만으로 확정하지 않는다.
- 소비자별 사용 필드, 오류 의미, latency, retry, idempotency, enum 처리와 업무 중요도를 잃지 않는다.
- 출처, 적용 범위, 작성 principal 또는 버전이 없는 맥락을 확정 상태로 저장하지 않는다.
- 정보 부족, 테스트 미실행, 관찰 표본 부족을 성공이나 안전으로 표현하지 않는다.
- 승인되지 않은 계약 변경을 근거로 구현 패치나 PR을 만들지 않는다.
- 비밀정보, 실제 토큰, 연결 문자열, 사용자 payload를 코드·테스트·로그에 넣지 않는다.
- 도메인 규칙을 UI, HTTP handler 또는 MCP adapter에만 구현하지 않는다.

## 3. 작업 절차

### 작업 전

1. 대상 이슈와 의존 이슈를 읽는다.
2. 관련 제품 문서와 ADR을 읽는다.
3. 변경할 도메인 객체, 상태 전이, 저장 형식과 외부 계약을 확인한다.
4. 기존 코드와 테스트를 검색해 중복 구현을 피한다.
5. 새로운 기술 또는 되돌리기 어려운 구조를 도입하면 ADR이 필요한지 판단한다.

### 작업 중

1. 프레임워크 코드와 도메인 규칙을 분리한다.
2. mutation은 행위자, correlation ID, 원인과 이전 버전을 받을 수 있게 설계한다.
3. 오류를 catch한 뒤 성공으로 바꾸지 않는다.
4. 외부 연동은 adapter 경계 뒤에 둔다.
5. 생성형 AI 출력은 원본 출처와 모델·도구 버전을 연결할 수 있게 한다.
6. migration은 반드시 동일 번호의 `.up.sql`과 `.down.sql`을 함께 추가한다.
7. 공개 API나 데이터 모델을 바꾸면 테스트와 문서를 같은 변경에 포함한다.

### 작업 후

```bash
npm run check
```

PostgreSQL이나 워커를 변경했다면 다음도 실행한다.

```bash
npm run dev:infra
npm run db:migrate
npm run build
npm run smoke
```

PR에는 다음을 기록한다.

- 해결하는 이슈
- 변경된 제품 동작과 의도적으로 제외한 범위
- migration과 rollback 영향
- 실행한 검증 명령과 결과
- 남아 있는 위험, 추정 또는 미검증 항목

## 4. 디렉터리 책임

| 경로 | 책임 | 금지 사항 |
|---|---|---|
| `apps/api` | HTTP transport, auth context 전달, endpoint 조립 | 핵심 상태 규칙을 handler에 직접 고정 |
| `apps/web` | 사용자 인터페이스와 화면 전용 조립 | 화면 상태를 계약의 원본으로 사용 |
| `apps/worker` | 비동기 작업 실행과 재시도 | 실패를 완료로 기록, 알 수 없는 job 무시 |
| `packages/domain` | 프레임워크 독립 규칙과 도메인 타입 | DB, HTTP, GitHub SDK 직접 의존 |
| `packages/contracts` | 프로세스·adapter 사이의 안정된 타입 | 특정 UI 컴포넌트나 DB row 노출 |
| `packages/config` | 환경 파싱, 로깅과 런타임 공통 설정 | 비밀 기본값, 조용한 잘못된 값 보정 |
| `packages/mcp` | MCP resource/tool 경계 | Web API와 다른 권한·도메인 규칙 구현 |
| `migrations` | 순서가 있는 DB 구조 변경 | 적용된 migration 파일의 사후 수정 |
| `docs/product` | 제품 헌법과 용어 | 구현 편의를 위한 의미 변경 |
| `docs/adr` | 아키텍처 결정과 대안 | 결정 결과만 기록하고 이유·대안 누락 |

## 5. 기술 기준선

- Node.js 22 이상
- TypeScript strict mode와 project references
- npm workspaces
- PostgreSQL
- PostgreSQL `FOR UPDATE SKIP LOCKED` 기반 최소 작업 큐
- JSON 구조화 로그
- `/health`와 `/ready` 분리
- GitHub Actions에서 lint, typecheck, test, build, migration apply/rollback, smoke 검증

기준선을 바꿀 때는 코드보다 먼저 또는 같은 PR에서 ADR을 갱신한다.

## 6. 보안과 비밀정보

커밋 금지 항목:

- `.env`
- GitHub App private key
- MCP credential
- API key 또는 OAuth token
- 실제 운영 DB URL
- 실제 요청·응답 payload와 개인정보
- 원문 authorization header

로그에 허용되는 것은 필요한 최소 메타데이터다. 오류 객체는 정규화하고, 연결 문자열과 payload 전체를 직렬화하지 않는다.

## 7. 테스트 기준

- 성공 경로만 테스트하지 않는다.
- 권한 부족, version conflict, stale context, missing evidence와 부분 실패를 명시적으로 테스트한다.
- health는 프로세스 생존, readiness는 의존성 수용 가능성을 뜻한다.
- 시간과 외부 서비스에 의존하는 테스트에는 명시적 adapter/fake를 사용한다.
- fixture는 `PaymentStatus.REVERSED` 기준 시나리오와 모순되지 않아야 한다.

## 8. 완료 정의

작업은 다음 조건을 모두 만족해야 완료다.

- 이슈의 인수 조건이 코드 또는 문서로 충족된다.
- 관련 불변 규칙을 위반하지 않는다.
- lint, typecheck, test와 build가 통과한다.
- DB 변경은 apply와 rollback이 모두 가능하다.
- 운영 가능한 오류·로그·health 상태가 있다.
- 새로운 결정은 ADR 또는 제품 문서에 남아 있다.
- PR에서 최초 요구사항과 최종 증거를 역추적할 수 있다.
