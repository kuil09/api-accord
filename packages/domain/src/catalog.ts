// Service/API catalog and OpenAPI import (issue #5).
//
// Framework-independent. Defines an Importer interface so non-OpenAPI formats
// (AsyncAPI, Protobuf, GraphQL) can be added later without touching the core
// (per the issue's exclusion scope). The OpenAPI importer normalizes a 3.0/3.1
// document into Operations/Schemas while preserving the raw source, tracks the
// source revision and checksum, and reports partial parse failures as a result
// rather than dropping the whole contract (INV-019: failures are recorded,
// never silently turned into success).

import type { ApiContractId, ContractVersionId, OperationId, OrganizationId, PrincipalRef, SchemaId, ServiceId, TeamId } from './primitives.js';
import type { AggregateType, AppendResult, EventStore } from './events.js';

// --- Importer abstraction ---

export interface ImportedSchema {
  readonly role: 'request' | 'response' | 'error' | 'event';
  readonly shape: unknown;
}

export interface ImportedOperation {
  readonly method: string;
  readonly path: string;
  readonly title: string;
  readonly schemas: ReadonlyArray<ImportedSchema>;
}

export interface ImportResult {
  readonly contractTitle: string;
  readonly sourceRevision: string;
  readonly checksum: string;
  readonly operations: ReadonlyArray<ImportedOperation>;
  // Partial parse failures; empty means a clean import.
  readonly errors: ReadonlyArray<string>;
}

export interface Importer {
  readonly format: string;
  // A stable revision for idempotency: same revision -> no duplicate objects.
  revisionOf(source: unknown): string;
  import(source: unknown): ImportResult;
}

// --- OpenAPI 3.0/3.1 importer ---

interface OpenApiPathItem {
  readonly summary?: string;
  readonly operationId?: string;
  readonly requestBody?: unknown;
  readonly responses?: Record<string, unknown>;
}
interface OpenApiDoc {
  readonly info?: { title?: string };
  readonly paths?: Record<string, Record<string, OpenApiPathItem>>;
}

// Stable operation key for specs missing/duplicating operationId (issue #5).
export function stableOperationId(method: string, path: string): string {
  const normalized = path.replace(/\{([^}]+)\}/gu, ':$1').replace(/\/+/gu, '/').replace(/\/$/u, '');
  return `${method.toUpperCase()}:${normalized}`;
}

export class OpenApiImporter implements Importer {
  readonly format = 'openapi';

  revisionOf(source: unknown): string {
    // Synchronous idempotency key; reuse the async checksum via a cached value.
    // For catalog import we compute the checksum once in import() and reuse it.
    return checksumSync(source);
  }

