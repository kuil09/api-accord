import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CompileInput, ConsumerImpactSummary, ContractSnapshot, DecisionRecord, DiscussionSummary } from './index.js';
import { CompileError, OpenApiCompilerAdapter, collectCompileErrors, validateOutput } from './compiler.js';
import { apiContractId, changeProposalId, decisionRecordId, discussionEntryId, principalRef, serviceId } from './primitives.js';
import type { ChangeProposalId } from './primitives.js';
import { changeProposalState, decisionRecordFrom, discussionSummary } from './projection.js';
import { DomainService } from './service.js';
import { InMemoryEventStore } from './events.js';

const human = principalRef('human', 'compiler-owner');

const baseContract: ContractSnapshot = {
  title: 'Payments',
  operations: [
    {
      method: 'get',
      path: '/payments/{paymentId}',
      responses: [
        {
          status: '200',
          schema: {
            type: 'object',
            required: ['id', 'status'],
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['PENDING', 'APPROVED', 'CANCELLED'] },
              approvedAt: { type: 'string', format: 'date-time', nullable: true }
            }
          }
        },
        { status: '404', schema: { type: 'object' } }
      ],
      security: []
    }
  ],
};

function acceptedState(proposalId: ChangeProposalId) {
  return changeProposalState(
    [
      {
        eventId: 'e1',
        aggregateType: 'changeProposal' as const,
        aggregateId: proposalId,
        occurredAt: new Date('2026-01-01T00:00:00Z'),
        actor: human,
        correlationId: 'c',
        version: 1,
        event: { type: 'ChangeProposalOpened' as const, proposalId, contractId: apiContractId('c-1'), title: 'Add REVERSED' }
      },
      {
        eventId: 'e2',
        aggregateType: 'changeProposal' as const,
        aggregateId: proposalId,
        occurredAt: new Date('2026-01-02T00:00:00Z'),
        actor: human,
        correlationId: 'c',
        version: 2,
        event: { type: 'ChangeProposalAccepted' as const, proposalId }
      }
    ],
    proposalId
  );
}

const resolvedDiscussion: DiscussionSummary = {
  entries: [],
  unresolvedQuestions: [],
  openBlockingObjections: [],
  resolvedCount: 2,
  wontFixCount: 0
};

const proposal = changeProposalId('p-compile');

const decision: DecisionRecord = {
  id: decisionRecordId('dec-compile'),
  proposalId: proposal,
  decision: 'Add REVERSED to PaymentStatus and map to CANCELLED for old clients',
  rationale: 'not all clients can update immediately',
  constraints: ['remove mapping after 2 releases'],
  rejectedAlternatives: [{ alternative: 'ship without mapping', reason: 'old clients break' }],
  approvers: [human],
  validFrom: new Date('2026-09-01T00:00:00Z'),
  sourceEntryIds: [],
  supersededBy: undefined
};

const impacts: ReadonlyArray<ConsumerImpactSummary> = [
  {
    consumerServiceId: serviceId('merchant-console'),
    impact: 'blocking',
    requiredActions: [
      { kind: 'unknown-enum-handling', description: 'handle unknown enum values on status', evidencePath: 'GET /payments/{paymentId}#response.200.status' },
      { kind: 'contract-test', description: 'add a contract test', evidencePath: 'GET /payments/{paymentId}' }
    ]
  },
  {
    consumerServiceId: serviceId('mobile-app'),
    impact: 'action-required',
    requiredActions: [{ kind: 'code-change', description: 'map REVERSED to CANCELLED', evidencePath: 'GET /payments/{paymentId}' }]
  }
];

const compileInput: CompileInput = {
  proposalId: proposal,
  proposalState: acceptedState(proposal) as NonNullable<ReturnType<typeof acceptedState>>,
  decisions: [decision],
  discussion: resolvedDiscussion,
  baseContract,
  approvedChanges: [
    {
      decisionRecordId: decision.id,
      changes: [{ op: 'add-enum-value', target: { method: 'get', path: '/payments/{paymentId}', response: '200', field: 'status' }, value: 'REVERSED' }]
    }
  ],
  impacts,
  compiledBy: human
};

