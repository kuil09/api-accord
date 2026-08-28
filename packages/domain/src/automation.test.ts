import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConsumerImpactSummary, ImplementationTask } from './index.js';
import {
  AutomationViolation,
  InMemoryGitAdapter,
  canRerun,
  canStartAutomation,
  createPullRequestForTasks,
  generateImplementationPlan,
  generatePatch,
  isImplementationPlanStale,
  testResultToEvidenceStatus,
  workBranchName
} from './automation.js';
import { changeProposalId, principalRef, serviceId } from './primitives.js';

const human = principalRef('human', 'payments-owner');
const proposal = changeProposalId('p-auto');
const provider = serviceId('payment-service');

const impacts: ReadonlyArray<ConsumerImpactSummary> = [
  {
    consumerServiceId: serviceId('merchant-console'),
    impact: 'blocking',
    requiredActions: [{ kind: 'code-change', description: 'update parser for REVERSED', evidencePath: 'GET /payments/{paymentId}' }]
  },
  {
    consumerServiceId: serviceId('settlement-worker'),
    impact: 'blocking',
    requiredActions: [{ kind: 'code-change', description: 'add switch default', evidencePath: 'GET /payments/{paymentId}' }]
  },
  {
    consumerServiceId: serviceId('mobile-app'),
    impact: 'action-required',
    requiredActions: [{ kind: 'code-change', description: 'map REVERSED to CANCELLED', evidencePath: 'GET /payments/{paymentId}' }]
  }
];

describe('L1 implementation plans (issue #19)', () => {
  const plan = generateImplementationPlan({
    proposalId: proposal,
    contractChecksum: 'cs-1',
    providerServiceId: provider,
    providerRequiredActions: [{ kind: 'code-change', description: 'serialize REVERSED' }],
    consumerImpacts: impacts,
    decisionRecordId: 'dec-auto' as never
  });

  it('creates provider and per-consumer implementation tasks', () => {
    const roles = plan.tasks.map((task) => task.role);
    assert.ok(roles.includes('provider'));
    assert.equal(roles.filter((role) => role === 'consumer').length, 3, 'three consumer tasks');
    assert.ok(plan.tasks.every((task) => task.source.proposalId === proposal), 'every task traces to the proposal');
  });

  it('orders deployment: provider first, blocking consumers, then the rest', () => {
    const ordering = plan.deploymentOrdering;
    assert.equal(ordering[0]?.serviceId, provider);
    assert.equal(ordering[0]?.order, 1);
    const blocking = ordering.filter((step) => step.reason.startsWith('blocking consumer'));
    assert.equal(blocking.length, 2);
    assert.ok(blocking.every((step) => step.order === 2 || step.order === 3));
    const last = ordering[ordering.length - 1];
    assert.equal(last?.serviceId, serviceId('mobile-app'), 'non-blocking consumer updates last');
  });

  it('goes stale when the contract checksum changes', () => {
    assert.equal(isImplementationPlanStale(plan, 'cs-1').stale, false);
    const check = isImplementationPlanStale(plan, 'cs-2');
    assert.equal(check.stale, true, 'a contract change invalidates the plan');
  });
});

describe('automation guards (issue #19)', () => {
  it('allows L0/L1 before acceptance but requires acceptance for L2/L3 (INV-018)', () => {
    assert.equal(canStartAutomation({ level: 'L1', proposalAccepted: false }).ok, true);
    assert.equal(canStartAutomation({ level: 'L2', proposalAccepted: false }).ok, false);
    assert.equal(canStartAutomation({ level: 'L3', proposalAccepted: false }).ok, false);
    assert.equal(canStartAutomation({ level: 'L2', proposalAccepted: true }).ok, true);
  });
});

describe('L2 patches (issue #19)', () => {
  const task: ImplementationTask = {
    taskId: 'task-1',
    repositoryServiceId: serviceId('merchant-console'),
    role: 'consumer',
    kind: 'code-change',
    description: 'update parser for REVERSED',
    source: { proposalId: proposal, decisionRecordId: 'dec-auto' as never, requiredActionKind: 'code-change' },
    status: 'planned'
  };

  const base: Omit<Parameters<typeof generatePatch>[0], 'task'> = {
    level: 'L2',
    proposalAccepted: true,
    allowedFilePaths: ['src/parser.ts'],
    filePath: 'src/parser.ts',
    changeSummary: 'handle REVERSED enum value'
  };

  it('generates a reviewable patch whose source traces to the decision and task', () => {
    const patch = generatePatch({ ...base, task });
    assert.equal(patch.source.decisionRecordId, 'dec-auto');
    assert.equal(patch.taskId, task.taskId);
    assert.match(patch.diffHunk, /dec-auto/u);
    assert.match(patch.diffHunk, /parser for REVERSED/u);
  });

  it('aborts on files outside the approved scope and requires re-approval', () => {
    let violation: AutomationViolation | undefined;
    try {
      generatePatch({ ...base, task, filePath: 'src/unrelated.ts' });
    } catch (error) {
      violation = error instanceof AutomationViolation ? error : undefined;
    }
    assert.ok(violation);
    assert.match(violation?.reason ?? '', /outside the approved change scope/u);
    assert.equal(violation?.requireReapproval, true);
  });

  it('requires a separate human approval for sensitive changes', () => {
    let violation: AutomationViolation | undefined;
    try {
      generatePatch({ ...base, task, sensitiveCategory: 'monetary' });
    } catch (error) {
      violation = error instanceof AutomationViolation ? error : undefined;
    }
    assert.ok(violation);
    assert.match(violation?.reason ?? '', /separate human approval/u);

    const approved = generatePatch({
      ...base,
      task,
      sensitiveCategory: 'monetary',
      separateHumanApproval: { grantedBy: human, reason: 'cfo signed off' }
    });
    assert.match(approved.diffHunk, /separate human approval by payments-owner/u);
  });

  it('rejects a second patch for an already-patched task', () => {
    const patched: ImplementationTask = { ...task, status: 'patched' };
    let violation: AutomationViolation | undefined;
    try {
      generatePatch({ ...base, task: patched });
    } catch (error) {
      violation = error instanceof AutomationViolation ? error : undefined;
    }
    assert.ok(violation);
    assert.match(violation?.reason ?? '', /planning stage/u);
  });
});

