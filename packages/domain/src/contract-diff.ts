// Structural and semantic API contract diff with compatibility verdicts (issue #10).
//
// Pure, deterministic engine: the same inputs always produce the same diff and
// verdicts (no clocks, no randomness, sorted outputs). INV-004 is structural
// here: the grammatical verdict (additive/breaking/ambiguous/no-op) and the
// consumer-specific semantic impact are separate results with separate rule
// IDs, evidence and affected paths. Policies (org/API/consumer) are evaluated
// against the same diff, so the identical change can be allowed for one
// consumer and violate another's policy.

import type { CompatibilityPolicy, DependencyEdge } from './model.js';
import type { ServiceId } from './primitives.js';

// --- Normalized snapshots (the #5 importer's normalized shape) ---

export interface ResponseSnapshot {
  readonly status: string;
  readonly schema: unknown;
}

export interface OperationSnapshot {
  readonly method: string;
  readonly path: string;
  readonly requestSchema?: unknown;
  readonly responses: ReadonlyArray<ResponseSnapshot>;
  readonly security: ReadonlyArray<string>;
}

export interface ContractSnapshot {
  readonly title: string;
  readonly operations: ReadonlyArray<OperationSnapshot>;
}

// --- Findings ---

export type VerdictClassification = 'additive' | 'breaking' | 'ambiguous' | 'no-op';

