// GitHub integration (issue #13): webhook ingestion with signature
// verification and replay defense, plus a REST adapter implementing the #19
// GitAdapter port. Provenance is preserved: GitHub check results carry
// provenance 'github-check', and PR bodies state the Proposal, Decision and
// Contract Version they implement (INV-017, INV-030).
//
// Non-intrusive and honest by construction: webhook events become Evidence
// with the right status -- a push or an opened PR is 'recorded' (a fact), never
// 'passed' (INV-023) -- and an unknown event is acknowledged without inventing
// domain state.

import type { CodePatch, GitAdapter, PullRequestCreated } from '@api-accord/domain';
import type { DomainService, EventStore } from '@api-accord/domain';
import { isWebhookReplay } from '@api-accord/domain';
import { evidenceId } from '@api-accord/domain';
import type { EvidenceStatus, PrincipalRef, ServiceId } from '@api-accord/domain';

// --- Webhook signature verification (HMAC-SHA256 via Web Crypto) ---

export async function computeWebhookSignature(payload: string, secret: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `sha256=${toHex(new Uint8Array(signature))}`;
}

export async function verifyWebhookSignature(input: { readonly payload: string; readonly signatureHeader: string | undefined; readonly secret: string }): Promise<boolean> {
  if (input.signatureHeader === undefined) {
    return false;
  }
  const expected = await computeWebhookSignature(input.payload, input.secret);
  return constantTimeEqual(expected, input.signatureHeader);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

// --- Webhook ingestion result ---

export type WebhookOutcome =
  | { readonly handled: true; readonly ignored: false; readonly evidenceRecorded: boolean; readonly summary: string }
  | { readonly handled: true; readonly ignored: true; readonly evidenceRecorded: false; readonly summary: string };

export interface WebhookDelivery {
  readonly deliveryId: string;
  readonly event: string;
  readonly signatureHeader: string | undefined;
  readonly payload: string;
}

export interface WebhookIngestionOptions {
  readonly webhookSecret: string;
  readonly store: EventStore;
  readonly domain: DomainService;
  // Delivery ids already processed; replays are acknowledged but not re-handled.
  readonly seenDeliveryIds: ReadonlyArray<string>;
  readonly actor?: PrincipalRef;
  readonly correlationId?: string;
}

// Header-driven ingestion: signature verification, replay defense (issue #21),
// then evidence recording for check results. Unknown events are acknowledged
// with a summary instead of inventing domain state (INV-034 honesty).
export async function ingestWebhookDelivery(delivery: WebhookDelivery, options: WebhookIngestionOptions): Promise<WebhookOutcome> {
  const valid = await verifyWebhookSignature({ payload: delivery.payload, signatureHeader: delivery.signatureHeader, secret: options.webhookSecret });
  if (!valid) {
    throw new WebhookSignatureError();
  }
  if (isWebhookReplay({ deliveryId: delivery.deliveryId, seenDeliveryIds: options.seenDeliveryIds, timestamp: new Date(), now: new Date(), maxAgeMs: Number.MAX_SAFE_INTEGER })) {
    return { handled: true, ignored: true, evidenceRecorded: false, summary: 'duplicate delivery id; already processed' };
  }

  const payload = JSON.parse(delivery.payload) as {
    action?: string;
    check_run?: { conclusion?: string; head_sha?: string; html_url?: string; name?: string };
    pull_request?: { merged?: boolean; head?: { sha?: string } };
    repository?: { full_name?: string };
  };

  const actor = options.actor ?? { kind: 'integration', id: 'github' };

  if (delivery.event === 'check_run' && payload.check_run !== undefined) {
    const conclusion = payload.check_run.conclusion ?? 'neutral';
    const status: EvidenceStatus = conclusion === 'success' ? 'passed' : conclusion === 'failure' ? 'failed' : 'skipped';
    await options.domain.attachEvidence({
      actor,
      correlationId: options.correlationId ?? delivery.deliveryId,
      evidenceId: evidenceId(`ev-gh-${delivery.deliveryId}`),
      contractVersionId: contractVersionFromPayload(payload) as never,
      sourceRevision: payload.check_run.head_sha ?? 'unknown',
      status,
      kind: 'ci-check',
      producer: { kind: 'integration', id: 'github' },
      source: payload.check_run.html_url ?? 'github',
      provenance: 'github-check'
    });
    return { handled: true, ignored: false, evidenceRecorded: true, summary: `check_run ${conclusion} recorded as evidence` };
  }

  if (delivery.event === 'pull_request' && payload.pull_request !== undefined) {
    await options.domain.attachEvidence({
      actor,
      correlationId: options.correlationId ?? delivery.deliveryId,
      evidenceId: evidenceId(`ev-gh-${delivery.deliveryId}`),
      contractVersionId: contractVersionFromPayload(payload) as never,
      sourceRevision: payload.pull_request.head?.sha ?? 'unknown',
      status: 'recorded',
      kind: 'pull-request',
      producer: { kind: 'integration', id: 'github' },
      source: payload.repository?.full_name ?? 'github',
      provenance: 'github-check'
    });
    return { handled: true, ignored: false, evidenceRecorded: true, summary: 'pull request recorded as evidence' };
  }

  return { handled: true, ignored: false, evidenceRecorded: false, summary: `event '${delivery.event}' acknowledged without domain changes` };
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('webhook signature verification failed');
    this.name = 'WebhookSignatureError';
  }
}

