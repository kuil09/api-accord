// AI Context Assembler (issue #18): assembles per-operation / per-proposal
// context bundles from the shared ledger, separated into honest sections
// (confirmed facts / assumptions / conflicts / stale / unsupported /
// contract-implementation-runtime mismatches / needs-human-review).
//
// Safety rules from the issue are structural here:
// - every claim carries a source reference or is flagged evidenceless
//   ("근거 없음") and routed to the unsupported section;
// - AI output is a draft with model/prompt/tool provenance (INV-017), never a
//   confirmed fact (INV-016);
// - a failing AI adapter leaves the core bundle intact and reports the failure
//   alongside the partial result (INV-019);
// - when input versions change, the pinned bundle goes stale (INV-015).

import type { EventEnvelope, DomainEvent } from './events.js';
import type { ContextItem } from './model.js';
import type { ChangeProposalId, PrincipalRef } from './primitives.js';
import { allContextItems, allDependencyEdges, decisionRecordFrom, detectContextConflicts } from './projection.js';
import { driftIncidentsFrom, type DriftIncident } from './observation.js';

// --- Provider-agnostic AI adapter ---

export interface AiCompletion {
  readonly text: string;
  readonly provider: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
}

export interface AiModelAdapter {
  readonly provider: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  complete(prompt: string): Promise<AiCompletion>;
}

// Deterministic fake for tests and local runs: echoes a fixed draft so the
// harness is reproducible (issue #12-style determinism, applied to AI).
export class FakeAiModel implements AiModelAdapter {
  readonly provider = 'fake';
  readonly modelVersion = 'fake-model-1';
  readonly promptVersion = 'draft-v1';

  constructor(private readonly scriptedText: string) {}

  async complete(_prompt: string): Promise<AiCompletion> {
    return { text: this.scriptedText, provider: this.provider, modelVersion: this.modelVersion, promptVersion: this.promptVersion, };
  }
}

// Simulates an AI outage: the assembler must keep the core bundle intact and
// report the failure beside the partial result (INV-019).
export class FailingAiModel implements AiModelAdapter {
  readonly provider = 'failing';
  readonly modelVersion = 'failing-model-1';
  readonly promptVersion = 'draft-v1';

  async complete(_prompt: string): Promise<AiCompletion> {
    throw new Error('simulated model outage');
  }
}

// --- Claims and bundle ---

export interface BundleClaim {
  readonly statement: string;
  // Author provenance: AI vs human vs runtime is visually distinguished in the
  // UI (issue #18/#20 completion condition).
  readonly author?: PrincipalRef | undefined;
  readonly confidence: 'confirmed' | 'unverified' | 'inferred' | 'disputed';
  // Source reference (e.g. 'context:ctx-1', 'edge:edge-1', 'decision:dec-1',
  // 'drift:<incidentId>'); evidenceless claims carry no sourceRef.
  readonly sourceRef?: string | undefined;
  readonly evidenceless: boolean;
}

export interface ClaimConflict {
  readonly claimA: BundleClaim;
  readonly claimB: BundleClaim;
}

export interface ContextBundleSections {
  readonly confirmedFacts: ReadonlyArray<BundleClaim>;
  readonly assumptions: ReadonlyArray<BundleClaim>;
  readonly conflicts: ReadonlyArray<ClaimConflict>;
  readonly stale: ReadonlyArray<BundleClaim>;
  readonly unsupported: ReadonlyArray<BundleClaim>;
  readonly mismatches: ReadonlyArray<BundleClaim>;
  readonly needsHumanReview: ReadonlyArray<BundleClaim>;
}

export interface BundleInputSignature {
  readonly kind: 'dependency-edge' | 'context-item';
  readonly id: string;
  readonly version: Date;
}

export interface ContextBundle {
  readonly proposalId?: ChangeProposalId | undefined;
  readonly operationKey?: string | undefined;
  readonly computedAt: Date;
  readonly computedBy: PrincipalRef;
  readonly sections: ContextBundleSections;
  readonly inputSignatures: ReadonlyArray<BundleInputSignature>;
  readonly aiDraft?: { readonly text: string; readonly provenance: { readonly provider: string; readonly modelVersion: string; readonly promptVersion: string }; readonly evidenceless: true } | undefined;
  readonly aiFailure?: string | undefined;
}

