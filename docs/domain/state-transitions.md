# API Accord 상태 전이

도메인 규칙은 `packages/domain/src/rules.ts`에 구현되며, `rules.test.ts`로 검증된다. 상태 전이는 항상 **새 이벤트**로만 일어나고 과거 레코드를 덮어쓰지 않는다.

## Change Proposal (INV-002, INV-005, INV-006)

```text
draft ──ChangeProposalOpened──▶ opened
opened ──ChangeProposalAccepted (차단 반론 0 & 필수 승인자 만족)──▶ accepted
accepted ──ProviderImplementationRecorded──▶ implemented
accepted ──ConsumerReadinessRecorded──▶ consumer_ready
accepted ──ContractVerificationRecorded──▶ verified
accepted ──DeploymentRecorded──▶ deployed
accepted ──ObservationRecorded──▶ observed
(accepted & implemented & verified & deployed & observed & consumer_migration_complete)
         ──ChangeProposalCompleted──▶ closed/completed
opened ──ChangeProposalRejected──▶ closed/rejected
opened ──ChangeProposalWithdrawn──▶ closed/withdrawn
```

- `accepted`는 `deployed`, `observed` 등을 **의미하지 않는다** (INV-002).
- 미해결 Blocking Objection이 있거나 필수 승인자가 누락되면 `Accepted`로 전환 불가 (INV-005).
- `completed`는 모든 확인된 소비자 migration 완료 후에만 (INV-006).

## Context Item (INV-011, INV-012)

```text
ContextProposed (unverified/inferred)
   ──ContextConfirmed (source+author+scope+validFrom 필수)──▶ confirmed
   ──ContextCorrected (새 아이템, 원본 보존)──▶ corrected_by
   ──ContextSuperseded (새 아이템, 유효기간 유지)──▶ superseded_by
```

정정과 대체는 과거를 파괴하지 않고 새 Context Item으로 남는다 (INV-012).

## Contract Version (INV-003)

```text
ContractVersionPublished ──▶ immutable (재발행 불가, 새 version id 필요)
```

## Evidence (INV-023)

`passed`와 `failed`/`skipped`/`not-run`/`waived`/`evidence-missing`은 결코 합쳐지지 않는다.
