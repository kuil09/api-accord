// Consumer impact analysis (issue #11): combines the #10 diff engine with
// Dependency Edges (#6) to produce per-consumer impact levels with evidence
// paths, required-action drafts, and required reviewers — then pins the result
// to a Change Proposal as an auditable snapshot that goes stale when the inputs
// change. Impact "none" and "unknown" are distinct (INV-009): a consumer whose
// usage declaration carries no fields is unknown, never silently safe.

import type { StructuralDiffResult, ConsumerSemanticImpact } from './contract-diff.js';
import { assessConsumerSemanticImpact } from './contract-diff.js';
import type { DependencyEdge, ProposalWorkItem } from './model.js';
import type { ChangeProposalId, DependencyEdgeId, PrincipalRef, ServiceId, TeamId } from './primitives.js';

export type ImpactLevel = 'none' | 'informational' | 'action-required' | 'blocking' | 'unknown';

export type RequiredActionKind =
  | 'code-change'
  | 'unknown-enum-handling'
  | 'timeout-retry-adjustment'
  | 'contract-test'
  | 'deployment-ordering'
  | 'explicit-acknowledgement';

export interface RequiredAction {
  readonly kind: RequiredActionKind;
  readonly description: string;
  readonly evidencePath: string;
}

export interface RequiredReviewer {
  readonly teamId: TeamId;
  readonly reason: string;
}

export interface ConsumerImpact {
  readonly consumerServiceId: ServiceId;
  readonly edgeId: DependencyEdgeId;
  readonly impact: ImpactLevel;
  // confirmed: explicit usage declaration; unverified: the declaration carries no
  // fields, so "not affected" cannot be claimed (INV-009).
  readonly confidence: 'confirmed' | 'unverified';
  readonly reasons: ReadonlyArray<string>;
  // Evidence path: changed contract path -> consumer operation dependency.
  readonly evidencePath: ReadonlyArray<string>;
  readonly requiredActions: ReadonlyArray<RequiredAction>;
  readonly reviewers: ReadonlyArray<TeamId>;
  readonly semantic: ConsumerSemanticImpact;
}

export interface ImpactAnalysis {
  readonly impacts: ReadonlyArray<ConsumerImpact>;
  readonly requiredReviewers: ReadonlyArray<RequiredReviewer>;
}

export interface ImpactAnalysisInput {
  readonly diff: StructuralDiffResult;
  readonly edges: ReadonlyArray<DependencyEdge>;
  readonly providerTeamId: TeamId;
  readonly policyOwnerTeamIds?: ReadonlyArray<TeamId>;
}

// Operation keys affected by the diff, e.g. 'GET /payments/{paymentId}'.
function affectedOperationKeys(diff: StructuralDiffResult): ReadonlyArray<string> {
  const keys = new Set<string>();
  for (const finding of diff.findings) {
    keys.add(finding.affectedPath.split('#')[0] ?? '');
  }
  return [...keys].filter((key) => key.length > 0);
}

function edgeCoversOperation(edge: DependencyEdge, operationKeys: ReadonlyArray<string>): boolean {
  // The importer derives operation ids like 'contract:GET:/payments/{id}' while
  // diff paths use 'GET /payments/{id}'; normalize separators before matching.
  const normalized = edge.operationId.replace(/:/gu, ' ');
  return operationKeys.some((key) => normalized.includes(key) || edge.operationId.includes(key));
}

export function analyzeImpact(input: ImpactAnalysisInput): ImpactAnalysis {
  const operationKeys = affectedOperationKeys(input.diff);
  const impacts = input.edges.map((edge) => analyzeConsumer(input.diff, edge, operationKeys));

  const reviewers = new Map<string, RequiredReviewer>();
  const addReviewer = (teamId: TeamId, reason: string): void => {
    if (!reviewers.has(teamId)) {
      reviewers.set(teamId, { teamId, reason });
    }
  };
  addReviewer(input.providerTeamId, 'provider team owns the changed contract');
  for (const impact of impacts) {
    if (impact.impact === 'blocking' || impact.impact === 'action-required' || impact.impact === 'unknown') {
      for (const teamId of impact.reviewers) {
        addReviewer(teamId, `directly affected consumer team (${impact.consumerServiceId})`);
      }
    }
  }
  const critical = impacts.some((impact) => impact.semantic.blocking || impact.impact === 'blocking');
  if (critical) {
    for (const teamId of input.policyOwnerTeamIds ?? []) {
      addReviewer(teamId, 'security/data policy owner: a blocking consumer impact requires policy review');
    }
  }

  const sortedImpacts = impacts.slice().sort((left, right) => left.consumerServiceId.localeCompare(right.consumerServiceId));
  return { impacts: sortedImpacts, requiredReviewers: [...reviewers.values()] };
}

