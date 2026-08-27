# Architecture Decision Records

ADR은 되돌리기 어렵거나 여러 영역에 영향을 주는 기술·구조 결정을 기록한다.

| ADR | 상태 | 결정 |
|---|---|---|
| [0001](0001-node-typescript-postgresql-monorepo.md) | Accepted | Node.js·TypeScript·npm workspaces·PostgreSQL 기준선 |
| [0002](0002-postgresql-backed-job-queue.md) | Accepted | 초기 작업 큐를 PostgreSQL로 구현 |

새 ADR은 [0000-template.md](0000-template.md)를 복사하고 번호를 증가시킨다. 기존 ADR을 편집해 과거 결정을 숨기지 않는다. 결정이 바뀌면 새 ADR에서 이전 ADR을 supersede한다.