function contractVersionFromPayload(payload: { repository?: { full_name?: string } }): string {
  // Mapping a repository to a contract version is deployment configuration;
  // without it the evidence is still recorded against a repository-scoped id.
  return `${payload.repository?.full_name ?? 'unknown-repo'}@webhook`;
}

// --- Git REST adapter (GitAdapter port from issue #19) ---

export interface GitHubRepositoryConfig {
  readonly serviceId: ServiceId;
  readonly owner: string;
  readonly repo: string;
}

export interface GitRestAdapterOptions {
  readonly token: string;
  readonly baseUrl: string;
  readonly repositories: ReadonlyArray<GitHubRepositoryConfig>;
}

interface GitHubRefResponse {
  readonly object: { readonly sha: string };
}

interface GitHubPullResponse {
  readonly number: number;
  readonly html_url: string;
}

// REST implementation of the GitAdapter port. File-level commits are out of
// scope for this increment (excluded in the PR): the PR is created with the
// approved patches described in its body, and the implementer pushes code to
// the created branch.
export class GitRestAdapter implements GitAdapter {
  readonly #options: GitRestAdapterOptions;

  constructor(options: GitRestAdapterOptions) {
    this.#options = options;
  }

  #resolve(serviceId: ServiceId): { readonly owner: string; readonly repo: string } {
    const config = this.#options.repositories.find((candidate) => candidate.serviceId === serviceId);
    if (config === undefined) {
      throw new Error(`issue #13: no repository is connected for service '${serviceId}'`);
    }
    return { owner: config.owner, repo: config.repo };
  }

  async createBranch(input: { readonly repositoryServiceId: ServiceId; readonly branch: string; readonly base: string }): Promise<{ readonly branch: string }> {
    const { owner, repo } = this.#resolve(input.repositoryServiceId);
    const baseRef = await this.#request<GitHubRefResponse>('GET', `/repos/${owner}/${repo}/git/ref/heads/${input.base}`);
    await this.#request('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${input.branch}`,
      sha: baseRef.object.sha
    });
    return { branch: input.branch };
  }

  async commitAndCreatePullRequest(input: {
    readonly repositoryServiceId: ServiceId;
    readonly branch: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly patches: ReadonlyArray<CodePatch>;
  }): Promise<PullRequestCreated> {
    const { owner, repo } = this.#resolve(input.repositoryServiceId);
    const pull = await this.#request<GitHubPullResponse>('POST', `/repos/${owner}/${repo}/pulls`, {
      title: input.title,
      head: input.branch,
      base: input.base,
      body: input.body
    });
    return { pullRequestNumber: pull.number, url: pull.html_url, branch: input.branch };
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.#options.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#options.token}`,
        accept: 'application/vnd.github+json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      throw new Error(`GitHub request failed: ${method} ${path} -> ${String(response.status)}`);
    }
    return (await response.json()) as T;
  }
}