// --- Assembly ---

export interface AssembleInput {
  readonly events: ReadonlyArray<EventEnvelope<DomainEvent>>;
  readonly computedBy: PrincipalRef;
  readonly now: Date;
  readonly proposalId?: ChangeProposalId | undefined;
  readonly operationKey?: string | undefined;
  readonly ai?: AiModelAdapter | undefined;
}

function claimFromContextItem(item: ContextItem): BundleClaim {
  return {
    statement: item.statement,
    author: item.author,
    confidence: item.confidence,
    sourceRef: item.source.trim().length > 0 ? `context:${item.id} via ${item.source}` : undefined,
    evidenceless: item.source.trim().length === 0
  };
}

export function assembleContextBundle(input: AssembleInput): ContextBundle {
  const items = allContextItems(input.events).filter((item) => {
    if (input.proposalId !== undefined || input.operationKey !== undefined) {
      // Bundles are scoped; items declared at operation scope are always in
      // scope for an operation bundle. Proposal bundles include everything.
      return input.proposalId !== undefined || item.scope === 'operation';
    }
    return true;
  });

  const confirmedFacts: BundleClaim[] = [];
  const assumptions: BundleClaim[] = [];
  const stale: BundleClaim[] = [];
  const unsupported: BundleClaim[] = [];
  const needsHumanReview: BundleClaim[] = [];

  for (const item of items) {
    const claim = claimFromContextItem(item);
    if (claim.evidenceless) {
      unsupported.push(claim);
      // INV-016: an AI-authored claim with no evidence additionally needs human
      // review before anyone may act on it.
      if (item.author.kind === 'agent') {
        needsHumanReview.push(claim);
      }
      continue;
    }
    if (item.correctedBy !== undefined || item.supersededBy !== undefined || (item.validUntil !== undefined && item.validUntil.getTime() < input.now.getTime())) {
      stale.push(claim);
      continue;
    }
    if (item.disputed) {
      needsHumanReview.push(claim);
      continue;
    }
    if (item.confidence === 'confirmed') {
      confirmedFacts.push(claim);
      continue;
    }
    // INV-016: AI-authored unverified/inferred claims land in assumptions and
    // additionally need human review before they can be promoted.
    assumptions.push(claim);
    if (item.author.kind === 'agent') {
      needsHumanReview.push(claim);
    }
  }

  // Contradictions between context items (INV-008, INV-014).
  const conflicts: ClaimConflict[] = detectContextConflicts(items).map(([idA, idB]) => {
    const itemA = items.find((item) => item.id === idA);
    const itemB = items.find((item) => item.id === idB);
    return {
      claimA: claimFromContextItem(itemA as ContextItem),
      claimB: claimFromContextItem(itemB as ContextItem)
    };
  });
  for (const conflict of conflicts) {
    needsHumanReview.push(conflict.claimA, conflict.claimB);
  }

  // Contract/implementation/runtime mismatches come from open drift incidents.
  const incidents = driftIncidentsFrom(input.events).filter((incident) => incident.status === 'open' && (input.operationKey === undefined || incident.operationId.includes(input.operationKey)));
  const mismatches: BundleClaim[] = incidents.map((incident: DriftIncident) => ({
    statement: `${incident.kind} observed on '${incident.operationId}' in ${incident.environment} against ${incident.contractVersionId} @ ${incident.deploymentRevision} (${String(incident.occurrences)} occurrence(s))`,
    author: { kind: 'integration', id: 'runtime-observer' },
    confidence: 'confirmed' as const,
    sourceRef: `drift:${incident.incidentId}`,
    evidenceless: false
  }));

  const decisionClaims = decisionClaimsFrom(input.events);
  confirmedFacts.push(...decisionClaims.confirmed);
  stale.push(...decisionClaims.superseded);

  const inputSignatures: BundleInputSignature[] = [
    ...allDependencyEdges(input.events).map((edge) => ({ kind: 'dependency-edge' as const, id: edge.id, version: edge.confirmedAt })),
    ...items.map((item) => ({ kind: 'context-item' as const, id: item.id, version: item.correctedAt ?? item.validFrom }))
  ];

  return {
    proposalId: input.proposalId,
    operationKey: input.operationKey,
    computedAt: input.now,
    computedBy: input.computedBy,
    sections: { confirmedFacts, assumptions, conflicts, stale, unsupported, mismatches, needsHumanReview },
    inputSignatures
  };
}

