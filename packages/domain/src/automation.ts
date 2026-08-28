// Implementation automation (issue #19): turns an accepted Change Proposal's
// required actions into per-repository implementation plans (L1), reviewable
// patches (L2), and branch + pull request creation with evidence linkage (L3)
// through a GitAdapter port. Automatic merge and deployment are out of scope.
//
// Enforcement rules from the issue are structural:
// - no code patches or pull requests before the proposal is accepted (INV-018);
// - work happens on a dedicated branch, never the default branch;
// - every generated PR states the Proposal, Decision and Contract Version it
//   implements;
// - patches touching files outside the approved scope abort and require
//   re-approval;
// - monetary/auth/permission/PII/data-deletion changes require a separate
//   human approval;
// - failed or skipped test results are never recorded as success (INV-023).

import type { ChangeProposalId, DecisionRecordId, PrincipalRef, ServiceId } from './primitives.js';
import type { ConsumerImpactSummary } from './compiler.js';

export type AutomationLevel = 'L0' | 'L1' | 'L2' | 'L3';

// --- L1: per-repository implementation plans ---

export interface ImplementationTask {
  readonly taskId: string;
  readonly repositoryServiceId: ServiceId;
  readonly role: 'provider' | 'consumer';
  readonly kind: string;
  readonly description: string;
  readonly source: {
    readonly proposalId: ChangeProposalId;
    readonly decisionRecordId?: DecisionRecordId | undefined;
    readonly requiredActionKind: string;
  };
  readonly status: 'planned' | 'patched' | 'pr-created' | 'completed' | 'failed';
}

export interface DeploymentStep {
  readonly order: number;
  readonly serviceId: ServiceId;
  readonly reason: string;
}

export interface ImplementationPlan {
  readonly proposalId: ChangeProposalId;
  readonly level: 'L1';
  readonly contractChecksum: string;
  readonly tasks: ReadonlyArray<ImplementationTask>;
  readonly deploymentOrdering: ReadonlyArray<DeploymentStep>;
}

export interface PlanInput {
  readonly proposalId: ChangeProposalId;
  readonly contractChecksum: string;
  readonly providerServiceId: ServiceId;
  readonly providerRequiredActions?: ReadonlyArray<{ readonly kind: string; readonly description: string }>;
  readonly consumerImpacts: ReadonlyArray<ConsumerImpactSummary>;
  readonly decisionRecordId?: DecisionRecordId | undefined;
}

export function generateImplementationPlan(input: PlanInput): ImplementationPlan {
  const tasks: ImplementationTask[] = [];
  const decision = input.decisionRecordId;

  for (const action of input.providerRequiredActions ?? []) {
    tasks.push({
      taskId: `task-provider-${tasks.length + 1}`,
      repositoryServiceId: input.providerServiceId,
      role: 'provider',
      kind: action.kind,
      description: action.description,
      source: { proposalId: input.proposalId, decisionRecordId: decision, requiredActionKind: action.kind },
      status: 'planned'
    });
  }

  for (const impact of input.consumerImpacts) {
    for (const action of impact.requiredActions) {
      tasks.push({
        taskId: `task-${impact.consumerServiceId}-${tasks.length + 1}`,
        repositoryServiceId: impact.consumerServiceId,
        role: 'consumer',
        kind: action.kind,
        description: action.description,
        source: { proposalId: input.proposalId, decisionRecordId: decision, requiredActionKind: action.kind },
        status: 'planned'
      });
    }
  }

  // Recommended deployment ordering: provider first, blocking consumers next,
  // action-required consumers last (mobile mapping ships last in the baseline).
  const blocking = input.consumerImpacts.filter((impact) => impact.impact === 'blocking').map((impact) => impact.consumerServiceId);
  const others = input.consumerImpacts.filter((impact) => impact.impact !== 'blocking').map((impact) => impact.consumerServiceId);
  const deploymentOrdering: DeploymentStep[] = [
    { order: 1, serviceId: input.providerServiceId, reason: 'provider ships the changed contract first' },
    ...blocking.map((serviceId, index) => ({ order: 2 + index, serviceId, reason: 'blocking consumer updates before the provider removes compatibility' })),
    ...others.map((serviceId, index) => ({ order: 2 + blocking.length + index, serviceId, reason: 'non-blocking consumer updates last' }))
  ];

  return { proposalId: input.proposalId, level: 'L1', contractChecksum: input.contractChecksum, tasks, deploymentOrdering };
}

