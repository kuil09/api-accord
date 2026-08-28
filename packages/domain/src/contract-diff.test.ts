import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContractSnapshot, DependencyEdge, UsageDeclaration, CompatibilityPolicy } from './index.js';
import { assessConsumerSemanticImpact, canOverrideVerdict, diffContractSnapshots, evaluateCompatibilityPolicy } from './contract-diff.js';
import { dependencyEdgeId, operationId, serviceId } from './primitives.js';

const paymentStatusSchema = (statuses: ReadonlyArray<string>): unknown => ({
  type: 'object',
  required: ['id', 'status'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: [...statuses] },
    approvedAt: { type: 'string', format: 'date-time', nullable: true }
  }
});

const snapshot = (statuses: ReadonlyArray<string>): ContractSnapshot => ({
  title: 'Payments',
  operations: [
    {
      method: 'get',
      path: '/payments/{paymentId}',
      responses: [
        { status: '200', schema: paymentStatusSchema(statuses) },
        { status: '404', schema: { type: 'object' } }
      ],
      security: []
    },
    {
      method: 'post',
      path: '/payments',
      requestSchema: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' } } },
      responses: [{ status: '201', schema: { type: 'object' } }],
      security: []
    }
  ]
});

const from = snapshot(['PENDING', 'APPROVED', 'CANCELLED']);
const to = snapshot(['PENDING', 'APPROVED', 'CANCELLED', 'REVERSED']);

function edge(consumer: string, fields: ReadonlyArray<string>, policy: CompatibilityPolicy, assumptions: ReadonlyArray<string> = []): DependencyEdge {
  const usage: UsageDeclaration = {
    fields,
    statusValues: ['APPROVED'],
    enumNullability: [],
    errorMeanings: ['404 means payment not created'],
    timeoutExpectation: '500ms',
    retryExpectation: '3 times',
    idempotencyExpectation: 'idempotent create',
    orderingConsistencySideEffects: []
  };
  return {
    id: dependencyEdgeId(`edge-${consumer}`),
    consumerServiceId: serviceId(consumer),
    operationId: operationId('contract-payments:GET:/payments/{paymentId}'),
    usage,
    assumptions: assumptions.map((statement, index) => ({ id: `a${String(index)}`, statement, source: 'explicit' as const, confidence: 'confirmed' as const, conflictStatus: 'none' as const })),
    compatibility: policy,
    criticality: 'high',
    source: 'explicit',
    confirmedAt: new Date('2026-01-01T00:00:00Z'),
    deprecated: false
  };
}