function expectCompileError(input: CompileInput, pattern: RegExp): void {
  let thrown: unknown;
  try {
    new OpenApiCompilerAdapter().compile(input);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof CompileError, 'expected a CompileError');
  if (thrown instanceof CompileError) {
    assert.match(thrown.message, pattern);
  }
}

describe('compiler (issue #12)', () => {
  const adapter = new OpenApiCompilerAdapter();

  it('compiles the accepted REVERSED decision into the changed OpenAPI (INV-001)', () => {
    const output = adapter.compile(compileInput);
    const operation = output.openapi.operations[0];
    const status = operation?.responses[0]?.schema as { properties: { status: { enum: string[] } } };
    assert.ok(
      JSON.stringify(status.properties.status.enum) === JSON.stringify(['PENDING', 'APPROVED', 'CANCELLED', 'REVERSED']),
      'the approved enum addition is applied'
    );
  });

  it('keeps provenance: manifest identifies proposal, decisions and checksums, never a timestamp', () => {
    const output = adapter.compile(compileInput);
    assert.equal(output.manifest.proposalId, proposal);
    assert.ok(JSON.stringify(output.manifest.decisionRecordIds) === JSON.stringify(['dec-compile']));
    assert.ok(output.manifest.outputChecksum !== output.manifest.baseChecksum);
    assert.equal(output.manifest.compiledBy.id, 'compiler-owner');
    const manifestText = JSON.stringify(output.manifest);
    assert.ok(!/compiledAt|"at"|timestamp/u.test(manifestText), 'input checksums are the identifiers, not generation time');
  });

  it('is reproducible: the same input produces byte-identical output', () => {
    const first = adapter.compile(compileInput);
    const second = adapter.compile(compileInput);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('generates changelog and per-consumer migration guides together', () => {
    const output = adapter.compile(compileInput);
    assert.equal(output.changelog.length, 1);
    assert.equal(output.changelog[0]?.decisionRecordId, 'dec-compile');
    assert.match(output.changelog[0]?.text ?? '', /REVERSED/u);
    const guides = output.migrationGuides.map((guide) => guide.consumerServiceId);
    assert.ok(guides.includes(serviceId('merchant-console')));
    assert.ok(guides.includes(serviceId('mobile-app')));
    const merchant = output.migrationGuides.find((guide) => guide.consumerServiceId === 'merchant-console');
    assert.ok(merchant?.steps.some((step) => /unknown enum/iu.test(step)));
    assert.ok(merchant?.steps.some((step) => /deployment ordering/iu.test(step)), 'blocking consumers get ordering guidance');
  });

  it('drafts provider and consumer contract tests from the approved change', () => {
    const output = adapter.compile(compileInput);
    const provider = output.testDrafts.filter((draft) => draft.kind === 'provider');
    const consumer = output.testDrafts.filter((draft) => draft.kind === 'consumer');
    assert.ok(provider.some((draft) => /REVERSED/u.test(draft.name)));
    assert.ok(consumer.some((draft) => draft.consumerServiceId === 'merchant-console'));
    assert.ok(consumer.some((draft) => draft.consumerServiceId === 'mobile-app'));
  });

  it('refuses to compile an unaccepted proposal (INV-001)', () => {
    const notAccepted: CompileInput = {
      ...compileInput,
      proposalState: { ...compileInput.proposalState, accepted: false }
    };
    expectCompileError(notAccepted, /INV-001/u);
  });

  it('refuses to compile with open blocking objections or unresolved questions (INV-005, INV-014)', () => {
    const withObjection: CompileInput = {
      ...compileInput,
      discussion: {
        ...resolvedDiscussion,
        openBlockingObjections: [{ id: discussionEntryId('obj-1'), proposalId: proposal, kind: 'objection' as const, author: human, body: 'no', isBlockingObjection: true, status: 'open' as const, affectedConsumers: [] }]
      }
    };
    expectCompileError(withObjection, /INV-005/u);

    const withQuestion: CompileInput = {
      ...compileInput,
      discussion: {
        ...resolvedDiscussion,
        unresolvedQuestions: [{ id: discussionEntryId('q-1'), proposalId: proposal, kind: 'question' as const, author: human, body: 'why?', isBlockingObjection: false, status: 'open' as const, affectedConsumers: [] }]
      }
    };
    expectCompileError(withQuestion, /INV-014/u);
  });

  it('refuses changes citing decisions outside the proposal scope (INV-018)', () => {
    const outOfScope: CompileInput = {
      ...compileInput,
      approvedChanges: [
        {
          decisionRecordId: decisionRecordId('dec-elsewhere'),
          changes: [{ op: 'add-enum-value', target: { method: 'get', path: '/payments/{paymentId}', response: '200', field: 'status' }, value: 'REVERSED' }]
        }
      ]
    };
    const errors = collectCompileErrors(outOfScope);
    assert.ok(errors.some((message) => /INV-018/u.test(message)));
    expectCompileError(outOfScope, /INV-018/u);
  });

  it('reports unsupported change operations as compile errors instead of skipping them', () => {
    const bogus = { op: 'transmogrify', target: { method: 'get', path: '/payments/{paymentId}', response: '200' } } as unknown as CompileInput['approvedChanges'][number]['changes'][number];
    const unsupported: CompileInput = {
      ...compileInput,
      approvedChanges: [{ decisionRecordId: decision.id, changes: [bogus] }]
    };
    expectCompileError(unsupported, /unsupported change operation/u);
  });

  it('validates the generated contract and catches an emptied enum (INV-034)', () => {
    const output = adapter.compile(compileInput);
    assert.equal(validateOutput(output).length, 0);

    const broken: ContractSnapshot = {
      title: 'Payments',
      operations: [
        {
          method: 'get',
          path: '/payments/{paymentId}',
          responses: [{ status: '200', schema: { type: 'string', enum: [] } }],
          security: []
        }
      ]
    };
    const brokenOutput = { ...output, openapi: broken };
    const errors = validateOutput(brokenOutput);
    assert.ok(errors.some((message) => /enum has no values left/u.test(message)));
  });

  it('integration: compiles from the real service projections of an accepted proposal', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const realProposal = changeProposalId('p-real');
    await service.openChangeProposal({ actor: human, proposalId: realProposal, contractId: apiContractId('c-real'), title: 'Add REVERSED' });
    await service.recordDecision({
      actor: human,
      decisionRecordId: decisionRecordId('dec-real'),
      proposalId: realProposal,
      decision: 'Add REVERSED enum value',
      rationale: 'reversal workflow needs a distinct status',
      approvers: [human],
      validFrom: new Date('2026-09-01T00:00:00Z')
    });
    await service.acceptChangeProposal({ actor: human, proposalId: realProposal, openBlockingObjections: 0, requiredApproversSatisfied: true });

    const state = changeProposalState(await store.getAll(), realProposal);
    const record = decisionRecordFrom(await store.getAll(), decisionRecordId('dec-real'));
    assert.ok(state && record);

    const realInput: CompileInput = {
      proposalId: realProposal,
      proposalState: state,
      decisions: [record],
      discussion: discussionSummary(await store.getAll(), []),
      baseContract,
      approvedChanges: [
        { decisionRecordId: decisionRecordId('dec-real'), changes: [{ op: 'add-enum-value', target: { method: 'get', path: '/payments/{paymentId}', response: '200', field: 'status' }, value: 'REVERSED' }] }
      ],
      impacts: [],
      compiledBy: human
    };
    const output = adapter.compile(realInput);
    assert.equal(output.manifest.proposalId, realProposal);
    const operation = output.openapi.operations[0];
    const status = operation?.responses[0]?.schema as { properties: { status: { enum: string[] } } };
    assert.ok(status.properties.status.enum.includes('REVERSED'));
  });
});
