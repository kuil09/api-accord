// Impact-based notifications and the personal action inbox (issue #15).
//
// Notifications target actual affected parties -- recipients come from
// dependency edges, required approvals and impact analysis, never broadcast.
// Duplicate occurrences of the same event fold into one notification via a
// dedup key, with status updates applied instead of new entries. The ledger is
// the audit trail: dispatches and status changes are events (INV-030).

import type { EventEnvelope, DomainEvent, EventStore } from './events.js';
import type { ChangeProposalId, PrincipalRef } from './primitives.js';
import type { ConsumerImpactSummary } from './compiler.js';

export type NotificationKind =
  | 'informational-change'
  | 'review-request'
  | 'approval-request'
  | 'implementation-request'
  | 'migration-request'
  | 'deployment-blocked'
  | 'deprecation-deadline'
  | 'contract-drift'
  | 'context-review';

export type NotificationStatus = 'unread' | 'read' | 'acknowledged' | 'snoozed' | 'resolved';

export type DigestPreference = 'immediate' | 'daily' | 'weekly';

export interface Recipient {
  readonly kind: 'principal' | 'team';
  readonly id: string;
}

export interface NotificationLink {
  readonly proposalId?: ChangeProposalId | undefined;
  readonly operationId?: string | undefined;
  readonly evidenceRef?: string | undefined;
}

