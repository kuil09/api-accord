# API Accord 도메인 ERD

이 다이어그램은 `packages/domain`의 현재 상태 read model과 `migrations/0002_domain_event_store.up.sql`의 테이블을 설명한다. 소스 오브 트루스는 `domain_event` 원장이며, 나머지 테이블은 이벤트에서 파생된 투영이다 (INV-035).

```text
organization 1──* team 1──* service
                              │
                              ├──< api_contract (provider_service_id)
                              │        │
                              │        ├──< contract_version (immutable, INV-003)
                              │        │        ├──< evidence
                              │        │        └──< deployment
                              │        └──< operation
                              │                 ├──< schema
                              │                 └──< observation
                              │
                              └──< dependency_edge (consumer_service_id → operation)
                                        │
                                        └──< usage / assumption (source-tagged, INV-010)

change_proposal ──< discussion_entry (blocking objection, INV-005)
       │
       ├── accepted / implemented / consumer_ready / verified / deployed / observed  (독립 상태, INV-002)
       └──< decision_record (supersede 계보)

context_item (scope별 적용, corrected_by / superseded_by 계보, INV-012)
```

## 원장과 투영

| 테이블 | 역할 | 불변 규칙 |
|---|---|---|
| `domain_event` | append-only 이벤트 원장 (PK: aggregate_type, aggregate_id, version) | INV-035, INV-030 |
| `change_proposals` | 투영. lifecycle 플래그는 독립적 | INV-002, INV-005, INV-006 |
| `context_items` | 투영. 정정/대체는 새 행 + 계보 참조 | INV-011, INV-012 |
| `contract_versions` | 불변 스냅샷 | INV-003 |
| `evidence` | status는 결코 passed로 합쳐지지 않음 | INV-023 |

이 문서는 `packages/domain/src/**.test.ts`의 규칙 테스트로 검증된다 (상태 전이가 코드와 불일치하면 테스트가 실패).
