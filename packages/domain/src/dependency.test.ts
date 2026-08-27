import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryEventStore } from './events.js';
import { dependencyEdgeFrom, findConflictingAssumptions } from './projection.js';
import { DependencyService } from './dependency.js';
import { dependencyEdgeId, operationId, principalRef, serviceId, teamId } from './primitives.js';
import type { DependencyEdge } from './model.js';

const actor = principalRef('human', 'tester');

describe('DependencyService', () => {
  it('declares an edge with structured usage and preserves assumptions (INV-008)', async () => {
    const store = new InMemoryEventStore();
    const service = new DependencyService(store);
    const edge = dependencyEdgeId('edge-1');
    const op = operationId('contract-1:GET:/payments/{id}');

    await service.declareDependency({
      actor,
      edgeId: edge,
      consumerServiceId: serviceId('merchant-console'),
      operationId: op,
      usage: {
        fields: ['id', 'status', 'approvedAt'],
        statusValues: ['APPROVED'],
        enumNullability: [],
        errorMeanings: ['404 means not created'],
        timeoutExpectation: '500ms',
        retryExpectation: '3 times',
        idempotencyExpectation: 'idempotent',
        orderingConsistencySideEffects: []
      },
      compatibility: { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false },
      criticality: 'high',
      source: 'explicit',
      ownerTeamId: teamId('team-1'),
      assumptions: [
        { statement: 'status APPROVED implies approvedAt exists', source: 'explicit', confidence: 'confirmed', conflictStatus: 'none' }
      ]
    });

    const all = await store.getAll();
    const reconstructed = dependencyEdgeFrom(all, edge);
    assert.ok(reconstructed);
    if (reconstructed) {
      assert.equal(reconstructed.criticality, 'high');
      assert.equal(reconstructed.source, 'explicit');
      assert.ok(reconstructed.usage.fields[0] === 'id' && reconstructed.usage.fields[1] === 'status' && reconstructed.usage.fields[2] === 'approvedAt', 'usage fields preserved');
      assert.equal(reconstructed.assumptions.length, 1);
      assert.equal(reconstructed.assumptions[0]?.statement, 'status APPROVED implies approvedAt exists');
    }
    assert.ok(all.some((e) => e.event.type === 'DependencyEdgeDeclared'));
  });

  it('records source and is deprecated without destroying history', async () => {
    const store = new InMemoryEventStore();
    const service = new DependencyService(store);
    const edge = dependencyEdgeId('edge-2');
    await service.declareDependency({
      actor,
      edgeId: edge,
      consumerServiceId: serviceId('svc'),
      operationId: operationId('contract-1:GET:/x'),
      usage: { fields: [], statusValues: [], enumNullability: [], errorMeanings: [], orderingConsistencySideEffects: [] },
      compatibility: { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false },
      criticality: 'low',
      source: 'code-analysis'
    });
    await service.deprecateEdge({ actor, edgeId: edge, reason: 'unused' });

    const all = await store.getAll();
    const reconstructed = dependencyEdgeFrom(all, edge);
    assert.ok(reconstructed);
    if (reconstructed) {
      assert.equal(reconstructed.deprecated, true, 'deprecation does not delete the edge');
      assert.equal(reconstructed.source, 'code-analysis');
    }
    // The original declared event remains in the ledger.
    assert.ok(all.some((e) => e.event.type === 'DependencyEdgeDeclared'));
  });
});

describe('conflicting assumptions (INV-008)', () => {
  function edgeWith(edgeId: string, statement: string): DependencyEdge {
    return {
      id: dependencyEdgeId(edgeId),
      consumerServiceId: serviceId('c'),
      operationId: operationId('contract-1:GET:/x'),
      usage: { fields: [], statusValues: [], enumNullability: [], errorMeanings: [], orderingConsistencySideEffects: [] },
      assumptions: [{ id: 'a1', statement, source: 'explicit', confidence: 'confirmed', conflictStatus: 'none' }],
      compatibility: { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false },
      criticality: 'medium',
      source: 'explicit',
      confirmedAt: new Date(),
      deprecated: false
    };
  }

  it('keeps opposing assumptions visible rather than merging them', () => {
    const edges = [
      edgeWith('e1', 'status is always present'),
      edgeWith('e2', 'status is not always present')
    ];
    const conflicts = findConflictingAssumptions(edges);
    assert.equal(conflicts.length, 1, 'contradictory statements are flagged as conflicting');
    assert.equal(conflicts[0]?.[0], 'e1');
    assert.equal(conflicts[0]?.[2], 'e2');
  });

  it('does not flag identical statements as conflicts', () => {
    const edges = [edgeWith('e1', 'status is present'), edgeWith('e2', 'status is present')];
    assert.equal(findConflictingAssumptions(edges).length, 0);
  });
});