export interface Notification {
  readonly notificationId: string;
  readonly dedupKey: string;
  readonly kind: NotificationKind;
  readonly recipient: Recipient;
  readonly reason: string;
  readonly requiredAction?: string | undefined;
  readonly deadline?: Date | undefined;
  readonly blocking: boolean;
  readonly link: NotificationLink;
  readonly channel: 'in-app' | 'email' | 'webhook';
  readonly status: NotificationStatus;
  readonly assignee?: Recipient | undefined;
  readonly snoozedUntil?: Date | undefined;
  readonly occurrences: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// --- Subscriptions (explicit + auto impact subscriptions) ---

export interface Subscription {
  readonly subscriptionId: string;
  readonly subscriber: Recipient;
  readonly scope: 'service' | 'operation' | 'proposal';
  readonly targetId: string;
  readonly digest: DigestPreference;
  readonly declaredBy: PrincipalRef;
  readonly declaredAt: Date;
}

export function subscriptionCovers(subscription: Subscription, targetId: string): boolean {
  if (subscription.scope === 'proposal') {
    return subscription.targetId === targetId;
  }
  // Service/operation subscriptions cover anything referencing the target.
  return targetId.includes(subscription.targetId);
}

// Immediate delivery is reserved for actionable or blocking kinds; everything
// else follows the subscriber's digest preference.
export function shouldNotifyNow(kind: NotificationKind, digest: DigestPreference): boolean {
  const immediateKinds: ReadonlyArray<NotificationKind> = [
    'approval-request',
    'deployment-blocked',
    'contract-drift',
    'migration-request'
  ];
  if (immediateKinds.includes(kind)) {
    return true;
  }
  return digest === 'immediate';
}

// --- Dispatch record (input to the ledger command) ---

export interface DispatchInput {
  readonly notificationId: string;
  readonly dedupKey: string;
  readonly kind: NotificationKind;
  readonly recipient: Recipient;
  readonly reason: string;
  readonly requiredAction?: string | undefined;
  readonly deadline?: Date | undefined;
  readonly blocking: boolean;
  readonly link: NotificationLink;
  readonly channel: 'in-app' | 'email' | 'webhook';
  readonly at: Date;
}

// --- Projection ---

// Folds dispatched notifications by dedup key (동일 사건 중복 병합) and applies
// status-change events, keeping one notification with occurrence and update
// tracking instead of a pile of duplicates.
export function notificationsFrom(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ReadonlyArray<Notification> {
  const byKey = new Map<string, Notification>();

  const stream = events
    .filter((envelope) => envelope.event.type === 'NotificationDispatched' || envelope.event.type === 'NotificationStatusChanged')
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.version - right.version);

  for (const envelope of stream) {
    const event = envelope.event;
    if (event.type === 'NotificationDispatched') {
      const existing = byKey.get(event.dedupKey);
      if (existing === undefined) {
        byKey.set(event.dedupKey, {
          notificationId: event.notificationId,
          dedupKey: event.dedupKey,
          kind: event.kind,
          recipient: event.recipient,
          reason: event.reason,
          requiredAction: event.requiredAction,
          deadline: event.deadline,
          blocking: event.blocking,
          link: event.link,
          channel: event.channel,
          status: 'unread',
          occurrences: 1,
          createdAt: event.at,
          updatedAt: event.at
        });
      } else {
        byKey.set(event.dedupKey, { ...existing, occurrences: existing.occurrences + 1, updatedAt: event.at });
      }
      continue;
    }
    if (event.type === 'NotificationStatusChanged') {
      const existing = byKey.get(event.dedupKey);
      if (existing === undefined) {
        continue;
      }
      byKey.set(event.dedupKey, {
        ...existing,
        status: event.status,
        updatedAt: event.at,
        snoozedUntil: event.snoozedUntil !== undefined
          ? event.snoozedUntil
          : event.status === 'snoozed'
            ? existing.snoozedUntil
            : undefined,
        assignee: event.assignee ?? existing.assignee
      });
    }
  }

  return [...byKey.values()].sort((left, right) => left.notificationId.localeCompare(right.notificationId));
}

// --- Personal action inbox ---

export interface ActionInbox {
  readonly recipient: Recipient;
  readonly awaitingMyApproval: ReadonlyArray<Notification>;
  readonly awaitingMyImplementation: ReadonlyArray<Notification>;
  readonly contextsToReview: ReadonlyArray<Notification>;
  readonly overdue: ReadonlyArray<Notification>;
  readonly informational: ReadonlyArray<Notification>;
}

// Overdue means a deadline exists, has passed, and the notification is not
// resolved. Resolved items never appear in any actionable section.
export function buildActionInbox(input: { readonly recipient: Recipient; readonly notifications: ReadonlyArray<Notification>; readonly now: Date }): ActionInbox {
  // Actionable = unread/read only. acknowledged and resolved leave the
  // actionable sections; a snoozed item returns after its snooze expires.
  const mine = input.notifications.filter((notification) => {
    if (notification.recipient.id !== input.recipient.id) return false;
    if (notification.status === 'resolved' || notification.status === 'acknowledged') return false;
    if (notification.status === 'snoozed' && notification.snoozedUntil !== undefined && notification.snoozedUntil.getTime() > input.now.getTime()) return false;
    return true;
  });
  const overdue = mine.filter((notification) => notification.deadline !== undefined && notification.deadline.getTime() < input.now.getTime());
  return {
    recipient: input.recipient,
    awaitingMyApproval: mine.filter((notification) => notification.kind === 'approval-request'),
    awaitingMyImplementation: mine.filter((notification) => notification.kind === 'implementation-request' || notification.kind === 'migration-request'),
    contextsToReview: mine.filter((notification) => notification.kind === 'context-review'),
    overdue,
    informational: mine.filter((notification) => notification.kind === 'informational-change' && !overdue.includes(notification))
  };
}

// --- Fallback owner (팀 교체·담당자 부재) ---

export function withFallbackOwner(input: { readonly primary?: Recipient | undefined; readonly fallbackOwner?: Recipient | undefined; readonly primaryAbsent: boolean }): Recipient {
  if (input.primary === undefined || (input.primaryAbsent && input.fallbackOwner !== undefined)) {
    if (input.fallbackOwner !== undefined) {
      return input.fallbackOwner;
    }
  }
  return input.primary ?? input.fallbackOwner ?? { kind: 'team', id: 'unassigned' };
}

// --- Notification generation from proposal state and impact (issue #15) ---

export interface NotificationGenerationInput {
  readonly proposalId: ChangeProposalId;
  readonly proposalTitle: string;
  readonly accepted: boolean;
  readonly openBlockingObjections: number;
  readonly missingApprovers: ReadonlyArray<{ readonly id: string }>;
  readonly consumerImpacts: ReadonlyArray<ConsumerImpactSummary>;
  // Consumer team recipients with optional migration deadlines.
  readonly consumerRecipients: ReadonlyArray<{ readonly consumerServiceId: string; readonly team: Recipient; readonly deadline?: Date | undefined }>;
  readonly providerTeam: Recipient;
  readonly channel: 'in-app' | 'email' | 'webhook';
  readonly now: Date;
}

function linkFor(proposalId: ChangeProposalId): NotificationLink {
  return { proposalId };
}

// Deterministic notification generation: only actual affected parties get a
// notification, each with its reason, required action, deadline and blocking
// flag. Dedup keys keep repeats of the same event folded by the projection.
export function generateNotificationsFromProposal(input: NotificationGenerationInput): ReadonlyArray<DispatchInput> {
  const dispatches: DispatchInput[] = [];
  let sequence = 0;
  const nextId = (): string => `notif-${input.proposalId}-${String(sequence + 1)}`;
  const push = (dispatch: Omit<DispatchInput, 'notificationId' | 'at' | 'link'> & { readonly operationId?: string | undefined }): void => {
    sequence += 1;
    dispatches.push({
      notificationId: nextId(),
      at: input.now,
      link: linkFor(input.proposalId),
      ...dispatch
    });
  };

  if (!input.accepted && input.openBlockingObjections > 0) {
    push({
      dedupKey: `review-request:${input.providerTeam.id}:${input.proposalId}`,
      kind: 'review-request',
      recipient: input.providerTeam,
      reason: `${String(input.openBlockingObjections)} blocking objection(s) must be resolved before acceptance`,
      blocking: true,
      channel: input.channel
    });
  }

  for (const approver of input.missingApprovers) {
    const recipient: Recipient = { kind: 'principal', id: approver.id };
    push({
      dedupKey: `approval-request:${approver.id}:${input.proposalId}`,
      kind: 'approval-request',
      recipient,
      reason: `'${input.proposalTitle}' awaits your approval`,
      requiredAction: 'review and approve the change proposal',
      blocking: true,
      channel: input.channel
    });
  }

  for (const impact of input.consumerImpacts) {
    const recipient = input.consumerRecipients.find((entry) => entry.consumerServiceId === impact.consumerServiceId)?.team ?? { kind: 'team' as const, id: impact.consumerServiceId };
    const deadline = input.consumerRecipients.find((entry) => entry.consumerServiceId === impact.consumerServiceId)?.deadline;
    const dedupBase = `${impact.consumerServiceId}:${input.proposalId}`;

    if (impact.impact === 'blocking') {
      if (input.accepted) {
        push({
          dedupKey: `implementation-request:${dedupBase}`,
          kind: 'implementation-request',
          recipient,
          reason: `blocking impact on '${impact.consumerServiceId}': implementation required before go-live`,
          requiredAction: impact.requiredActions.map((action) => action.description).join('; '),
          deadline,
          blocking: true,
          channel: input.channel
        });
      } else {
        push({
          dedupKey: `review-request:${dedupBase}`,
          kind: 'review-request',
          recipient,
          reason: `blocking impact on '${impact.consumerServiceId}' needs review before acceptance`,
          requiredAction: impact.requiredActions.map((action) => action.description).join('; '),
          deadline,
          blocking: true,
          channel: input.channel
        });
      }
      continue;
    }
    if (impact.impact === 'action-required') {
      if (input.accepted) {
        push({
          dedupKey: `migration-request:${dedupBase}`,
          kind: 'migration-request',
          recipient,
          reason: `migration required on '${impact.consumerServiceId}'`,
          requiredAction: impact.requiredActions.map((action) => action.description).join('; '),
          deadline,
          blocking: false,
          channel: input.channel
        });
      } else {
        push({
          dedupKey: `informational-change:${dedupBase}`,
          kind: 'informational-change',
          recipient,
          reason: `action-required impact on '${impact.consumerServiceId}' will follow acceptance`,
          blocking: false,
          channel: input.channel
        });
      }
      continue;
    }
    if (impact.impact === 'none' || impact.impact === 'informational') {
      push({
        dedupKey: `informational-change:${dedupBase}`,
        kind: 'informational-change',
        recipient,
        reason: `impact level '${impact.impact}' on '${impact.consumerServiceId}'`,
        blocking: false,
        channel: input.channel
      });
    }
    // 'unknown' stays silent here: the impact analysis already demands the
    // consumer declare usage (INV-009) before acting on it.
  }

  return dispatches;
}

// --- Service commands (audit events over the shared ledger) ---

export class NotificationService {
  readonly #store: EventStore;