describe('L3 pull requests (issue #19)', () => {
  const task: ImplementationTask = {
    taskId: 'task-pr',
    repositoryServiceId: serviceId('merchant-console'),
    role: 'consumer',
    kind: 'code-change',
    description: 'update parser for REVERSED',
    source: { proposalId: proposal, decisionRecordId: 'dec-auto' as never, requiredActionKind: 'code-change' },
    status: 'planned'
  };
  const patch = generatePatch({ level: 'L2', proposalAccepted: true, task, allowedFilePaths: ['src/parser.ts'], filePath: 'src/parser.ts', changeSummary: 'handle REVERSED' });

  it('creates the PR on a work branch with full provenance in the body', async () => {
    const git = new InMemoryGitAdapter();
    const pr = await createPullRequestForTasks({
      git,
      level: 'L3',
      proposalAccepted: true,
      proposalId: proposal,
      decisionRecordId: 'dec-auto' as never,
      contractVersionId: 'contract-payments@rev-2',
      contractChecksum: 'cs-1',
      defaultBranch: 'main',
      repositoryServiceId: serviceId('merchant-console'),
      tasks: [task],
      patches: [patch],
      title: 'Implement REVERSED handling'
    });
    assert.equal(pr.branch, workBranchName({ repositoryServiceId: serviceId('merchant-console'), proposalId: proposal }));
    assert.ok(pr.pullRequestNumber > 0);
    const created = git.createdBranches[0];
    assert.ok(created?.startsWith('accord/'), 'work happens on a dedicated accord branch');
  });

  it('never commits to the default branch -- PRs land on a dedicated accord branch', async () => {
    const git = new InMemoryGitAdapter();
    const pr = await createPullRequestForTasks({
      git,
      level: 'L3',
      proposalAccepted: true,
      proposalId: proposal,
      contractVersionId: 'contract-payments@rev-2',
      contractChecksum: 'cs-1',
      defaultBranch: 'main',
      repositoryServiceId: serviceId('merchant-console'),
      tasks: [task],
      patches: [patch],
      title: 'x'
    });
    assert.ok(pr.branch !== 'main', 'the work branch is never the default branch');
    assert.ok(pr.branch.startsWith('accord/'));
    assert.ok(git.createdBranches.every((branch) => branch !== 'main'));
  });

  it('requires acceptance before PR creation (INV-018)', async () => {
    const git = new InMemoryGitAdapter();
    let violation: AutomationViolation | undefined;
    try {
      await createPullRequestForTasks({
        git,
        level: 'L3',
        proposalAccepted: false,
        proposalId: proposal,
        contractVersionId: 'contract-payments@rev-2',
        contractChecksum: 'cs-1',
        defaultBranch: 'main',
        repositoryServiceId: serviceId('merchant-console'),
        tasks: [task],
        patches: [patch],
        title: 'x'
      });
    } catch (error) {
      violation = error instanceof AutomationViolation ? error : undefined;
    }
    assert.ok(violation);
    assert.match(violation?.reason ?? '', /INV-018/u);
  });
});

describe('runs, evidence and re-runs (issue #19)', () => {
  it('maps test results to honest evidence statuses (INV-023)', () => {
    assert.equal(testResultToEvidenceStatus(true), 'passed');
    assert.equal(testResultToEvidenceStatus(false), 'failed');
    assert.equal(testResultToEvidenceStatus(undefined), 'not-run');
  });

  it('allows re-running failed or partial runs but not completed ones', () => {
    assert.equal(canRerun({ runId: 'r1', proposalId: proposal, level: 'L2', status: 'failed', taskIds: [] }).ok, true);
    assert.equal(canRerun({ runId: 'r2', proposalId: proposal, level: 'L2', status: 'partial', taskIds: [] }).ok, true);
    assert.equal(canRerun({ runId: 'r3', proposalId: proposal, level: 'L2', status: 'completed', taskIds: [] }).ok, false);
  });
});