function analyzeConsumer(diff: StructuralDiffResult, edge: DependencyEdge, operationKeys: ReadonlyArray<string>): ConsumerImpact {
  const covered = edgeCoversOperation(edge, operationKeys);
  const semantic = assessConsumerSemanticImpact(diff, edge);
  // Evidence path: changed contract field -> operation -> consumer (issue #11).
  const evidencePath = [
    ...semantic.findings.map((finding) => finding.affectedPath),
    ...affectedOperationKeys(diff).filter((key) => edge.operationId.includes(key)),
    `consumer:${edge.consumerServiceId}`
  ];

  // INV-009: an empty usage declaration means "unknown", never "none".
  if (edge.usage.fields.length === 0) {
    return {
      consumerServiceId: edge.consumerServiceId,
      edgeId: edge.id,
      impact: 'unknown',
      confidence: 'unverified',
      reasons: ['the usage declaration records no fields, so impact cannot be determined'],
      evidencePath,
      requiredActions: [{ kind: 'explicit-acknowledgement', description: 'declare used fields for this dependency edge so impact can be computed', evidencePath: edge.operationId }],
      reviewers: edge.ownerTeamId === undefined ? [] : [edge.ownerTeamId],
      semantic
    };
  }

  if (!covered) {
    return {
      consumerServiceId: edge.consumerServiceId,
      edgeId: edge.id,
      impact: 'none',
      confidence: 'confirmed',
      reasons: ['the operations this consumer depends on were not changed'],
      evidencePath,
      requiredActions: [{ kind: 'explicit-acknowledgement', description: 'confirm the dependency is unaffected by this change', evidencePath: edge.operationId }],
      reviewers: [],
      semantic
    };
  }

  const reasons = semantic.findings.map((finding) => finding.evidence);
  let impact: ImpactLevel;
  if (semantic.blocking) {
    impact = 'blocking';
  } else if (semantic.actionRequired) {
    impact = 'action-required';
  } else if (semantic.findings.length > 0) {
    impact = 'informational';
  } else {
    impact = 'none';
  }

  const requiredActions = draftRequiredActions(semantic, edge, impact);
  return {
    consumerServiceId: edge.consumerServiceId,
    edgeId: edge.id,
    impact,
    confidence: edge.source === 'explicit' ? 'confirmed' : 'unverified',
    reasons: reasons.length > 0 ? reasons : ['operation changed but no consumer-specific rule matched'],
    evidencePath,
    requiredActions,
    reviewers: edge.ownerTeamId === undefined ? [] : [edge.ownerTeamId],
    semantic
  };
}

function draftRequiredActions(semantic: ConsumerSemanticImpact, edge: DependencyEdge, impact: ImpactLevel): ReadonlyArray<RequiredAction> {
  const actions: RequiredAction[] = [];
  const push = (kind: RequiredActionKind, description: string, evidencePath: string): void => {
    if (!actions.some((action) => action.kind === kind && action.evidencePath === evidencePath)) {
      actions.push({ kind, description, evidencePath });
    }
  };

  for (const finding of semantic.findings) {
    switch (finding.ruleId) {
      case 'semantic-unknown-enum':
        push('unknown-enum-handling', `handle unknown enum values on '${finding.affectedPath}' (${finding.evidence})`, finding.affectedPath);
        push('code-change', `update parsing/switch logic for '${finding.affectedPath}' (${finding.evidence})`, finding.affectedPath);
        push('contract-test', `add a contract test covering '${finding.affectedPath}'`, finding.affectedPath);
        break;
      case 'semantic-used-field-removed':
        push('code-change', `stop using removed field '${finding.affectedPath}' (${finding.evidence})`, finding.affectedPath);
        push('contract-test', `add a contract test covering '${finding.affectedPath}'`, finding.affectedPath);
        break;
      case 'semantic-required-field-assumed-present':
        push('code-change', `send the newly required field '${finding.affectedPath}' (${finding.evidence})`, finding.affectedPath);
        push('explicit-acknowledgement', `confirm the change to '${finding.affectedPath}'`, finding.affectedPath);
        break;
      case 'semantic-shape-changed-on-used-field':
        push('code-change', `adapt to the changed shape of '${finding.affectedPath}' (${finding.evidence})`, finding.affectedPath);
        push('contract-test', `add a contract test covering '${finding.affectedPath}'`, finding.affectedPath);
        break;
      case 'semantic-error-meaning-changed':
        push('code-change', `update status/error handling for '${finding.affectedPath}' (${finding.evidence})`, finding.affectedPath);
        push('deployment-ordering', `coordinate deployment order for '${finding.affectedPath}'`, finding.affectedPath);
        break;
      default:
        break;
    }
  }

  const opAffected = semantic.findings.length > 0;
  if (opAffected && edge.usage.timeoutExpectation !== undefined) {
    push('timeout-retry-adjustment', `re-verify timeout (${edge.usage.timeoutExpectation}) and retry (${edge.usage.retryExpectation ?? 'unspecified'}) expectations`, edge.operationId);
  }
  if (impact === 'blocking') {
    push('deployment-ordering', 'agree deployment ordering with the provider before the new contract goes live', edge.operationId);
  }
  if (impact === 'none') {
    push('explicit-acknowledgement', 'confirm the dependency is unaffected by this change', edge.operationId);
  }
  return actions;
}

