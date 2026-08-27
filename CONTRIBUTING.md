# Contributing

## 기본 흐름

1. 작업할 이슈와 의존 이슈를 확인한다.
2. `main`에서 작업 브랜치를 만든다.
3. [AGENTS.md](AGENTS.md)와 관련 제품 문서·ADR을 읽는다.
4. 작은 수직 변경과 검증 가능한 테스트를 함께 작성한다.
5. `npm run check`를 실행한다.
6. 데이터베이스나 런타임 경계를 바꿨다면 `npm run smoke`도 실행한다.
7. PR 본문에 이슈, 변경 범위, 검증 결과와 남은 위험을 기록한다.

## 커밋

커밋 메시지는 변경 의도를 드러내는 명령형 문장으로 작성한다.

```text
feat: add operation context ledger
fix: reject stale proposal approval
chore: establish TypeScript workspace
```

## Pull Request 최소 내용

- 해결 이슈: `Closes #<number>`
- 바뀐 제품 동작
- 의도적으로 제외한 범위
- 데이터 migration과 rollback 여부
- 실행한 검증 명령
- 미검증 항목 또는 후속 이슈

## 아키텍처 결정

다음 변경은 ADR을 요구한다.

- 주요 프레임워크, 저장소, 큐 또는 프로토콜 도입·교체
- 도메인 객체의 원본 저장 방식 변경
- 권한 또는 조직 격리 모델 변경
- AI 제공자 종속 구조 도입
- 되돌리기 어려운 외부 계약 변경

ADR은 [템플릿](docs/adr/0000-template.md)을 복사해 작성한다.
