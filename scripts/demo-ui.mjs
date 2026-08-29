import { createWebApplication } from '../apps/web/dist/app.js';
import { createLogger } from '@api-accord/config';
import {
  InMemoryEventStore,
  seedBaselineCatalog,
  principalRef,
  DomainService,
  changeProposalId,
  discussionEntryId,
  decisionRecordId
} from '@api-accord/domain';

const port = Number(process.env.PORT ?? 4321);
const logger = createLogger({ service: 'web-demo', minimumLevel: 'info' });
const store = new InMemoryEventStore();
const human = principalRef('human', 'demo-runner');

// 1. Seed baseline catalog (PaymentService, MerchantConsole, SettlementWorker, MobileApp)
const seed = await seedBaselineCatalog(store, human);
const service = new DomainService(store);
const proposal = changeProposalId('proposal-reversed');

// 2. Create sample proposal
await service.openChangeProposal({
  actor: seed.providerActor,
  proposalId: proposal,
  contractId: seed.contract,
  title: 'Add REVERSED to PaymentStatus (v1.1.0)'
});

// 3. Create discussion & questions
await service.createDiscussionEntry({
  actor: seed.merchantActor,
  entryId: discussionEntryId('disc-q1'),
  proposalId: proposal,
  kind: 'question',
  body: 'How does REVERSED differ from CANCELLED? Does it affect settled payments?'
});

await service.createDiscussionEntry({
  actor: seed.settlementActor,
  entryId: discussionEntryId('disc-obj1'),
  proposalId: proposal,
  kind: 'objection',
  blocking: true,
  body: 'SettlementWorker exhaustive switch has no default case. This will crash on unhandled enum.'
});

// 4. Start web server with domain context
const app = createWebApplication({ logger, domain: { store } });

app.server.listen(port, () => {
  console.log(`\n======================================================`);
  console.log(`  🚀 API Accord 데모 서버가 기동되었습니다!`);
  console.log(`  브라우저에서 아래 URL에 접속하여 직접 육안으로 확인하실 수 있습니다:`);
  console.log(`======================================================`);
  console.log(`  1. 메인 랜딩 페이지:`);
  console.log(`     http://localhost:${port}/`);
  console.log(`  2. API 워크스페이스 (서비스 & 제안 목록):`);
  console.log(`     http://localhost:${port}/ui/workspace?organizationId=${seed.organizationId}`);
  console.log(`  3. 변경 제안 상세 및 토론/이의/결정:`);
  console.log(`     http://localhost:${port}/ui/proposals/proposal-reversed?organizationId=${seed.organizationId}`);
  console.log(`  4. 컨텍스트 인스펙터 (사실/가정/불일치/검토필요 7개 섹션):`);
  console.log(`     http://localhost:${port}/ui/operations/${encodeURIComponent(`${seed.contract}:get-payments-paymentid`)}/context?organizationId=${seed.organizationId}`);
  console.log(`  5. 액션 인박스 (개인/팀 할 일):`);
  console.log(`     http://localhost:${port}/ui/inbox?recipient=team-merchant&organizationId=${seed.organizationId}`);
  console.log(`======================================================\n`);
});
