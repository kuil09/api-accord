// MCP tool dispatch (issue #14): the official agent interface over the SAME
// domain services and permission policies the Web UI uses (INV-029). Tools are
// thin: scope check (#4 hasScope) -> domain command -> structured result or a
// typed error. Mutation tools accept an idempotency key; replays return the
// recorded result instead of executing twice.

import {
  CompileError,
  DomainRuleError,
  OpenApiCompilerAdapter,
  allContextItems,
  allDependencyEdges,
  changeProposalState,
  decisionRecordFrom,
  discussionSummary,
  hasScope,
  isImpactAnalysisStale,
  queryContext,
  type ApiContractId,
  type ChangeProposalId,
  type ContextItemId,
  type ContextScope,
  type DecisionRecordId,
  type DiscussionEntryId,
  type DomainService,
  type EventStore,
  type EventEnvelope,
  type DomainEvent,
  type Scope,
  type PrincipalRef
} from '@api-accord/domain';
import { McpError, type McpErrorCode } from './errors.js';

export interface McpCaller {
  readonly actor: PrincipalRef;
  readonly grantedScopes: ReadonlyArray<Scope>;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly requiredScope: Scope;
  readonly mutates: boolean;
  readonly idempotencyKeyRequired: boolean;
  readonly inputSchema: Record<string, unknown>;
}

export type McpResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: McpErrorCode; readonly message: string };

const stringArg = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new McpError('invalid-input', `missing required string argument '${key}'`);
  }
  return value;
};

const CONTEXT_SCOPES: ReadonlyArray<ContextScope> = ['organization', 'service', 'apiContract', 'operation', 'dependencyEdge', 'changeProposal'];

export const MCP_TOOL_DESCRIPTORS: ReadonlyArray<McpToolDescriptor> = [
  { name: 'get_api_context', description: 'List context items for a scope', requiredScope: 'context:read', mutates: false, idempotencyKeyRequired: false, inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: [...CONTEXT_SCOPES] } }, required: ['scope'] } },
  { name: 'get_operation_context', description: 'Context items, dependency edges and assumptions for one operation', requiredScope: 'context:read', mutates: false, idempotencyKeyRequired: false, inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'] } },
  { name: 'get_consumer_assumptions', description: 'Per-consumer assumptions for one operation, conflicts preserved (INV-008)', requiredScope: 'context:read', mutates: false, idempotencyKeyRequired: false, inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: ['operationId'] } },
  { name: 'trace_dependency_impact', description: 'Return the pinned impact analysis of a proposal, stale-marked (INV-015)', requiredScope: 'context:read', mutates: false, idempotencyKeyRequired: false, inputSchema: { type: 'object', properties: { proposalId: { type: 'string' } }, required: ['proposalId'] } },
  { name: 'create_change_proposal', description: 'Open a change proposal', requiredScope: 'proposal:create', mutates: true, idempotencyKeyRequired: true, inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, contractId: { type: 'string' }, title: { type: 'string' } }, required: ['proposalId', 'contractId', 'title'] } },
  { name: 'comment_on_proposal', description: 'Add a structured discussion entry', requiredScope: 'proposal:comment', mutates: true, idempotencyKeyRequired: true, inputSchema: { type: 'object', properties: { entryId: { type: 'string' }, proposalId: { type: 'string' }, kind: { type: 'string' }, body: { type: 'string' } }, required: ['entryId', 'proposalId', 'kind', 'body'] } },
  { name: 'confirm_context', description: 'Confirm a context item (human approvers only, INV-016)', requiredScope: 'context:correct', mutates: true, idempotencyKeyRequired: true, inputSchema: { type: 'object', properties: { contextItemId: { type: 'string' }, validFrom: { type: 'string' }, source: { type: 'string' } }, required: ['contextItemId', 'validFrom', 'source'] } },
  { name: 'challenge_context', description: 'Dispute a context item without mutating it', requiredScope: 'context:propose', mutates: true, idempotencyKeyRequired: true, inputSchema: { type: 'object', properties: { contextItemId: { type: 'string' }, reason: { type: 'string' } }, required: ['contextItemId', 'reason'] } },
  { name: 'correct_context', description: 'Correct a context item; the original is preserved (INV-012)', requiredScope: 'context:correct', mutates: true, idempotencyKeyRequired: true, inputSchema: { type: 'object', properties: { originalContextItemId: { type: 'string' }, correctionContextItemId: { type: 'string' } }, required: ['originalContextItemId', 'correctionContextItemId'] } },
  { name: 'compile_spec', description: 'Compile an accepted proposal into spec/changelog/migration/test artifacts', requiredScope: 'spec:compile', mutates: false, idempotencyKeyRequired: false, inputSchema: { type: 'object', properties: { proposalId: { type: 'string' }, baseContract: { type: 'object' }, approvedChanges: { type: 'array' } }, required: ['proposalId', 'baseContract', 'approvedChanges'] } },
  { name: 'list_pending_actions', description: 'List open proposals, blocking objections and unresolved questions', requiredScope: 'context:read', mutates: false, idempotencyKeyRequired: false, inputSchema: { type: 'object', properties: {} } }
];