export interface DiffFinding {
  readonly ruleId: string;
  readonly classification: VerdictClassification;
  // Grammatically additive but semantically risky for at least some consumers
  // (e.g. enum value added, nullability widened).
  readonly potentiallyBreaking: boolean;
  readonly affectedPath: string;
  readonly evidence: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface StructuralDiffResult {
  readonly fromChecksum: string;
  readonly toChecksum: string;
  readonly findings: ReadonlyArray<DiffFinding>;
  readonly verdict: VerdictClassification;
  readonly noChanges: boolean;
}

// --- Diff engine ---

export function diffContractSnapshots(from: ContractSnapshot, to: ContractSnapshot): StructuralDiffResult {
  const findings: DiffFinding[] = [];

  const fromOps = indexOperations(from);
  const toOps = indexOperations(to);

  for (const [key, operation] of fromOps) {
    const counterpart = toOps.get(key);
    if (counterpart === undefined) {
      findings.push({
        ruleId: 'operation-removed',
        classification: 'breaking',
        potentiallyBreaking: false,
        affectedPath: operationLabel(operation.method, operation.path),
        evidence: `operation ${key} exists in the source version but not in the target`,
        detail: {}
      });
      continue;
    }
    diffOperation(operation, counterpart, findings);
  }
  for (const [key, operation] of toOps) {
    if (!fromOps.has(key)) {
      findings.push({
        ruleId: 'operation-added',
        classification: 'additive',
        potentiallyBreaking: false,
        affectedPath: operationLabel(operation.method, operation.path),
        evidence: `operation ${key} is new in the target version`,
        detail: {}
      });
    }
  }

  const sorted = findings.slice().sort(compareFindings);
  const verdict = aggregateVerdict(sorted);
  return {
    fromChecksum: checksumOf(from),
    toChecksum: checksumOf(to),
    findings: sorted,
    verdict,
    noChanges: sorted.length === 0
  };
}

function indexOperations(snapshot: ContractSnapshot): Map<string, OperationSnapshot> {
  const index = new Map<string, OperationSnapshot>();
  for (const operation of snapshot.operations) {
    index.set(`${operation.method.toUpperCase()} ${operation.path}`, operation);
  }
  return index;
}

function operationLabel(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function diffOperation(from: OperationSnapshot, to: OperationSnapshot, findings: DiffFinding[]): void {
  const label = operationLabel(from.method, from.path);

  const fromSecurity = [...from.security].sort().join(',');
  const toSecurity = [...to.security].sort().join(',');
  if (fromSecurity !== toSecurity) {
    findings.push({
      ruleId: 'security-requirements-changed',
      classification: 'breaking',
      potentiallyBreaking: false,
      affectedPath: label,
      evidence: `security requirements changed from [${fromSecurity}] to [${toSecurity}]`,
      detail: { from: from.security, to: to.security }
    });
  }

  const fromResponses = new Map(from.responses.map((response) => [response.status, response.schema]));
  const toResponses = new Map(to.responses.map((response) => [response.status, response.schema]));
  for (const [status, schema] of fromResponses) {
    if (!toResponses.has(status)) {
      findings.push({
        ruleId: 'status-code-removed',
        classification: 'breaking',
        potentiallyBreaking: false,
        affectedPath: `${label}#response.${status}`,
        evidence: `response status ${status} was removed`,
        detail: {}
      });
      continue;
    }
    const counterpart = toResponses.get(status);
    if (counterpart !== undefined) {
      diffSchema(schema, counterpart, `${label}#response.${status}`, findings);
    }
  }
  for (const status of toResponses.keys()) {
    if (!fromResponses.has(status)) {
      findings.push({
        ruleId: 'status-code-added',
        classification: 'additive',
        potentiallyBreaking: false,
        affectedPath: `${label}#response.${status}`,
        evidence: `response status ${status} was added`,
        detail: {}
      });
    }
  }

  if (from.requestSchema !== undefined && to.requestSchema !== undefined) {
    diffSchema(from.requestSchema, to.requestSchema, `${label}#request`, findings);
  }
}

interface SchemaView {
  readonly type?: string | undefined;
  readonly format?: string | undefined;
  readonly nullable?: boolean | undefined;
  readonly enums: ReadonlyArray<string>;
  readonly required: ReadonlyArray<string>;
  readonly properties: ReadonlyArray<{ readonly name: string; readonly schema: unknown }>;
}

function asSchemaView(shape: unknown): SchemaView | undefined {
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) {
    return undefined;
  }
  const record = shape as Record<string, unknown>;
  const properties = record['properties'];
  const required = record['required'];
  const enums = record['enum'];
  return {
    type: typeof record['type'] === 'string' ? (record['type'] as string) : undefined,
    format: typeof record['format'] === 'string' ? (record['format'] as string) : undefined,
    nullable: typeof record['nullable'] === 'boolean' ? (record['nullable'] as boolean) : undefined,
    enums: Array.isArray(enums) ? enums.map((value) => String(value)) : [],
    required: Array.isArray(required) ? required.map((value) => String(value)) : [],
    properties: properties !== undefined && properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? Object.entries(properties as Record<string, unknown>).map(([name, schema]) => ({ name, schema }))
      : []
  };
}

function diffSchema(from: unknown, to: unknown, path: string, findings: DiffFinding[], depth = 0): void {
  const fromView = asSchemaView(from);
  const toView = asSchemaView(to);
  if (fromView === undefined || toView === undefined) {
    return;
  }

  if (fromView.type !== toView.type) {
    findings.push({
      ruleId: 'type-changed',
      classification: 'breaking',
      potentiallyBreaking: false,
      affectedPath: path,
      evidence: `type changed from '${fromView.type ?? 'untyped'}' to '${toView.type ?? 'untyped'}'`,
      detail: { from: fromView.type, to: toView.type }
    });
  }
  if (fromView.format !== toView.format) {
    findings.push({
      ruleId: 'format-changed',
      classification: 'breaking',
      potentiallyBreaking: false,
      affectedPath: path,
      evidence: `format changed from '${fromView.format ?? 'none'}' to '${toView.format ?? 'none'}'`,
      detail: { from: fromView.format, to: toView.format }
    });
  }
  if (fromView.nullable !== toView.nullable) {
    const widened = toView.nullable === true;
    findings.push({
      ruleId: 'nullability-changed',
      classification: widened ? 'additive' : 'breaking',
      potentiallyBreaking: widened,
      affectedPath: path,
      evidence: widened ? 'field became nullable (widening)' : 'field became non-nullable (narrowing)',
      detail: { from: fromView.nullable, to: toView.nullable }
    });
  }

  const fromEnums = new Set(fromView.enums);
  const toEnums = new Set(toView.enums);
  const addedEnums = toView.enums.filter((value) => !fromEnums.has(value));
  const removedEnums = fromView.enums.filter((value) => !toEnums.has(value));
  if (addedEnums.length > 0) {
    findings.push({
      ruleId: 'enum-value-added',
      classification: 'additive',
      potentiallyBreaking: true,
      affectedPath: path,
      evidence: `enum values added: [${addedEnums.join(', ')}]`,
      detail: { added: addedEnums }
    });
  }
  if (removedEnums.length > 0) {
    findings.push({
      ruleId: 'enum-value-removed',
      classification: 'breaking',
      potentiallyBreaking: false,
      affectedPath: path,
      evidence: `enum values removed: [${removedEnums.join(', ')}]`,
      detail: { removed: removedEnums }
    });
  }

  const fromRequired = new Set(fromView.required);
  const toRequired = new Set(toView.required);
  const propertyNames = new Set([...fromView.properties.map((property) => property.name), ...toView.properties.map((property) => property.name)]);
  for (const name of propertyNames) {
    const fromProperty = fromView.properties.find((property) => property.name === name);
    const toProperty = toView.properties.find((property) => property.name === name);
    const propertyPath = `${path}.${name}`;
    if (fromProperty === undefined && toProperty !== undefined) {
      const isRequired = toRequired.has(name);
      findings.push({
        ruleId: isRequired ? 'required-field-added' : 'field-added',
        classification: isRequired ? 'breaking' : 'additive',
        potentiallyBreaking: false,
        affectedPath: propertyPath,
        evidence: isRequired ? `required field '${name}' was added` : `optional field '${name}' was added`,
        detail: {}
      });
      continue;
    }
    if (fromProperty !== undefined && toProperty === undefined) {
      findings.push({
        ruleId: 'field-removed',
        classification: 'breaking',
        potentiallyBreaking: false,
        affectedPath: propertyPath,
        evidence: `field '${name}' was removed`,
        detail: {}
      });
      continue;
    }
    if (fromProperty !== undefined && toProperty !== undefined) {
      if (!fromRequired.has(name) && toRequired.has(name)) {
        findings.push({
          ruleId: 'required-field-added',
          classification: 'breaking',
          potentiallyBreaking: false,
          affectedPath: propertyPath,
          evidence: `field '${name}' became required`,
          detail: {}
        });
      }
      if (depth < 3) {
        diffSchema(fromProperty.schema, toProperty.schema, propertyPath, findings, depth + 1);
      }
    }
  }
}

function aggregateVerdict(findings: ReadonlyArray<DiffFinding>): VerdictClassification {
  if (findings.length === 0) {
    return 'no-op';
  }
  if (findings.some((finding) => finding.classification === 'breaking')) {
    return 'breaking';
  }
  if (findings.some((finding) => finding.potentiallyBreaking)) {
    return 'ambiguous';
  }
  if (findings.some((finding) => finding.classification === 'additive')) {
    return 'additive';
  }
  return 'no-op';
}

function compareFindings(left: DiffFinding, right: DiffFinding): number {
  const byPath = left.affectedPath.localeCompare(right.affectedPath);
  if (byPath !== 0) {
    return byPath;
  }
  return left.ruleId.localeCompare(right.ruleId);
}

function checksumOf(snapshot: ContractSnapshot): string {
  // Deterministic content hash without node:crypto (sync, order-sensitive).
  let hash = 0;
  const text = JSON.stringify(snapshot);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// --- Policy evaluation (org/API/consumer policies over the same diff) ---

export interface PolicyEvaluation {
  readonly policyOwner: string;
  readonly allowed: boolean;
  readonly violations: ReadonlyArray<DiffFinding>;
}

// INV-004: the policy verdict is separate from the structural verdict. The same
// diff can be allowed under one policy and violate another.
export function evaluateCompatibilityPolicy(
  diff: StructuralDiffResult,
  policy: CompatibilityPolicy,
  policyOwner: string
): PolicyEvaluation {
  const violations = diff.findings.filter((finding) => policyViolates(finding, policy));
  return { policyOwner, allowed: violations.length === 0, violations };
}

function policyViolates(finding: DiffFinding, policy: CompatibilityPolicy): boolean {
  switch (finding.ruleId) {
    case 'enum-value-added':
      return !policy.allowNewEnumValues;
    case 'required-field-added':
    case 'field-removed':
    case 'type-changed':
    case 'format-changed':
    case 'status-code-removed':
    case 'security-requirements-changed':
    case 'operation-removed':
      return true;
    case 'field-added':
    case 'status-code-added':
    case 'operation-added':
      return !policy.allowAdditiveFields;
    case 'nullability-changed':
      // A policy that disallows nullable changes rejects any nullability change,
      // whether widening or narrowing.
      return !policy.allowNullableChange;
    default:
      return false;
  }
}

// --- Consumer-specific semantic impact (INV-004: separate from structural) ---

export type SemanticRisk = 'none' | 'low' | 'medium' | 'high';

export interface SemanticImpactFinding {
  readonly ruleId: string;
  readonly risk: SemanticRisk;
  readonly blocking: boolean;
  readonly actionRequired: boolean;
  readonly affectedPath: string;
  readonly evidence: string;
}

export interface ConsumerSemanticImpact {
  readonly consumerServiceId: ServiceId;
  readonly overallRisk: SemanticRisk;
  readonly blocking: boolean;
  readonly actionRequired: boolean;
  readonly findings: ReadonlyArray<SemanticImpactFinding>;
}

const RISK_ORDER: ReadonlyArray<SemanticRisk> = ['none', 'low', 'medium', 'high'];

// Consumer semantic impact combines the structural diff with the consumer's
// Dependency Edge: which fields it actually uses, which policies it holds and
// which assumptions it declared. Conflicting assumptions are never averaged
// away; assumption evidence is quoted verbatim (INV-008).
export function assessConsumerSemanticImpact(diff: StructuralDiffResult, edge: DependencyEdge): ConsumerSemanticImpact {
  const findings: SemanticImpactFinding[] = [];
  const usedFields = new Set(edge.usage.fields);
  const usedStatuses = new Set([...edge.usage.statusValues, ...edge.usage.errorMeanings]);

  for (const finding of diff.findings) {
    const field = fieldOfPath(finding.affectedPath);
    switch (finding.ruleId) {
      case 'enum-value-added': {
        if (!usedFields.has(field)) {
          continue;
        }
        const disallows = !edge.compatibility.allowNewEnumValues;
        const assumption = edge.assumptions.find((candidate) => candidate.statement.toLowerCase().includes(field.toLowerCase()));
        const assumptionEvidence = assumption === undefined ? '' : `; declared assumption: "${assumption.statement}"`;
        findings.push({
          ruleId: 'semantic-unknown-enum',
          risk: disallows ? 'high' : 'medium',
          blocking: disallows,
          actionRequired: true,
          affectedPath: finding.affectedPath,
          evidence: disallows
            ? `consumer does not allow unknown enum values on '${field}' (${finding.evidence})${assumptionEvidence}`
            : `consumer must verify handling of new enum values on '${field}' (${finding.evidence})${assumptionEvidence}`
        });
        break;
      }
      case 'field-removed': {
        if (!usedFields.has(field)) {
          continue;
        }
        findings.push({
          ruleId: 'semantic-used-field-removed',
          risk: 'high',
          blocking: true,
          actionRequired: true,
          affectedPath: finding.affectedPath,
          evidence: `consumer uses field '${field}' which was removed (${finding.evidence})`
        });
        break;
      }
      case 'required-field-added': {
        if (!usedFields.has(field)) {
          continue;
        }
        findings.push({
          ruleId: 'semantic-required-field-assumed-present',
          risk: 'high',
          blocking: true,
          actionRequired: true,
          affectedPath: finding.affectedPath,
          evidence: `consumer treats '${field}' as effectively required but the contract change affects it (${finding.evidence})`
        });
        break;
      }
      case 'type-changed':
      case 'format-changed':
      case 'nullability-changed': {
        if (!usedFields.has(field)) {
          continue;
        }
        findings.push({
          ruleId: 'semantic-shape-changed-on-used-field',
          risk: 'high',
          blocking: true,
          actionRequired: true,
          affectedPath: finding.affectedPath,
          evidence: `shape of used field '${field}' changed (${finding.evidence})`
        });
        break;
      }
      case 'status-code-removed': {
        const status = finding.affectedPath.split('#response.')[1] ?? '';
        if (usedStatuses.size > 0 && ![...usedStatuses].some((candidate) => status.includes(candidate) || candidate.includes(status))) {
          continue;
        }
        findings.push({
          ruleId: 'semantic-error-meaning-changed',
          risk: 'high',
          blocking: true,
          actionRequired: true,
          affectedPath: finding.affectedPath,
          evidence: `response status ${status} disappeared while the consumer expects specific status/error meanings`
        });
        break;
      }
      default:
        break;
    }
  }

  const sorted = findings.slice().sort(compareSemanticFindings);
  const overallRisk = sorted.reduce<SemanticRisk>((worst, finding) => (RISK_ORDER.indexOf(finding.risk) > RISK_ORDER.indexOf(worst) ? finding.risk : worst), 'none');
  return {
    consumerServiceId: edge.consumerServiceId,
    overallRisk,
    blocking: sorted.some((finding) => finding.blocking),
    actionRequired: sorted.some((finding) => finding.actionRequired),
    findings: sorted
  };
}

function fieldOfPath(affectedPath: string): string {
  const segments = affectedPath.split('.');
  return segments[segments.length - 1] ?? '';
}

function compareSemanticFindings(left: SemanticImpactFinding, right: SemanticImpactFinding): number {
  const byPath = left.affectedPath.localeCompare(right.affectedPath);
  if (byPath !== 0) {
    return byPath;
  }
  return left.ruleId.localeCompare(right.ruleId);
}

// --- Human override (auditability) ---

// A human may override the engine's verdict, but only with a reason and a
// Decision Record reference; the override history stays auditable.
export function canOverrideVerdict(input: { readonly reason: string; readonly decisionRecordId?: string }): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.reason.trim().length === 0) {
    return { ok: false, reason: 'issue #10: an override requires an explicit reason' };
  }
  if (input.decisionRecordId === undefined || input.decisionRecordId.trim().length === 0) {
    return { ok: false, reason: 'issue #10: an override requires a Decision Record reference' };
  }
  return { ok: true };
}