// --- Snapshot pinning and staleness ---

export interface ImpactAnalysisSnapshot {
  readonly proposalId: ChangeProposalId;
  readonly computedAt: Date;
  readonly computedBy: PrincipalRef;
  // Input signatures at computation time; any change marks the analysis stale.
  readonly edgeSignatures: ReadonlyArray<{ readonly edgeId: DependencyEdgeId; readonly confirmedAt: Date }>;
  readonly impacts: ReadonlyArray<ConsumerImpact>;
}

export function pinImpactAnalysis(input: {
  proposalId: ChangeProposalId;
  computedBy: PrincipalRef;
  computedAt: Date;
  edges: ReadonlyArray<DependencyEdge>;
  impacts: ReadonlyArray<ConsumerImpact>;
}): ImpactAnalysisSnapshot {
  return {
    proposalId: input.proposalId,
    computedAt: input.computedAt,
    computedBy: input.computedBy,
    edgeSignatures: input.edges
      .map((edge) => ({ edgeId: edge.id, confirmedAt: edge.confirmedAt }))
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
    impacts: input.impacts
  };
}

export interface StalenessCheck {
  readonly stale: boolean;
  readonly reasons: ReadonlyArray<string>;
}

// INV-015: when the inputs change, the pinned analysis must not be returned as
// current. New consumers, re-confirmed edges and context corrections all make
// the analysis stale with an explicit reason.
export function isImpactAnalysisStale(
  snapshot: ImpactAnalysisSnapshot,
  currentEdges: ReadonlyArray<DependencyEdge>,
  contextCorrectedAt?: Date
): StalenessCheck {
  const reasons: string[] = [];
  const known = new Map(snapshot.edgeSignatures.map((signature) => [signature.edgeId, signature.confirmedAt]));

  for (const edge of currentEdges) {
    const recorded = known.get(edge.id);
    if (recorded === undefined) {
      reasons.push(`new consumer dependency '${edge.consumerServiceId}' registered after the analysis`);
      continue;
    }
    if (edge.confirmedAt.getTime() > recorded.getTime()) {
      reasons.push(`dependency edge for '${edge.consumerServiceId}' was re-confirmed after the analysis`);
    }
  }
  for (const signature of snapshot.edgeSignatures) {
    if (!currentEdges.some((edge) => edge.id === signature.edgeId)) {
      reasons.push(`dependency edge '${signature.edgeId}' was deprecated or removed after the analysis`);
    }
  }
  if (contextCorrectedAt !== undefined && contextCorrectedAt.getTime() > snapshot.computedAt.getTime()) {
    reasons.push('context items were corrected after the analysis');
  }

  return { stale: reasons.length > 0, reasons };
}

// A human may amend the computed analysis, but only with a reason and evidence;
// the amendment is appended to the ledger rather than overwriting (INV-012).
export function canAmendImpactAnalysis(input: { readonly reason: string; readonly evidence: string }): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.reason.trim().length === 0) {
    return { ok: false, reason: 'issue #11: amending an impact analysis requires an explicit reason' };
  }
  if (input.evidence.trim().length === 0) {
    return { ok: false, reason: 'issue #11: amending an impact analysis requires evidence' };
  }
  return { ok: true };
}

export type { ProposalWorkItem };