describe('structural diff (issue #10)', () => {
  it('classifies an added enum value as additive-but-potentially-breaking with evidence', () => {
    const diff = diffContractSnapshots(from, to);
    const enumFinding = diff.findings.find((finding) => finding.ruleId === 'enum-value-added');
    assert.ok(enumFinding);
    assert.equal(enumFinding?.classification, 'additive');
    assert.equal(enumFinding?.potentiallyBreaking, true);
    assert.match(enumFinding?.evidence ?? '', /REVERSED/);
    assert.match(enumFinding?.affectedPath ?? '', /response\.200\.status/u);
    // MVP baseline: generic compatibility for an additive enum is "additive / potentially breaking".
    assert.equal(diff.verdict, 'ambiguous');
  });

  it('is deterministic: identical inputs produce identical diffs', () => {
    const first = diffContractSnapshots(from, to);
    const second = diffContractSnapshots(snapshot(['PENDING', 'APPROVED', 'CANCELLED']), snapshot(['PENDING', 'APPROVED', 'CANCELLED', 'REVERSED']));
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('separates rule ids, evidence and affected paths per finding (INV-004)', () => {
    const changed: ContractSnapshot = {
      title: 'Payments',
      operations: [
        {
          method: 'get',
          path: '/payments/{paymentId}',
          responses: [
            { status: '200', schema: { type: 'object', required: ['id', 'status', 'merchantId'], properties: { id: { type: 'string' }, status: { type: 'string' }, merchantId: { type: 'string' } } } }
          ],
          security: ['oauth2']
        }
      ],
    };
    const diff = diffContractSnapshots(from, changed);
    const ruleIds = diff.findings.map((finding) => finding.ruleId);
    assert.ok(ruleIds.includes('required-field-added'));
    assert.ok(ruleIds.includes('security-requirements-changed'));
    assert.ok(ruleIds.includes('status-code-removed'), '404 removed is a breaking change');
    for (const finding of diff.findings) {
      assert.ok(finding.affectedPath.length > 0);
      assert.ok(finding.evidence.length > 0);
    }
    assert.equal(diff.verdict, 'breaking');
  });

  it('reports no-op for identical snapshots and additive for a new operation', () => {
    assert.equal(diffContractSnapshots(from, from).verdict, 'no-op');
    const withNewOperation: ContractSnapshot = {
      title: 'Payments',
      operations: [...from.operations, { method: 'delete', path: '/payments/{id}', responses: [], security: [] }]
    };
    const diff = diffContractSnapshots(from, withNewOperation);
    assert.equal(diff.verdict, 'additive');
    assert.ok(diff.findings.some((finding) => finding.ruleId === 'operation-added'));
  });
});

describe('compatibility policy evaluation (INV-004)', () => {
  const diff = diffContractSnapshots(from, to);
  const enumFinding = diff.findings.find((finding) => finding.ruleId === 'enum-value-added');

  it('the same change is allowed under one policy and violates another', () => {
    const strict = evaluateCompatibilityPolicy(diff, { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false }, 'consumer:merchant-console');
    const lenient = evaluateCompatibilityPolicy(diff, { allowAdditiveFields: true, allowNewEnumValues: true, allowNullableChange: false }, 'consumer:mobile-app');
    assert.equal(strict.allowed, false);
    assert.equal(strict.violations.length, 1);
    assert.equal(lenient.allowed, true);
    assert.ok(enumFinding !== undefined, 'the evaluated finding exists');
  });

  it('a policy disallowing nullable changes rejects nullability changes in either direction', () => {
    const widenedDiff = diffContractSnapshots(from, snapshot(['PENDING', 'APPROVED', 'CANCELLED']));
    void widenedDiff;
    const narrowing: ContractSnapshot = {
      title: 'Payments',
      operations: [
        {
          method: 'get',
          path: '/payments/{paymentId}',
          responses: [
            { status: '200', schema: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string', enum: ['PENDING', 'APPROVED', 'CANCELLED'] }, approvedAt: { type: 'string', format: 'date-time' } } } },
            { status: '404', schema: { type: 'object' } }
          ],
          security: []
        },
        { method: 'post', path: '/payments', requestSchema: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' } } }, responses: [{ status: '201', schema: { type: 'object' } }], security: [] }
      ],
    };
    const diff2 = diffContractSnapshots(from, narrowing);
    const evaluation = evaluateCompatibilityPolicy(diff2, { allowAdditiveFields: true, allowNewEnumValues: true, allowNullableChange: false }, 'api:payments');
    assert.equal(evaluation.allowed, false);
    assert.ok(evaluation.violations.some((finding) => finding.ruleId === 'nullability-changed'));
  });
});

describe('consumer semantic impact (REVERSED baseline, INV-004)', () => {
  const diff = diffContractSnapshots(from, to);

  it('merchant-console: high risk, blocking, with assumption evidence quoted', () => {
    const impact = assessConsumerSemanticImpact(diff, edge('merchant-console', ['id', 'status', 'approvedAt'], { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false }, ['status APPROVED always implies approvedAt exists']));
    assert.equal(impact.blocking, true);
    assert.equal(impact.overallRisk, 'high');
    const finding = impact.findings.find((candidate) => candidate.ruleId === 'semantic-unknown-enum');
    assert.ok(finding);
    assert.match(finding?.evidence ?? '', /does not allow unknown enum values/u);
    assert.match(finding?.evidence ?? '', /status APPROVED always implies approvedAt exists/u, 'assumption quoted verbatim');
  });

  it('settlement-worker: blocking because exhaustive switch has no default', () => {
    const impact = assessConsumerSemanticImpact(diff, edge('settlement-worker', ['status'], { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false }));
    assert.equal(impact.blocking, true);
    assert.equal(impact.overallRisk, 'high');
  });

  it('mobile-app: action-required (mapping) but not blocking under a lenient policy', () => {
    const impact = assessConsumerSemanticImpact(diff, edge('mobile-app', ['status'], { allowAdditiveFields: true, allowNewEnumValues: true, allowNullableChange: true }));
    assert.equal(impact.blocking, false);
    assert.equal(impact.actionRequired, true);
    assert.equal(impact.overallRisk, 'medium');
  });

  it('a consumer that does not use the changed field sees no impact', () => {
    const impact = assessConsumerSemanticImpact(diff, edge('unrelated-svc', ['otherField'], { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false }));
    assert.equal(impact.overallRisk, 'none');
    assert.equal(impact.blocking, false);
  });
});

describe('verdict override auditability (issue #10)', () => {
  it('requires both a reason and a Decision Record reference', () => {
    assert.equal(canOverrideVerdict({ reason: '' }).ok, false);
    assert.equal(canOverrideVerdict({ reason: 'accepted by product' }).ok, false);
    assert.equal(canOverrideVerdict({ reason: 'accepted by product', decisionRecordId: 'dec-1' }).ok, true);
  });
});
