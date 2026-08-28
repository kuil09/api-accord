# API Accord 위협 모델과 보안 검토 체크리스트 (이슈 #21)

범위: MVP 슬라이스(#2~#22)에 구현된 도메인 계층과 두 인터페이스(Web/API, MCP). 이 문서는 자산·신뢰 경계·공격 경로를 기록하고, 각 항목을 구현된 완화책과 남은 위험에 연결한다.

## 1. 자산

- 계약 원장(`domain_event`): 제안·결정·증거·관찰의 불변 기록
- credential 해시와 scope: MCP/API 접근 수단
- Context Item과 Dependency Edge: 소비자 가정·내부 구조 정보
- Impact/drift 분석 결과: 소비자 시스템의 약점 힌트
- 감사 원장: 행위자·시각·이유

## 2. 신뢰 경계

| 경계 | 통과하는 것 | 집행 위치 |
|---|---|---|
| 외부 에이전트 → MCP | 도구 호출, idempotency key | `ApiAccordMcpServer.dispatch` scope 검사 + 도메인 가드 |
| Web UI → API | 리소스 요청 | 동일 DomainService 가드 + `enforceOrganizationBoundary` |
| GitHub/observer → Evidence | 증거 제출 | `attachEvidence` + provenance 구분 |
| 모델 제공자 → AI 입력 | 번들 요약 | `allowedForAiInput` + `redactDetail` |

## 3. 공격 경로와 완화책

| 위협 | 완화 | 상태 |
|---|---|---|
| 조직 간 ID 추측·데이터 노출 | `enforceOrganizationBoundary` 중앙 집행 + 다중 조직 테스트 | 구현(#21), 어댑터 호출 의무화 필요 |
| 에이전트 credential 탈취·과도한 scope | credential 해시 저장·즉시 철회(`isCredentialUsable`)·최소 scope(`hasScope`) | 구현(#4, #21) |
| prompt/tool input으로 권한 우회 | 도구는 scope 검사 후 도메인 가드를 통과해야 하며, 가드는 도메인 계층에 있음(호출자가 우회 불가) | 구현(#14, #18) |
| 위조된 GitHub webhook·Evidence | webhook replay 방어(delivery id+timestamp), provenance 구분(github-check vs direct) | 부분 구현(#16, #21), 서명 검증은 #13 |
| 민감 payload의 로그 유출 | 중앙 `redactDetail`, `classifySensitiveContent`, `allowedForAiInput` | 구현(#17, #21) |
| 승인 이력 변조 | append-only 원장 + `verifyLedgerIntegrity` + waiver의 사람 부여·만료 | 구현(#12, #16, #21) |
| 오래된 AI 분석을 최신 사실처럼 사용 | `isContextBundleStale`/`isImpactAnalysisStale` stale 마킹 | 구현(#11, #18) |
| 관찰 표본 부족을 정상으로 표시 | INV-025 샘플/기간 게이트 | 구현(#22, #17) |

## 4. 보안 검토 체크리스트

- [ ] 새 인터페이스(Web/MCP/worker)는 모든 mutation에서 `enforceOrganizationBoundary`를 호출하는가
- [ ] credential은 해시만 저장하고 철회가 즉시 적용되는가 (`isCredentialUsable`)
- [ ] 새 도구는 scope를 선언하고 `hasScope` 검사를 통과하는가
- [ ] 로그·AI 입력·원장에 원문 payload/secret/PII가 없는가 (`classifySensitiveContent` + `redactDetail`)
- [ ] 실패/스킵/만료 증거가 passed로 기록되지 않는가 (INV-023)
- [ ] 백업 복원 후 `verifyLedgerIntegrity`를 실행하는가
- [ ] webhook 소비는 delivery id 기록 + timestamp 검사를 하는가
- [ ] 삭제 요청은 ADR 0003 절차(키 폐기 + 톰스톤 + 읽기 모델 정리)를 따르는가
- [ ] 법적 보존(hold)이 삭제 처리보다 우선하는가

## 5. 남은 위험

- 실제 GitHub webhook 서명 검증은 #13에서 구현
- credential의 durable 저장소/재시작 유지 idempotency는 후속
- 값 자체의 PII 패턴 탐지(자유 텍스트)는 휴리스틱 한계
- 조직별 waiver 권한 정책 세분화는 후속