// --- Guards ---

export type AutomationGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// L2/L3 operate on code and require an accepted proposal; L0/L1 (documents and
// analysis) may run earlier.
export function canStartAutomation(input: { readonly level: AutomationLevel; readonly proposalAccepted: boolean }): AutomationGuardResult {
  if ((input.level === 'L2' || input.level === 'L3') && !input.proposalAccepted) {
    return { ok: false, reason: 'issue #19: code patches and pull requests require an accepted change proposal (INV-018)' };
  }
  return { ok: true };
}

export type SensitiveCategory = 'monetary' | 'auth' | 'permissions' | 'pii' | 'data-deletion';

export interface SeparateApproval {
  readonly grantedBy: PrincipalRef;
  readonly reason: string;
}

// --- L2: reviewable patches ---

export interface CodePatch {
  readonly taskId: string;
  readonly repositoryServiceId: ServiceId;
  readonly filePath: string;
  readonly diffHunk: string;
  readonly source: {
    readonly proposalId: ChangeProposalId;
    readonly decisionRecordId?: DecisionRecordId | undefined;
    readonly taskId: string;
    readonly requiredActionKind: string;
  };
}

export interface PatchInput {
  readonly level: 'L2';
  readonly proposalAccepted: boolean;
  readonly task: ImplementationTask;
  readonly allowedFilePaths: ReadonlyArray<string>;
  readonly filePath: string;
  readonly changeSummary: string;
  readonly sensitiveCategory?: SensitiveCategory | undefined;
  readonly separateHumanApproval?: SeparateApproval | undefined;
}

export class AutomationViolation extends Error {
  constructor(readonly reason: string, readonly requireReapproval: boolean) {
    super(reason);
    this.name = 'AutomationViolation';
  }
}

export function generatePatch(input: PatchInput): CodePatch {
  const start = canStartAutomation({ level: input.level, proposalAccepted: input.proposalAccepted });
  if (!start.ok) {
    throw new AutomationViolation(start.reason, false);
  }
  if (!input.allowedFilePaths.includes(input.filePath)) {
    throw new AutomationViolation(
      `issue #19: file '${input.filePath}' is outside the approved change scope; re-approval is required`,
      true
    );
  }
  if (input.sensitiveCategory !== undefined && input.separateHumanApproval === undefined) {
    throw new AutomationViolation(
      `issue #19: a ${input.sensitiveCategory} change requires a separate human approval before a patch is generated`,
      true
    );
  }
  if (input.separateHumanApproval !== undefined && input.separateHumanApproval.grantedBy.kind !== 'human') {
    throw new AutomationViolation('issue #19: the separate approval must be granted by a human principal', false);
  }
  if (input.task.status !== 'planned') {
    throw new AutomationViolation(`issue #19: task '${input.task.taskId}' is already past the planning stage (${input.task.status})`, false);
  }

  const approver = input.separateHumanApproval?.grantedBy.id;
  const diffHunk = [
    `--- a/${input.filePath}`,
    `+++ b/${input.filePath}`,
    `@@ ${input.changeSummary}`,
    `+ [approved by ${input.task.source.decisionRecordId ?? 'n/a'}] ${input.task.description}`,
    ...(input.sensitiveCategory !== undefined ? [`+ [separate human approval by ${approver ?? 'unknown'} for ${input.sensitiveCategory}]`] : [])
  ].join('\n');

  return {
    taskId: input.task.taskId,
    repositoryServiceId: input.task.repositoryServiceId,
    filePath: input.filePath,
    diffHunk,
    source: {
      proposalId: input.task.source.proposalId,
      decisionRecordId: input.task.source.decisionRecordId,
      taskId: input.task.taskId,
      requiredActionKind: input.task.source.requiredActionKind
    }
  };
}

// --- L3: branch + pull request through a GitAdapter port ---

export interface PullRequestCreated {
  readonly pullRequestNumber: number;
  readonly url: string;
  readonly branch: string;
}

export interface GitAdapter {
  createBranch(input: { readonly repositoryServiceId: ServiceId; readonly branch: string; readonly base: string }): Promise<{ readonly branch: string }>;
  commitAndCreatePullRequest(input: {
    readonly repositoryServiceId: ServiceId;
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly patches: ReadonlyArray<CodePatch>;
  }): Promise<PullRequestCreated>;
}

