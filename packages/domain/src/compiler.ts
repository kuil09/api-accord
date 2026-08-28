// Spec/policy/changelog/test-draft compiler (issue #12): turns an accepted
// Change Proposal plus its linked Decision Records into reproducible contract
// artifacts. This is a deterministic build, not an AI summary: the same inputs
// always produce byte-identical outputs, identifiers are input versions and
// checksums (never generation timestamps), and compilation refuses to run while
// unresolved questions or blocking objections remain (INV-005, INV-013, INV-014).
//
// Safety rules from the issue are enforced structurally:
// - only changes citing a Decision Record linked to the accepted proposal are
//   applied (INV-018: nothing beyond the approved scope);
// - compilation is pure, so a failed compile cannot touch a published contract
//   (INV-019);
// - dry-run and publish are separate: this engine only produces artifacts; the
//   caller publishes through the existing proposal workflow (#9).
//
// The CompilerAdapter interface keeps the door open for AsyncAPI/Protobuf
// adapters later (per the issue's extension requirement).

import type { ChangeProposalId, DecisionRecordId, PrincipalRef, ServiceId } from './primitives.js';
import type { ChangeProposalState, DecisionRecord } from './model.js';
import type { ContractSnapshot } from './contract-diff.js';
import type { DiscussionSummary } from './projection.js';

// --- Compile input ---

export interface ChangeTarget {
  readonly method: string;
  readonly path: string;
  // When set, the target is that response's schema; otherwise the request schema.
  readonly response?: string | undefined;
  // Property name inside the target schema (single segment in this increment).
  readonly field?: string | undefined;
}

export type ChangeOperation =
  | { readonly op: 'add-enum-value'; readonly target: ChangeTarget; readonly value: string }
  | { readonly op: 'remove-enum-value'; readonly target: ChangeTarget; readonly value: string }
  | { readonly op: 'add-optional-field'; readonly target: ChangeTarget; readonly field: string; readonly schema: unknown }
  | { readonly op: 'remove-field'; readonly target: ChangeTarget; readonly field: string }
  | { readonly op: 'mark-required'; readonly target: ChangeTarget; readonly field: string }
  | { readonly op: 'add-response-status'; readonly target: ChangeTarget; readonly status: string; readonly schema: unknown }
  | { readonly op: 'remove-response-status'; readonly target: ChangeTarget; readonly status: string };

// A machine-readable change that must cite the Decision Record approving it.
export interface ApprovedChange {
  readonly decisionRecordId: DecisionRecordId;
  readonly changes: ReadonlyArray<ChangeOperation>;
}

// Structural subset of the #11 ConsumerImpact the compiler needs for migration
// guides; the full impact analysis result satisfies this shape.
export interface ConsumerImpactSummary {
  readonly consumerServiceId: ServiceId;
  readonly impact: 'none' | 'informational' | 'action-required' | 'blocking' | 'unknown';
  readonly requiredActions: ReadonlyArray<{ readonly kind: string; readonly description: string; readonly evidencePath: string }>;
}

export interface CompileInput {
  readonly proposalId: ChangeProposalId;
  readonly proposalState: ChangeProposalState;
  readonly decisions: ReadonlyArray<DecisionRecord>;
  readonly discussion: DiscussionSummary;
  readonly baseContract: ContractSnapshot;
  readonly approvedChanges: ReadonlyArray<ApprovedChange>;
  readonly impacts: ReadonlyArray<ConsumerImpactSummary>;
  readonly compiledBy: PrincipalRef;
}

// --- Compile output ---

export interface ChangelogEntry {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly text: string;
  readonly decisionRecordId: DecisionRecordId;
}

export interface MigrationGuide {
  readonly consumerServiceId: ServiceId;
  readonly impact: ConsumerImpactSummary['impact'];
  readonly steps: ReadonlyArray<string>;
}

export interface TestDraft {
  readonly kind: 'provider' | 'consumer';
  readonly consumerServiceId?: ServiceId | undefined;
  readonly name: string;
  readonly target: string;
}