  constructor(store: EventStore) {
    this.#store = store;
  }

  async dispatchNotification(input: {
    readonly actor: PrincipalRef;
    readonly correlationId?: string;
  } & DispatchInput): Promise<void> {
    await this.#store.append({
      actor: input.actor,
      correlationId: input.correlationId ?? 'notification-service',
      event: {
        type: 'NotificationDispatched',
        notificationId: input.notificationId,
        dedupKey: input.dedupKey,
        kind: input.kind,
        recipient: input.recipient,
        reason: input.reason,
        requiredAction: input.requiredAction,
        deadline: input.deadline,
        blocking: input.blocking,
        link: input.link,
        channel: input.channel,
        at: input.at
      },
      expectedVersion: await this.#currentVersion('notification', input.notificationId)
    });
  }

  async changeNotificationStatus(input: {
    readonly actor: PrincipalRef;
    readonly correlationId?: string;
    readonly notificationId: string;
    readonly dedupKey: string;
    readonly status: NotificationStatus;
    readonly snoozedUntil?: Date | undefined;
    readonly assignee?: Recipient | undefined;
  }): Promise<void> {
    await this.#store.append({
      actor: input.actor,
      correlationId: input.correlationId ?? 'notification-service',
      event: {
        type: 'NotificationStatusChanged',
        notificationId: input.notificationId,
        dedupKey: input.dedupKey,
        status: input.status,
        snoozedUntil: input.snoozedUntil,
        assignee: input.assignee,
        at: new Date()
      },
      expectedVersion: await this.#currentVersion('notification', input.notificationId)
    });
  }

  async declareSubscription(input: {
    readonly actor: PrincipalRef;
    readonly correlationId?: string;
    readonly subscriptionId: string;
    readonly subscriber: Recipient;
    readonly scope: 'service' | 'operation' | 'proposal';
    readonly targetId: string;
    readonly digest: DigestPreference;
  }): Promise<void> {
    await this.#store.append({
      actor: input.actor,
      correlationId: input.correlationId ?? 'notification-service',
      event: {
        type: 'SubscriptionDeclared',
        subscriptionId: input.subscriptionId,
        subscriber: input.subscriber,
        scope: input.scope,
        targetId: input.targetId,
        digest: input.digest,
        declaredBy: input.actor,
        at: new Date()
      },
      expectedVersion: await this.#currentVersion('subscription', input.subscriptionId)
    });
  }

  async #currentVersion(aggregateType: 'notification' | 'subscription', aggregateId: string): Promise<number> {
    const stream = await this.#store.getStream(aggregateType, aggregateId);
    const last = stream[stream.length - 1];
    return last?.version ?? 0;
  }
}