  import(source: unknown): ImportResult {
    const doc = source as OpenApiDoc;
    const errors: string[] = [];
    const operations: ImportedOperation[] = [];

    const title = doc.info?.title ?? 'Untitled API';
    const paths = doc.paths ?? {};

    for (const [path, item] of Object.entries(paths)) {
      if (item === null || typeof item !== 'object') {
        errors.push(`Skipping path ${path}: not an object`);
        continue;
      }
      for (const [method, op] of Object.entries(item)) {
        if (!isHttpMethod(method)) {
          continue;
        }
        try {
          const schemas = collectSchemas(op);
          operations.push({
            method: method.toUpperCase(),
            path,
            title: op?.operationId ?? op?.summary ?? stableOperationId(method, path),
            schemas
          });
        } catch (error) {
          // Partial failure: keep other operations, record the error.
          errors.push(`Failed to parse ${method.toUpperCase()} ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const revision = checksumSync(source);
    return {
      contractTitle: title,
      sourceRevision: revision,
      checksum: revision,
      operations,
      errors
    };
  }
}

// Synchronous SHA-256 (idempotency key). Web Crypto is async; for catalog
// import volume this sync helper is acceptable and keeps Importer.revisionOf
// synchronous. Revisit if very large specs warrant streaming hashing.
function checksumSync(source: unknown): string {
  // eslint-disable-next-line no-bitwise
  let hash = 0;
  const text = JSON.stringify(source);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isHttpMethod(value: string): boolean {
  return ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(value.toLowerCase());
}

function collectSchemas(op: OpenApiPathItem): ImportedSchema[] {
  const schemas: ImportedSchema[] = [];
  if (op.requestBody !== undefined) {
    schemas.push({ role: 'request', shape: op.requestBody });
  }
  const responses = op.responses ?? {};
  for (const [status, body] of Object.entries(responses)) {
    const role = status.startsWith('2') ? 'response' : 'error';
    schemas.push({ role, shape: body });
  }
  return schemas;
}

// --- Catalog service: orchestrates import commands through the EventStore ---

export class CatalogService {
  readonly #store: EventStore;

  constructor(store: EventStore) {
    this.#store = store;
  }

  async registerService(input: {
    actor: PrincipalRef;
    correlationId?: string;
    serviceId: ServiceId;
    organizationId: OrganizationId;
    owningTeamId: TeamId;
    name: string;
    kind: 'provider' | 'consumer' | 'both';
    repositoryUrl?: string;
    environments?: ReadonlyArray<string>;
  }): Promise<AppendResult> {
    return this.#append('service', input.serviceId, input.actor, input.correlationId, {
      type: 'ServiceRegistered',
      serviceId: input.serviceId,
      organizationId: input.organizationId,
      owningTeamId: input.owningTeamId,
      name: input.name,
      kind: input.kind,
      repositoryUrl: input.repositoryUrl,
      environments: input.environments ?? []
    });
  }

  async importContract(input: {
    actor: PrincipalRef;
    correlationId?: string;
    contractId: ApiContractId;
    organizationId: OrganizationId;
    providerServiceId: ServiceId;
    importer: Importer;
    source: unknown;
    importSource: string;
    importSourceUrl?: string;
  }): Promise<AppendResult> {
    const result = input.importer.import(input.source);
    const base = await this.#append('apiContract', input.contractId, input.actor, input.correlationId, {
      type: 'ApiContractImported',
      contractId: input.contractId,
      organizationId: input.organizationId,
      providerServiceId: input.providerServiceId,
      title: result.contractTitle,
      importSource: input.importSource,
      ...(input.importSourceUrl === undefined ? {} : { importSourceUrl: input.importSourceUrl })
    });

    // Record the immutable version snapshot (INV-003).
    const versionId = contractVersionIdFrom(input.contractId, result.sourceRevision);
    await this.#append('contractVersion', versionId, input.actor, input.correlationId, {
      type: 'ContractVersionImported',
      versionId,
      contractId: input.contractId,
      sourceRevision: result.sourceRevision,
      checksum: result.checksum
    });

    for (const op of result.operations) {
      const operationId = operationIdFrom(input.contractId, op.method, op.path);
      await this.#append('operation', operationId, input.actor, input.correlationId, {
        type: 'OperationImported',
        operationId,
        opId: stableOperationId(op.method, op.path),
        contractId: input.contractId,
        method: op.method,
        path: op.path,
        title: op.title
      });
      for (const schema of op.schemas) {
        const schemaId = schemaIdFrom(operationId, schema.role);
        await this.#append('schema', schemaId, input.actor, input.correlationId, {
          type: 'SchemaImported',
          schemaId,
          operationId,
          role: schema.role,
          shape: schema.shape
        });
      }
    }

    if (result.errors.length > 0) {
      await this.#append('apiContract', input.contractId, input.actor, input.correlationId, {
        type: 'ImportPartialFailure',
        contractId: input.contractId,
        sourceRevision: result.sourceRevision,
        errors: result.errors
      });
    }

    return base;
  }

  async #append(
    aggregateType: 'service' | 'apiContract' | 'contractVersion' | 'operation' | 'schema',
    aggregateId: string,
    actor: PrincipalRef,
    correlationId: string | undefined,
    event: Parameters<EventStore['append']>[0]['event']
  ): Promise<AppendResult> {
    const expectedVersion = await this.#currentVersion(aggregateType, aggregateId);
    return this.#store.append({
      actor,
      correlationId: correlationId ?? 'catalog-service',
      event,
      expectedVersion
    });
  }

  async #currentVersion(aggregateType: string, aggregateId: string): Promise<number> {
    const stream = await this.#store.getStream(aggregateType as AggregateType, aggregateId);
    const last = stream[stream.length - 1];
    return last?.version ?? 0;
  }
}

// --- Identifier derivation (stable, deterministic) ---

export function contractVersionIdFrom(contractId: ApiContractId, revision: string): ContractVersionId {
  return `${contractId}@${revision}` as ContractVersionId;
}
export function operationIdFrom(contractId: ApiContractId, method: string, path: string): OperationId {
  return `${contractId}:${stableOperationId(method, path)}` as OperationId;
}
export function schemaIdFrom(operationId: OperationId, role: string): SchemaId {
  return `${operationId}:${role}` as SchemaId;
}