export interface CompileManifest {
  readonly proposalId: ChangeProposalId;
  readonly decisionRecordIds: ReadonlyArray<DecisionRecordId>;
  readonly adapter: string;
  readonly baseChecksum: string;
  readonly outputChecksum: string;
  readonly compiledBy: PrincipalRef;
}

export interface CompileOutput {
  readonly manifest: CompileManifest;
  readonly openapi: ContractSnapshot;
  readonly changelog: ReadonlyArray<ChangelogEntry>;
  readonly migrationGuides: ReadonlyArray<MigrationGuide>;
  readonly testDrafts: ReadonlyArray<TestDraft>;
}

// --- Adapter structure ---

export interface CompilerAdapter {
  readonly format: string;
  compile(input: CompileInput): CompileOutput;
}

export class CompileError extends Error {
  constructor(readonly errors: ReadonlyArray<string>) {
    super(`compilation failed with ${String(errors.length)} error(s): ${errors.join(' | ')}`);
    this.name = 'CompileError';
  }
}

// --- Guards and validation ---

// Refuses compilation while the proposal is not accepted, or while unresolved
// questions / blocking objections remain (INV-005, INV-013, INV-014).
export function collectCompileErrors(input: CompileInput): ReadonlyArray<string> {
  const errors: string[] = [];
  if (!input.proposalState.accepted) {
    errors.push('INV-001: only an accepted change proposal can be compiled');
  }
  if (input.discussion.openBlockingObjections.length > 0) {
    errors.push(`INV-005: ${String(input.discussion.openBlockingObjections.length)} blocking objection(s) remain unresolved`);
  }
  if (input.discussion.unresolvedQuestions.length > 0) {
    errors.push(`INV-014: ${String(input.discussion.unresolvedQuestions.length)} question(s) remain unresolved`);
  }
  const linked = new Set(input.decisions.map((decision) => decision.id));
  for (const change of input.approvedChanges) {
    if (!linked.has(change.decisionRecordId)) {
      errors.push(`INV-018: change cites decision '${change.decisionRecordId}' which is not linked to this proposal`);
    }
  }
  for (const decision of input.decisions) {
    if (decision.proposalId !== input.proposalId) {
      errors.push(`INV-013: decision '${decision.id}' belongs to a different proposal`);
    }
  }
  return errors;
}

// Output lint: the generated contract must stay structurally sane before it can
// be published. Errors are reported, never silently repaired (INV-034).
export function validateOutput(output: CompileOutput): ReadonlyArray<string> {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const operation of output.openapi.operations) {
    const key = `${operation.method.toUpperCase()} ${operation.path}`;
    if (seen.has(key)) {
      errors.push(`duplicate operation ${key}`);
    }
    seen.add(key);
    for (const response of operation.responses) {
      if (response.status.trim().length === 0) {
        errors.push(`operation ${key} has a response with an empty status`);
      }
      collectSchemaErrors(response.schema, `${key}#response.${response.status}`, errors);
    }
  }
  return errors;
}

function collectSchemaErrors(shape: unknown, path: string, errors: string[]): void {
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) {
    return;
  }
  const record = shape as Record<string, unknown>;
  const enums = record['enum'];
  if (Array.isArray(enums) && enums.length === 0) {
    errors.push(`${path}: enum has no values left`);
  }
  const properties = record['properties'];
  if (properties !== undefined && properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [name, child] of Object.entries(properties as Record<string, unknown>)) {
      collectSchemaErrors(child, `${path}.${name}`, errors);
    }
  }
}

// --- The OpenAPI compiler adapter ---

export class OpenApiCompilerAdapter implements CompilerAdapter {
  readonly format = 'openapi';

