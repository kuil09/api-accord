// Baseline scenario seed (issue #22): the PaymentStatus REVERSED fixtures as a
// reusable, one-call harness. Everything is created through the real domain
// services so the seed itself is an executable specification of the catalog,
// dependency, and context state the acceptance scenario assumes.

import { CatalogService, OpenApiImporter } from './catalog.js';
import { DependencyService } from './dependency.js';
import { DomainService } from './service.js';
import type { EventStore } from './events.js';
import type { CompatibilityPolicy } from './model.js';
import type { ContractSnapshot } from './contract-diff.js';
import type { ContextItemId, DependencyEdgeId, PrincipalRef, ServiceId, TeamId, ApiContractId, OrganizationId } from './primitives.js';
import { apiContractId, contextItemId, dependencyEdgeId, operationId, organizationId, principalRef, serviceId, teamId } from './primitives.js';

export interface BaselineSeed {
  readonly organizationId: OrganizationId;
  readonly paymentsTeam: TeamId;
  readonly providerActor: PrincipalRef;
  readonly merchantActor: PrincipalRef;
  readonly settlementActor: PrincipalRef;
  readonly paymentService: ServiceId;
  readonly merchantConsole: ServiceId;
  readonly settlementWorker: ServiceId;
  readonly mobileApp: ServiceId;
  readonly contract: ApiContractId;
  readonly sourceRevisionV1: string;
  readonly edges: { readonly merchant: DependencyEdgeId; readonly settlement: DependencyEdgeId; readonly mobile: DependencyEdgeId };
  readonly contexts: { readonly merchantAssumption: ContextItemId; readonly notFoundMeaning: ContextItemId };
}

// v1 OpenAPI fixture: PaymentStatus without REVERSED (issue #22 baseline).
export const baselineContractV1: ContractSnapshot = {
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
    },
    {
      method: 'post',
      path: '/payments',
      requestSchema: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' } } },
      responses: [{ status: '201', schema: { type: 'object' } }],
      security: []
    }
  ]
};

const strictPolicy: CompatibilityPolicy = { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false };
const mappingPolicy: CompatibilityPolicy = { allowAdditiveFields: true, allowNewEnumValues: true, allowNullableChange: true };

// Deterministic fake GitHub adapter for the acceptance harness (issue #22 step 8):
// real GitHub integration is issue #13; this test double reproduces PR and
// evidence linkage without credentials.
export class FakeGitHubAdapter {
  #counter = 0;

  createPullRequest(input: { readonly title: string; readonly headRevision: string }): { readonly number: number; readonly url: string; readonly mergeRevision: string } {
    this.#counter += 1;
    const number = 100 + this.#counter;
    return {
      number,
      url: `https://github.example/acme/payments/pull/${String(number)}`,
      mergeRevision: input.headRevision
    };
  }
}