// Deterministic in-memory adapter for tests and local runs; the real GitHub
// adapter is issue #13.
export class InMemoryGitAdapter implements GitAdapter {
  #counter = 0;
  readonly createdBranches: string[] = [];

  async createBranch(input: { readonly repositoryServiceId: ServiceId; readonly branch: string; readonly base: string }): Promise<{ readonly branch: string }> {
    this.createdBranches.push(input.branch);
    return { branch: input.branch };
  }

  async commitAndCreatePullRequest(input: {
    readonly repositoryServiceId: ServiceId;
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly patches: ReadonlyArray<CodePatch>;
  }): Promise<PullRequestCreated> {
    this.#counter += 1;
    return {
      pullRequestNumber: 400 + this.#counter,
      url: `https://git.example/${input.repositoryServiceId}/pull/${String(400 + this.#counter)}`,
      branch: input.branch
    };
  }
}

export function workBranchName(input: { readonly repositoryServiceId: ServiceId; readonly proposalId: ChangeProposalId }): string {
  return `accord/${input.proposalId}/${input.repositoryServiceId}`;
}

export async function createPullRequestForTasks(input: {
  readonly git: GitAdapter;
  readonly level: 'L3';
  readonly proposalAccepted: boolean;
  readonly proposalId: ChangeProposalId;
  readonly decisionRecordId?: DecisionRecordId | undefined;
  readonly contractVersionId: string;
  readonly contractChecksum: string;
  readonly defaultBranch: string;
  readonly repositoryServiceId: ServiceId;
  readonly tasks: ReadonlyArray<ImplementationTask>;
  readonly patches: ReadonlyArray<CodePatch>;
  readonly title: string;
}): Promise<PullRequestCreated> {
  const start = canStartAutomation({ level: input.level, proposalAccepted: input.proposalAccepted });
  if (!start.ok) {
    throw new AutomationViolation(start.reason, false);
  }
  const branch = workBranchName({ repositoryServiceId: input.repositoryServiceId, proposalId: input.proposalId });
  if (branch === input.defaultBranch || input.defaultBranch.length === 0) {
    throw new AutomationViolation('issue #19: automation never commits to the default branch', false);
  }
  await input.git.createBranch({ repositoryServiceId: input.repositoryServiceId, branch, base: input.defaultBranch });

  const body = [
    `Implements approved change proposal: ${input.proposalId}`,
    `Decision record: ${input.decisionRecordId ?? 'n/a'}`,
    `Contract version: ${input.contractVersionId} (checksum ${input.contractChecksum})`,
    `Tasks: ${input.tasks.map((task) => task.taskId).join(', ')}`
  ].join('\n');

  return input.git.commitAndCreatePullRequest({
    repositoryServiceId: input.repositoryServiceId,
    branch,
    base: input.defaultBranch,
    title: input.title,
    body,
    patches: input.patches
  });
}

// --- Runs, evidence linkage, staleness ---

export interface AutomationRun {
  readonly runId: string;
  readonly proposalId: ChangeProposalId;
  readonly level: AutomationLevel;
  readonly status: 'completed' | 'failed' | 'partial';
  readonly failureReason?: string | undefined;
  readonly taskIds: ReadonlyArray<string>;
}

export function canRerun(run: AutomationRun): AutomationGuardResult {
  if (run.status === 'completed') {
    return { ok: false, reason: 'issue #19: a completed automation run does not need to be re-run' };
  }
  return { ok: true };
}

// Test results from the automation run become evidence with honest statuses
// (INV-023): failed/skipped never map to passed.
export function testResultToEvidenceStatus(testPassed: boolean | undefined): 'passed' | 'failed' | 'not-run' {
  if (testPassed === undefined) {
    return 'not-run';
  }
  return testPassed ? 'passed' : 'failed';
}

export function isImplementationPlanStale(plan: ImplementationPlan, currentContractChecksum: string): { readonly stale: boolean; readonly reason: string } {
  if (plan.contractChecksum !== currentContractChecksum) {
    return { stale: true, reason: 'the contract changed after the plan was generated; recompute the plan and impact analysis' };
  }
  return { stale: false, reason: 'plan matches the current contract' };
}