  compile(input: CompileInput): CompileOutput {
    const errors: string[] = [...collectCompileErrors(input)];
    if (errors.length > 0) {
      throw new CompileError(errors);
    }

    const changelog: ChangelogEntry[] = [];
    const working = cloneSnapshot(input.baseContract);

    for (const approved of input.approvedChanges) {
      for (const change of approved.changes) {
        applyChange(working, change, approved.decisionRecordId, changelog, errors);
      }
    }

    if (errors.length > 0) {
      throw new CompileError(errors);
    }

    const output: CompileOutput = {
      manifest: {
        proposalId: input.proposalId,
        decisionRecordIds: input.decisions.map((decision) => decision.id).sort(),
        adapter: this.format,
        baseChecksum: stableChecksum(input.baseContract),
        outputChecksum: stableChecksum(working),
        compiledBy: input.compiledBy
      },
      openapi: working,
      changelog: changelog.slice().sort(compareChangelog),
      migrationGuides: buildMigrationGuides(input.impacts),
      testDrafts: buildTestDrafts(input.approvedChanges, input.impacts)
    };

    const validation = validateOutput(output);
    if (validation.length > 0) {
      throw new CompileError(validation);
    }
    return output;
  }
}

// --- Change application ---

function applyChange(
  contract: MutableContract,
  change: ChangeOperation,
  decisionRecordId: DecisionRecordId,
  changelog: ChangelogEntry[],
  errors: string[]
): void {
  const operation = findOperation(contract, change.target);
  if (operation === undefined) {
    errors.push(`change '${change.op}' targets unknown operation ${change.target.method.toUpperCase()} ${change.target.path}`);
    return;
  }
  const label = `${change.target.method.toUpperCase()} ${change.target.path}`;

  switch (change.op) {
    case 'add-enum-value': {
      const enums = resolveEnum(operation, change.target, errors);
      if (enums !== undefined && !enums.includes(change.value)) {
        enums.push(change.value);
        changelog.push({ kind: 'added', text: `Added enum value '${change.value}' to ${label}${pathSuffix(change.target)}`, decisionRecordId });
      }
      break;
    }
    case 'remove-enum-value': {
      const enums = resolveEnum(operation, change.target, errors);
      if (enums !== undefined) {
        const index = enums.indexOf(change.value);
        if (index >= 0) {
          enums.splice(index, 1);
          changelog.push({ kind: 'removed', text: `Removed enum value '${change.value}' from ${label}${pathSuffix(change.target)}`, decisionRecordId });
        }
      }
      break;
    }
    case 'add-optional-field': {
      const schema = resolveSchemaObject(operation, change.target, errors);
      if (schema !== undefined) {
        const properties = ensureProperties(schema, errors, label);
        if (properties !== undefined) {
          properties[change.field] = change.schema;
          changelog.push({ kind: 'added', text: `Added optional field '${change.field}' to ${label}${pathSuffix(change.target)}`, decisionRecordId });
        }
      }
      break;
    }
    case 'remove-field': {
      const schema = resolveSchemaObject(operation, change.target, errors);
      if (schema !== undefined) {
        const properties = schema['properties'] as Record<string, unknown> | undefined;
        if (properties === undefined || properties[change.field] === undefined) {
          errors.push(`remove-field: field '${change.field}' does not exist on ${label}${pathSuffix(change.target)}`);
          break;
        }
        delete properties[change.field];
        const required = schema['required'];
        if (Array.isArray(required)) {
          const index = required.indexOf(change.field);
          if (index >= 0) {
            required.splice(index, 1);
          }
        }
        changelog.push({ kind: 'removed', text: `Removed field '${change.field}' from ${label}${pathSuffix(change.target)}`, decisionRecordId });
      }
      break;
    }
    case 'mark-required': {
      const schema = resolveSchemaObject(operation, change.target, errors);
      if (schema !== undefined) {
        const properties = schema['properties'] as Record<string, unknown> | undefined;
        if (properties === undefined || properties[change.field] === undefined) {
          errors.push(`mark-required: field '${change.field}' does not exist on ${label}${pathSuffix(change.target)}`);
          break;
        }
        const required = ensureRequired(schema);
        if (!required.includes(change.field)) {
          required.push(change.field);
          changelog.push({ kind: 'changed', text: `Field '${change.field}' became required on ${label}${pathSuffix(change.target)}`, decisionRecordId });
        }
      }
      break;
    }
    case 'add-response-status': {
      if (operation.responses.some((response) => response.status === change.status)) {
        errors.push(`add-response-status: status ${change.status} already exists on ${label}`);
        break;
      }
      operation.responses.push({ status: change.status, schema: change.schema });
      changelog.push({ kind: 'added', text: `Added response status ${change.status} to ${label}`, decisionRecordId });
      break;
    }
    case 'remove-response-status': {
      const index = operation.responses.findIndex((response) => response.status === change.status);
      if (index < 0) {
        errors.push(`remove-response-status: status ${change.status} does not exist on ${label}`);
        break;
      }
      operation.responses.splice(index, 1);
      changelog.push({ kind: 'removed', text: `Removed response status ${change.status} from ${label}`, decisionRecordId });
      break;
    }
    default: {
      // Exhaustiveness guard: an unknown change kind is a compile error, never a
      // silent skip (INV-034).
      const unknown = change as { op?: string };
      errors.push(`unsupported change operation '${unknown.op ?? 'unknown'}' on ${label}`);
    }
  }
}