// --- Staleness (INV-015) ---

export function isContextBundleStale(bundle: ContextBundle, currentEvents: ReadonlyArray<EventEnvelope<DomainEvent>>): { readonly stale: boolean; readonly reasons: ReadonlyArray<string> } {
  const reasons: string[] = [];
  const recorded = new Map(bundle.inputSignatures.map((signature) => [`${signature.kind}:${signature.id}`, signature.version]));

  for (const edge of allDependencyEdges(currentEvents)) {
    const recordedVersion = recorded.get(`dependency-edge:${edge.id}`);
    if (recordedVersion === undefined) {
      reasons.push(`new dependency edge '${edge.id}' registered after the bundle`);
    } else if (edge.confirmedAt.getTime() > recordedVersion.getTime()) {
      reasons.push(`dependency edge '${edge.id}' was re-confirmed after the bundle`);
    }
  }
  for (const item of allContextItems(currentEvents)) {
    const key = `context-item:${item.id}`;
    const currentVersion = item.correctedAt ?? item.validFrom;
    const recordedVersion = recorded.get(key);
    if (recordedVersion === undefined) {
      if (item.validFrom.getTime() > bundle.computedAt.getTime() || item.correctedAt !== undefined) {
        reasons.push(`new context item '${item.id}' added after the bundle`);
      }
      continue;
    }
    if (currentVersion.getTime() > recordedVersion.getTime()) {
      reasons.push(`context item '${item.id}' was corrected after the bundle`);
    }
  }
  return { stale: reasons.length > 0, reasons };
}

// --- Decision/Proposal draft assistant (INV-016, INV-017, INV-019) ---

export async function draftProposalAssistance(bundle: ContextBundle, ai: AiModelAdapter): Promise<{ readonly draft?: string | undefined; readonly failure?: string | undefined; readonly provenance?: { readonly provider: string; readonly modelVersion: string; readonly promptVersion: string } | undefined }> {
  const prompt = [
    'Draft a change-proposal summary. Use only the confirmed facts below;',
    'never present inferences as facts. Confirmed facts:',
    ...bundle.sections.confirmedFacts.map((claim) => `- ${claim.statement} [${claim.sourceRef ?? 'no source'}]`)
  ].join('\n');
  try {
    const completion = await ai.complete(prompt);
    return { draft: completion.text, provenance: { provider: completion.provider, modelVersion: completion.modelVersion, promptVersion: completion.promptVersion } };
  } catch (error) {
    // INV-019: the AI failure is reported; the core bundle stays intact.
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

// Decision Records feed the bundle: the current decision is a confirmed fact,
// and a superseded decision moves to the stale section with its lineage
// (issue #18 fixture: 과거 결정이 새 결정으로 대체된 경우).
export function decisionClaimsFrom(events: ReadonlyArray<EventEnvelope<DomainEvent>>): { readonly confirmed: ReadonlyArray<BundleClaim>; readonly superseded: ReadonlyArray<BundleClaim> } {
  const ids = new Set<string>();
  for (const envelope of events) {
    if (envelope.aggregateType === 'decisionRecord') {
      ids.add(envelope.aggregateId);
    }
  }
  const confirmed: BundleClaim[] = [];
  const superseded: BundleClaim[] = [];
  for (const id of ids) {
    const record = decisionRecordFrom(events, id as Parameters<typeof decisionRecordFrom>[1]);
    if (record === undefined) {
      continue;
    }
    const claim: BundleClaim = {
      statement: `Decision: ${record.decision} (approvers: ${record.approvers.map((approver) => approver.id).join(', ')})`,
    author: record.approvers[0],
      confidence: 'confirmed',
      sourceRef: `decision:${record.id}`,
      evidenceless: false
    };
    if (record.supersededBy !== undefined) {
      superseded.push(claim);
    } else {
      confirmed.push(claim);
    }
  }
  return { confirmed, superseded };
}