export interface ApiAccordMcpServerOptions {
  readonly store: EventStore;
  readonly domain: DomainService;
}

export class ApiAccordMcpServer {
  readonly #store: EventStore;
  readonly #domain: DomainService;
  readonly #idempotency = new Map<string, McpResult>();

  constructor(options: ApiAccordMcpServerOptions) {
    this.#store = options.store;
    this.#domain = options.domain;
  }

  listTools(): ReadonlyArray<McpToolDescriptor> {
    return MCP_TOOL_DESCRIPTORS;
  }

  async dispatch(input: {
    readonly tool: string;
    readonly caller: McpCaller;
    readonly args: Record<string, unknown>;
    readonly idempotencyKey?: string;
  }): Promise<McpResult> {
    const descriptor = MCP_TOOL_DESCRIPTORS.find((candidate) => candidate.name === input.tool);
    if (descriptor === undefined) {
      return { ok: false, code: 'invalid-input', message: `unknown tool '${input.tool}'` };
    }
    if (!hasScope(input.caller.grantedScopes, descriptor.requiredScope)) {
      return { ok: false, code: 'denied-scope', message: `caller lacks the '${descriptor.requiredScope}' scope required by '${input.tool}'` };
    }
    if (descriptor.mutates && input.idempotencyKey !== undefined) {
      const cached = this.#idempotency.get(input.idempotencyKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    let result: McpResult;
    try {
      result = { ok: true, data: await this.#execute(descriptor.name, input.caller, input.args) };
    } catch (error) {
      if (error instanceof McpError) {
        result = { ok: false, code: error.code, message: error.message };
      } else if (error instanceof DomainRuleError) {
        result = { ok: false, code: 'domain-rule-violated', message: error.reason };
      } else if (error instanceof CompileError) {
        result = { ok: false, code: 'domain-rule-violated', message: error.message };
      } else {
        result = { ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) };
      }
    }

    if (descriptor.mutates && input.idempotencyKey !== undefined) {
      this.#idempotency.set(input.idempotencyKey, result);
    }
    return result;
  }

  async #execute(tool: string, caller: McpCaller, args: Record<string, unknown>): Promise<unknown> {
    switch (tool) {
      case 'get_api_context': {
        const scope = stringArg(args, 'scope');
        if (!CONTEXT_SCOPES.includes(scope as ContextScope)) {
          throw new McpError('invalid-input', `unknown context scope '${scope}'`);
        }
        return queryContext(allContextItems(await this.#store.getAll()), { scope: scope as ContextScope }, new Date());
      }
      case 'get_operation_context': {
        const operationId = stringArg(args, 'operationId');
        const edges = allDependencyEdges(await this.#store.getAll()).filter((edge) => edge.operationId.includes(operationId));
        return {
          operationId,
          dependencyEdges: edges,
          operationContextItems: allContextItems(await this.#store.getAll()).filter((item) => item.scope === 'operation')
        };
      }
      case 'get_consumer_assumptions': {
        const operationId = stringArg(args, 'operationId');
        return allDependencyEdges(await this.#store.getAll())
          .filter((edge) => edge.operationId.includes(operationId))
          .map((edge) => ({
            consumerServiceId: edge.consumerServiceId,
            assumptions: edge.assumptions,
            compatibility: edge.compatibility,
            confirmedAt: edge.confirmedAt
          }));
      }
      case 'trace_dependency_impact': {
        const proposalId = stringArg(args, 'proposalId');
        const all = await this.#store.getAll();
        const recorded = all
          .filter((envelope): envelope is typeof envelope => envelope.event.type === 'ImpactAnalysisRecorded' && envelope.aggregateId === proposalId)
          .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
        const latest = recorded[recorded.length - 1];
        if (latest === undefined || latest.event.type !== 'ImpactAnalysisRecorded') {
          throw new McpError('not-found', `no impact analysis has been recorded for proposal '${proposalId}'`);
        }
        const snapshot = latest.event.snapshot;
        const staleness = isImpactAnalysisStale(snapshot, allDependencyEdges(all));
        return { impacts: snapshot.impacts, computedAt: snapshot.computedAt, stale: staleness.stale, staleReasons: staleness.reasons };
      }
      case 'create_change_proposal': {
        return this.#domain.openChangeProposal({
          actor: caller.actor,
          proposalId: args['proposalId'] as ChangeProposalId,
          contractId: args['contractId'] as ApiContractId,
          title: stringArg(args, 'title')
        });
      }
      case 'comment_on_proposal': {
        return this.#domain.createDiscussionEntry({
          actor: caller.actor,
          entryId: args['entryId'] as DiscussionEntryId,
          proposalId: args['proposalId'] as ChangeProposalId,
          kind: stringArg(args, 'kind') as 'question' | 'proposal' | 'objection' | 'constraint' | 'assumption' | 'evidence' | 'alternative' | 'correction' | 'acknowledgement' | 'decision',
          body: stringArg(args, 'body')
        });
      }
      case 'confirm_context': {
        return this.#domain.confirmContext({
          actor: caller.actor,
          contextItemId: args['contextItemId'] as ContextItemId,
          validFrom: new Date(stringArg(args, 'validFrom')),
          source: stringArg(args, 'source')
        });
      }
      case 'challenge_context': {
        return this.#domain.challengeContext({
          actor: caller.actor,
          contextItemId: args['contextItemId'] as ContextItemId,
          reason: stringArg(args, 'reason')
        });
      }
      case 'correct_context': {
        return this.#domain.correctContext({
          actor: caller.actor,
          originalContextItemId: args['originalContextItemId'] as ContextItemId,
          correctionContextItemId: args['correctionContextItemId'] as ContextItemId
        });
      }
      case 'compile_spec': {
        const proposalId = stringArg(args, 'proposalId');
        const all = await this.#store.getAll();
        const state = changeProposalState(all, proposalId as ChangeProposalId);
        if (state === undefined) {
          throw new McpError('not-found', `proposal '${proposalId}' not found`);
        }
        if (args['baseContract'] === undefined || args['approvedChanges'] === undefined) {
          throw new McpError('invalid-input', 'compile_spec requires baseContract and approvedChanges arguments');
        }
        const decisions = all
          .filter((envelope) => envelope.aggregateType === 'decisionRecord')
          .map((envelope) => envelope.aggregateId)
          .filter((id, index, ids) => ids.indexOf(id) === index)
          .map((id) => decisionRecordFrom(all, id as DecisionRecordId))
          .filter((record): record is NonNullable<typeof record> => record !== undefined && record.proposalId === proposalId);
        const entryIds: DiscussionEntryId[] = [];
        for (const envelope of all) {
          if (envelope.aggregateType === 'discussionEntry' && envelope.event.type === 'DiscussionEntryCreated' && envelope.event.proposalId === proposalId) {
            entryIds.push(envelope.event.entryId);
          }
        }
        return new OpenApiCompilerAdapter().compile({
          proposalId: proposalId as ChangeProposalId,
          proposalState: state,
          decisions,
          discussion: discussionSummary(all, entryIds),
          baseContract: args['baseContract'] as Parameters<OpenApiCompilerAdapter['compile']>[0]['baseContract'],
          approvedChanges: args['approvedChanges'] as Parameters<OpenApiCompilerAdapter['compile']>[0]['approvedChanges'],
          impacts: [],
          compiledBy: caller.actor
        });
      }
      case 'list_pending_actions': {
        return listPendingActions(await this.#store.getAll());
      }
      default:
        throw new McpError('not-implemented', `tool '${tool}' is not implemented`);
    }
  }
}