function findOperation(contract: MutableContract, target: ChangeTarget): MutableOperation | undefined {
  const key = `${target.method.toUpperCase()} ${target.path}`;
  return contract.operations.find((operation) => `${operation.method.toUpperCase()} ${operation.path}` === key);
}

function resolveResponse(operation: MutableOperation, target: ChangeTarget, errors: string[]): Record<string, unknown> | undefined {
  if (target.response === undefined) {
    errors.push(`change on ${target.method.toUpperCase()} ${target.path} requires a response target`);
    return undefined;
  }
  const response = operation.responses.find((candidate) => candidate.status === target.response);
  if (response === undefined) {
    errors.push(`response status ${target.response} does not exist on ${target.method.toUpperCase()} ${target.path}`);
    return undefined;
  }
  return asRecord(response.schema, `${target.method.toUpperCase()} ${target.path}#response.${target.response}`, errors);
}

function resolveRequest(operation: MutableOperation, target: ChangeTarget, errors: string[]): Record<string, unknown> | undefined {
  if (operation.requestSchema === undefined) {
    errors.push(`operation ${target.method.toUpperCase()} ${target.path} has no request schema`);
    return undefined;
  }
  return asRecord(operation.requestSchema, `${target.method.toUpperCase()} ${target.path}#request`, errors);
}

function resolveSchemaObject(operation: MutableOperation, target: ChangeTarget, errors: string[]): Record<string, unknown> | undefined {
  return target.response === undefined ? resolveRequest(operation, target, errors) : resolveResponse(operation, target, errors);
}

function resolveEnum(operation: MutableOperation, target: ChangeTarget, errors: string[]): string[] | undefined {
  let schema = resolveSchemaObject(operation, target, errors);
  if (schema === undefined) {
    return undefined;
  }
  if (target.field !== undefined) {
    const properties = schema['properties'] as Record<string, unknown> | undefined;
    const child = properties?.[target.field];
    if (child === undefined || child === null || typeof child !== 'object') {
      errors.push(`field '${target.field}' does not exist on ${target.method.toUpperCase()} ${target.path}${pathSuffix(target)}`);
      return undefined;
    }
    schema = child as Record<string, unknown>;
  }
  const enums = schema['enum'];
  if (!Array.isArray(enums)) {
    errors.push(`target schema on ${target.method.toUpperCase()} ${target.path}${pathSuffix(target)} has no enum to modify`);
    return undefined;
  }
  return enums as string[];
}

function ensureProperties(schema: Record<string, unknown>, errors: string[], label: string): Record<string, unknown> | undefined {
  const existing = schema['properties'];
  if (existing !== undefined && existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  if (existing !== undefined) {
    errors.push(`cannot add field on ${label}: 'properties' is not an object`);
    return undefined;
  }
  const created: Record<string, unknown> = {};
  schema['properties'] = created;
  return created;
}

function ensureRequired(schema: Record<string, unknown>): string[] {
  const existing = schema['required'];
  if (Array.isArray(existing)) {
    return existing as string[];
  }
  const created: string[] = [];
  schema['required'] = created;
  return created;
}

function asRecord(shape: unknown, path: string, errors: string[]): Record<string, unknown> | undefined {
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) {
    errors.push(`schema at ${path} is not an object`);
    return undefined;
  }
  return shape as Record<string, unknown>;
}