export async function seedBaselineCatalog(store: EventStore, actor: PrincipalRef): Promise<BaselineSeed> {
  const catalog = new CatalogService(store);
  const dependencies = new DependencyService(store);
  const domain = new DomainService(store);

  const org = organizationId('org-acme');
  const paymentsTeam = teamId('team-payments');
  const providerActor = principalRef('human', 'payments-owner');
  const merchantActor = principalRef('human', 'merchant-owner');
  const settlementActor = principalRef('human', 'settlement-owner');
  const paymentService = serviceId('payment-service');
  const merchantConsole = serviceId('merchant-console');
  const settlementWorker = serviceId('settlement-worker');
  const mobileApp = serviceId('mobile-app');
  const contract = apiContractId('contract-payments');
  const sourceRevisionV1 = 'rev-1';

  await catalog.registerService({ actor, serviceId: paymentService, organizationId: org, owningTeamId: paymentsTeam, name: 'payment-service', kind: 'provider', environments: ['staging', 'production'] });
  await catalog.registerService({ actor, serviceId: merchantConsole, organizationId: org, owningTeamId: teamId('team-merchant'), name: 'merchant-console', kind: 'consumer' });
  await catalog.registerService({ actor, serviceId: settlementWorker, organizationId: org, owningTeamId: teamId('team-settlement'), name: 'settlement-worker', kind: 'consumer' });
  await catalog.registerService({ actor, serviceId: mobileApp, organizationId: org, owningTeamId: teamId('team-mobile'), name: 'mobile-app', kind: 'consumer' });

  // OpenAPI import (issue #22 step 1).
  await catalog.importContract({
    actor,
    contractId: contract,
    organizationId: org,
    providerServiceId: paymentService,
    importer: new OpenApiImporter(),
    source: baselineContractV1,
    importSource: 'file:fixtures/payments-v1.yaml'
  });

  // Consumer dependencies with usage fields, hidden assumptions and policies
  // (issue #22 step 2). Merchant and settlement do not allow unknown enums;
  // mobile-app will map new values for old clients.
  const edges: ReadonlyArray<Promise<unknown>> = [
    dependencies.declareDependency({
      actor: merchantActor,
      edgeId: dependencyEdgeId('edge-merchant-console'),
      consumerServiceId: merchantConsole,
      operationId: operationId(`${contract}:GET:/payments/{paymentId}`),
      usage: {
        fields: ['id', 'status', 'approvedAt'],
        statusValues: ['APPROVED'],
        enumNullability: ['approvedAt is null until approved'],
        errorMeanings: ['404 means the payment does not exist yet'],
        timeoutExpectation: '500ms',
        retryExpectation: '3 times',
        idempotencyExpectation: 'idempotent read',
        orderingConsistencySideEffects: []
      },
      compatibility: strictPolicy,
      criticality: 'high',
      source: 'explicit',
      ownerTeamId: teamId('team-merchant'),
      assumptions: [{ statement: 'status APPROVED always implies approvedAt exists', source: 'explicit', confidence: 'confirmed', conflictStatus: 'none' }]
    }),
    dependencies.declareDependency({
      actor: settlementActor,
      edgeId: dependencyEdgeId('edge-settlement-worker'),
      consumerServiceId: settlementWorker,
      operationId: operationId(`${contract}:GET:/payments/{paymentId}`),
      usage: {
        fields: ['status'],
        statusValues: ['PENDING', 'APPROVED', 'CANCELLED'],
        enumNullability: [],
        errorMeanings: [],
        timeoutExpectation: '5s',
        retryExpectation: 'exponential backoff',
        idempotencyExpectation: 'at-least-once',
        orderingConsistencySideEffects: ['settlement runs are ordered per payment id']
      },
      compatibility: strictPolicy,
      criticality: 'critical',
      source: 'explicit',
      ownerTeamId: teamId('team-settlement'),
      assumptions: [{ statement: 'the switch over status covers every value, so an unknown value fails the job', source: 'code-analysis', confidence: 'confirmed', conflictStatus: 'none' }]
    }),
    dependencies.declareDependency({
      actor: merchantActor,
      edgeId: dependencyEdgeId('edge-mobile-app'),
      consumerServiceId: mobileApp,
      operationId: operationId(`${contract}:GET:/payments/{paymentId}`),
      usage: {
        fields: ['status'],
        statusValues: ['CANCELLED'],
        enumNullability: [],
        errorMeanings: [],
        timeoutExpectation: '2s',
        retryExpectation: 'none',
        idempotencyExpectation: 'idempotent read',
        orderingConsistencySideEffects: []
      },
      compatibility: mappingPolicy,
      criticality: 'medium',
      source: 'explicit',
      ownerTeamId: teamId('team-mobile'),
      assumptions: [{ statement: 'old app versions only recognise CANCELLED as a cancelled state', source: 'runtime-observation', confidence: 'confirmed', conflictStatus: 'none' }]
    })
  ];
  await Promise.all(edges);

  // Context seed: hidden assumptions and error semantics as sourced claims
  // (issue #22 step 2, INV-011). Merchant's assumption is confirmed by a human.
  const merchantAssumption = contextItemId('ctx-merchant-assumption');
  const notFoundMeaning = contextItemId('ctx-404-meaning');
  await store.append({
    actor,
    correlationId: 'seed',
    event: { type: 'ContextProposed', contextItemId: merchantAssumption, scope: 'dependencyEdge', statement: 'status APPROVED always implies approvedAt exists', contextType: 'assumption', author: merchantActor, source: 'merchant-console code', confidence: 'inferred' }
  });
  await domain.confirmContext({ actor, contextItemId: merchantAssumption, validFrom: new Date('2026-01-01T00:00:00Z'), source: 'merchant-console code review' });
  await store.append({
    actor,
    correlationId: 'seed',
    event: { type: 'ContextProposed', contextItemId: notFoundMeaning, scope: 'operation', statement: '404 means the payment does not exist yet', contextType: 'fact', author: providerActor, source: 'payments API docs', confidence: 'confirmed' }
  });

  return {
    organizationId: org,
    paymentsTeam,
    providerActor,
    merchantActor,
    settlementActor,
    paymentService,
    merchantConsole,
    settlementWorker,
    mobileApp,
    contract,
    sourceRevisionV1,
    edges: { merchant: dependencyEdgeId('edge-merchant-console'), settlement: dependencyEdgeId('edge-settlement-worker'), mobile: dependencyEdgeId('edge-mobile-app') },
    contexts: { merchantAssumption, notFoundMeaning }
  };
}