export interface PendingActionSummary {
  readonly proposalId: ChangeProposalId;
  readonly title: string;
  readonly accepted: boolean;
  readonly openBlockingObjections: number;
  readonly unresolvedQuestions: ReadonlyArray<string>;
}

// INV-014: unresolved questions and blocking objections are listed, never
// silently dropped from the agent's pending view.
function listPendingActions(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ReadonlyArray<PendingActionSummary> {
  const ids = new Set<ChangeProposalId>();
  const entriesByProposal = new Map<ChangeProposalId, DiscussionEntryId[]>();
  for (const envelope of events) {
    if (envelope.aggregateType === 'changeProposal') {
      ids.add(envelope.aggregateId as ChangeProposalId);
    }
    if (envelope.aggregateType === 'discussionEntry' && envelope.event.type === 'DiscussionEntryCreated') {
      const list = entriesByProposal.get(envelope.event.proposalId) ?? [];
      list.push(envelope.event.entryId);
      entriesByProposal.set(envelope.event.proposalId, list);
    }
  }
  const pending: PendingActionSummary[] = [];
  for (const proposalId of ids) {
    const state = changeProposalState(events, proposalId);
    if (state === undefined || state.phase === 'closed') {
      continue;
    }
    const summary = discussionSummary(events, entriesByProposal.get(proposalId) ?? []);
    pending.push({
      proposalId,
      title: state.title,
      accepted: state.accepted,
      openBlockingObjections: state.openBlockingObjections,
      unresolvedQuestions: summary.unresolvedQuestions.map((question) => question.body)
    });
  }
  return pending.sort((left, right) => left.proposalId.localeCompare(right.proposalId));
}
