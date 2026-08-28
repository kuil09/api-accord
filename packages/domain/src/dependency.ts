// Consumer dependency edges, structured usage, and hidden assumptions (issue #6).
//
// Framework-independent. Tracks which Operation a consumer depends on, the fields
// it uses, the assumptions it holds, and the compatibility policy it allows.
// Conflicting assumptions from different consumers are preserved, not averaged
// (INV-008). Every edge records its source (explicit / code-analysis /
// runtime-observation) and last-confirmed time (INV-010).

import type {
  DependencyEdgeId,
  OperationId,
  PrincipalRef,
  ServiceId,
  TeamId
} from './primitives.js';
import type { AppendResult, AggregateType, EventStore } from './events.js';
import type { CompatibilityPolicy, DependencyAssumption, DependencySource, UsageDeclaration } from './model.js';

export interface DeclareDependencyInput {
  actor: PrincipalRef;
  correlationId?: string;
  edgeId: DependencyEdgeId;
  consumerServiceId: ServiceId;
  operationId: OperationId;
  usage: UsageDeclaration;
  compatibility: CompatibilityPolicy;
  criticality: 'low' | 'medium' | 'high' | 'critical';
  source: DependencySource;
  ownerTeamId?: TeamId | undefined;
}

export class DependencyService {
  readonly #store: EventStore;

  constructor(store: EventStore) {
    this.#store = store;
  }

  async declareDependency(input: DeclareDependencyInput & { assumptions?: ReadonlyArray<Omit<DependencyAssumption, 'id'>> }): Promise<AppendResult> {
    const baseEvent = {
      type: 'DependencyEdgeDeclared' as const,
      edgeId: input.edgeId,
      consumerServiceId: input.consumerServiceId,
      operationId: input.operationId,
      usage: input.usage,
      compatibility: input.compatibility,
      source: input.source,
      criticality: input.criticality,
      ...(input.ownerTeamId === undefined ? {} : { ownerTeamId: input.ownerTeamId })
    };
    const result = await this.#append('dependencyEdge', input.edgeId, input.actor, input.correlationId, baseEvent);

    for (const assumption of input.assumptions ?? []) {
      const assumptionId = `${input.edgeId}:${assumption.statement}`;
      await this.#append('dependencyEdge', input.edgeId, input.actor, input.correlationId, {
        type: 'DependencyAssumptionAdded',
        edgeId: input.edgeId,
        assumptionId,
        statement: assumption.statement,
        source: assumption.source,
        confidence: assumption.confidence,
        conflictStatus: assumption.conflictStatus
      });
    }

    return result;
  }

  async addAssumption(input: {
    actor: PrincipalRef;
    correlationId?: string;
    edgeId: DependencyEdgeId;
    statement: string;
    source: DependencySource;
    confidence: DependencyAssumption['confidence'];
    conflictStatus?: 'none' | 'conflicting';
  }): Promise<AppendResult> {
    const assumptionId = `${input.edgeId}:${input.statement}`;
    return this.#append('dependencyEdge', input.edgeId, input.actor, input.correlationId, {
      type: 'DependencyAssumptionAdded',
      edgeId: input.edgeId,
      assumptionId,
      statement: input.statement,
      source: input.source,
      confidence: input.confidence,
      conflictStatus: input.conflictStatus ?? 'none'
    });
  }

  async deprecateEdge(input: {
    actor: PrincipalRef;
    correlationId?: string;
    edgeId: DependencyEdgeId;
    reason: string;
  }): Promise<AppendResult> {
    return this.#append('dependencyEdge', input.edgeId, input.actor, input.correlationId, {
      type: 'DependencyEdgeDeprecated',
      edgeId: input.edgeId,
      reason: input.reason
    });
  }

  async #append(
    aggregateType: AggregateType,
    aggregateId: string,
    actor: PrincipalRef,
    correlationId: string | undefined,
    event: Parameters<EventStore['append']>[0]['event']
  ): Promise<AppendResult> {
    const expectedVersion = await this.#currentVersion(aggregateType, aggregateId);
    return this.#store.append({
      actor,
      correlationId: correlationId ?? 'dependency-service',
      event,
      expectedVersion
    });
  }

  async #currentVersion(aggregateType: AggregateType, aggregateId: string): Promise<number> {
    const stream = await this.#store.getStream(aggregateType, aggregateId);
    const last = stream[stream.length - 1];
    return last?.version ?? 0;
  }
}