function pathSuffix(target: ChangeTarget): string {
  const response = target.response === undefined ? '' : ` response ${target.response}`;
  const field = target.field === undefined ? '' : ` field '${target.field}'`;
  return `${response}${field}`;
}

interface MutableResponse {
  status: string;
  schema: unknown;
}

interface MutableOperation {
  method: string;
  path: string;
  requestSchema?: unknown;
  responses: MutableResponse[];
  security: string[];
}

interface MutableContract {
  title: string;
  operations: MutableOperation[];
}

function cloneSnapshot(snapshot: ContractSnapshot): MutableContract {
  // JSON round-trip keeps the clone deterministic for JSON-representable specs.
  return JSON.parse(JSON.stringify(snapshot)) as MutableContract;
}

function stableChecksum(snapshot: ContractSnapshot): string {
  let hash = 0;
  const text = JSON.stringify(snapshot);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// --- Output generation ---

function buildMigrationGuides(impacts: ReadonlyArray<ConsumerImpactSummary>): ReadonlyArray<MigrationGuide> {
  const guides = impacts.map((impact) => {
    const steps = impact.requiredActions.map((action) => action.description);
    if (impact.impact === 'none') {
      steps.push('Confirm the dependency is unaffected by this change.');
    }
    if (impact.impact === 'blocking') {
      steps.push('Coordinate deployment ordering with the provider before going live.');
    }
    if (impact.impact === 'unknown') {
      steps.push('Declare used fields so the impact can be computed.');
    }
    return { consumerServiceId: impact.consumerServiceId, impact: impact.impact, steps };
  });
  return guides.sort((left, right) => left.consumerServiceId.localeCompare(right.consumerServiceId));
}

function buildTestDrafts(
  approvedChanges: ReadonlyArray<ApprovedChange>,
  impacts: ReadonlyArray<ConsumerImpactSummary>
): ReadonlyArray<TestDraft> {
  const drafts: TestDraft[] = [];
  for (const approved of approvedChanges) {
    for (const change of approved.changes) {
      const label = `${change.target.method.toUpperCase()} ${change.target.path}${pathSuffix(change.target)}`;
      if (change.op === 'add-enum-value') {
        drafts.push({
          kind: 'provider',
          name: `provider serializes '${change.value}' for ${label}`,
          target: label
        });
      }
      if (change.op === 'remove-field' || change.op === 'remove-enum-value' || change.op === 'remove-response-status') {
        drafts.push({
          kind: 'provider',
          name: `provider no longer exposes removed element for ${label}`,
          target: label
        });
      }
    }
  }

  for (const impact of impacts) {
    if (impact.impact === 'blocking' || impact.impact === 'action-required') {
      for (const action of impact.requiredActions) {
        if (action.kind === 'unknown-enum-handling') {
          drafts.push({
            kind: 'consumer',
            consumerServiceId: impact.consumerServiceId,
            name: `consumer '${impact.consumerServiceId}' handles the changed enum per its policy (${action.evidencePath})`,
            target: action.evidencePath
          });
        }
      }
      drafts.push({
        kind: 'consumer',
        consumerServiceId: impact.consumerServiceId,
        name: `consumer '${impact.consumerServiceId}' runs its contract tests against the compiled contract`,
        target: 'compiled-contract'
      });
    }
  }

  return drafts.sort((left, right) => {
    const byKind = left.kind.localeCompare(right.kind);
    if (byKind !== 0) {
      return byKind;
    }
    return left.name.localeCompare(right.name);
  });
}

function compareChangelog(left: ChangelogEntry, right: ChangelogEntry): number {
  const byDecision = left.decisionRecordId.localeCompare(right.decisionRecordId);
  if (byDecision !== 0) {
    return byDecision;
  }
  return left.text.localeCompare(right.text);
}
