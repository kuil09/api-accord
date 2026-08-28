import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConsumerImpactSummary, Notification } from './index.js';
import { InMemoryEventStore } from './events.js';
import {
  NotificationService,
  buildActionInbox,
  generateNotificationsFromProposal,
  notificationsFrom,
  shouldNotifyNow,
  subscriptionCovers,
  withFallbackOwner
} from './notification.js';
import { changeProposalId, principalRef } from './primitives.js';

const human = principalRef('human', 'payments-owner');
const now = new Date('2026-06-15T00:00:00Z');

const impacts: ReadonlyArray<ConsumerImpactSummary> = [
  { consumerServiceId: 'merchant-console' as never, impact: 'blocking', requiredActions: [{ kind: 'code-change', description: 'update parser', evidencePath: 'status' }] },
  { consumerServiceId: 'mobile-app' as never, impact: 'action-required', requiredActions: [{ kind: 'code-change', description: 'map REVERSED', evidencePath: 'status' }] },
  { consumerServiceId: 'refunds-only' as never, impact: 'none', requiredActions: [] }
];

describe('notification generation (issue #15)', () => {
  const input = {
    proposalId: changeProposalId('p-notify'),
    proposalTitle: 'Add REVERSED',
    accepted: true,
    openBlockingObjections: 0,
    missingApprovers: [principalRef('human', 'merchant-owner')],
    consumerImpacts: impacts,
    consumerRecipients: [
      { consumerServiceId: 'merchant-console' as never, team: { kind: 'team' as const, id: 'team-merchant' }, deadline: new Date('2026-10-01T00:00:00Z') },
      { consumerServiceId: 'mobile-app' as never, team: { kind: 'team' as const, id: 'team-mobile' }, deadline: new Date('2027-02-01T00:00:00Z') }
    ],
    providerTeam: { kind: 'team' as const, id: 'team-payments' },
    channel: 'in-app' as const,
    now
  };

  it('targets only affected parties with reasons, actions, deadlines and blocking flags', () => {
    const dispatches = generateNotificationsFromProposal(input);
    const byKindRecipient = dispatches.map((dispatch) => [dispatch.kind, dispatch.recipient.id, dispatch.blocking]);
    assert.ok(byKindRecipient.some(([kind, recipient]) => kind === 'approval-request' && recipient === 'merchant-owner'));
    assert.ok(byKindRecipient.some(([kind, recipient, blocking]) => kind === 'implementation-request' && recipient === 'team-merchant' && blocking === true));
    assert.ok(byKindRecipient.some(([kind, recipient, blocking]) => kind === 'migration-request' && recipient === 'team-mobile' && blocking === false));
    assert.ok(byKindRecipient.some(([kind, recipient]) => kind === 'informational-change' && recipient === 'refunds-only'));
    const merchant = dispatches.find((dispatch) => dispatch.recipient.id === 'team-merchant');
    assert.equal(merchant?.deadline?.getTime(), new Date('2026-10-01T00:00:00Z').getTime());
    assert.match(merchant?.requiredAction ?? '', /update parser/u);
  });

  it('before acceptance, blocking consumers get a review request instead of implementation', () => {
    const dispatches = generateNotificationsFromProposal({ ...input, accepted: false, openBlockingObjections: 1 });
    assert.ok(dispatches.some((dispatch) => dispatch.kind === 'review-request' && dispatch.recipient.id === 'team-merchant'));
    assert.ok(!dispatches.some((dispatch) => dispatch.kind === 'implementation-request'));
    assert.ok(dispatches.some((dispatch) => dispatch.kind === 'review-request' && dispatch.recipient.id === 'team-payments'), 'provider is asked to resolve objections');
  });

  it('dedup keys keep repeats of the same event foldable', () => {
    const dispatches = generateNotificationsFromProposal(input);
    const keys = dispatches.map((dispatch) => dispatch.dedupKey);
    assert.equal(new Set(keys).size, keys.length, 'dedup keys are unique per kind+recipient+proposal');
  });
});

describe('digest policy (issue #15)', () => {
  it('immediate kinds bypass digest preference; others follow it', () => {
    assert.equal(shouldNotifyNow('approval-request', 'weekly'), true);
    assert.equal(shouldNotifyNow('deployment-blocked', 'weekly'), true);
    assert.equal(shouldNotifyNow('contract-drift', 'daily'), true);
    assert.equal(shouldNotifyNow('informational-change', 'daily'), false);
    assert.equal(shouldNotifyNow('informational-change', 'immediate'), true);
  });

  it('subscriptions cover their target', () => {
    const subscription = {
      subscriptionId: 's1',
      subscriber: { kind: 'team' as const, id: 'team-merchant' },
      scope: 'service' as const,
      targetId: 'merchant-console',
      digest: 'immediate' as const,
      declaredBy: human,
      declaredAt: now
    };
    assert.equal(subscriptionCovers(subscription, 'merchant-console'), true);
    assert.equal(subscriptionCovers(subscription, 'mobile-app'), false);
  });
});

describe('notification projection and status changes (issue #15)', () => {
  it('folds duplicate dispatches by dedup key with occurrence tracking', async () => {
    const store = new InMemoryEventStore();
    const service = new NotificationService(store);
    const base = {
      actor: human,
      notificationId: 'n-1',
      dedupKey: 'approval-request:merchant-owner:p1',
      kind: 'approval-request' as const,
      recipient: { kind: 'principal' as const, id: 'merchant-owner' },
      reason: 'awaits approval',
      blocking: true,
      link: { proposalId: changeProposalId('p1') },
      channel: 'in-app' as const
    };
    await service.dispatchNotification({ ...base, at: new Date('2026-01-01T00:00:00Z') });
    await service.dispatchNotification({ ...base, at: new Date('2026-01-02T00:00:00Z') });

    const notifications = notificationsFrom(await store.getAll());
    assert.equal(notifications.length, 1, 'duplicate dispatches fold into one notification');
    assert.equal(notifications[0]?.occurrences, 2);
    assert.equal(notifications[0]?.status, 'unread');
  });

  it('status transitions: read, snooze with expiry, resolve', async () => {
    const store = new InMemoryEventStore();
    const service = new NotificationService(store);
    const base = {
      actor: human,
      notificationId: 'n-2',
      dedupKey: 'k-2',
      kind: 'implementation-request' as const,
      recipient: { kind: 'team' as const, id: 'team-merchant' },
      reason: 'implement',
      blocking: true,
      link: { proposalId: changeProposalId('p2') },
      channel: 'in-app' as const,
      at: now
    };
    await service.dispatchNotification(base);
    await service.changeNotificationStatus({ actor: human, notificationId: 'n-2', dedupKey: 'k-2', status: 'snoozed', snoozedUntil: new Date('2026-07-01T00:00:00Z') });
    let notifications = notificationsFrom(await store.getAll());
    assert.equal(notifications[0]?.status, 'snoozed');
    assert.equal(notifications[0]?.snoozedUntil?.getTime(), new Date('2026-07-01T00:00:00Z').getTime());
    await service.changeNotificationStatus({ actor: human, notificationId: 'n-2', dedupKey: 'k-2', status: 'resolved' });
    notifications = notificationsFrom(await store.getAll());
    assert.equal(notifications[0]?.status, 'resolved');
    assert.equal(notifications[0]?.snoozedUntil, undefined, 'resolving clears the snooze');
  });
});

describe('personal action inbox (issue #15)', () => {
  function notification(input: { id: string; kind: Notification['kind']; recipient: string; deadline?: Date; status?: Notification['status'] }): Notification {
    return {
      notificationId: input.id,
      dedupKey: input.id,
      kind: input.kind,
      recipient: { kind: 'team', id: input.recipient },
      reason: 'r',
      requiredAction: undefined,
      deadline: input.deadline,
      blocking: input.kind === 'approval-request',
      link: {},
      channel: 'in-app',
      status: input.status ?? 'unread',
      occurrences: 1,
      createdAt: now,
      updatedAt: now
    };
  }

  it('routes notifications into the five inbox sections', () => {
    const inbox = buildActionInbox({
      recipient: { kind: 'team', id: 'team-merchant' },
      notifications: [
        notification({ id: 'a', kind: 'approval-request', recipient: 'team-merchant' }),
        notification({ id: 'b', kind: 'implementation-request', recipient: 'team-merchant' }),
        notification({ id: 'c', kind: 'context-review', recipient: 'team-merchant' }),
        notification({ id: 'd', kind: 'migration-request', recipient: 'team-merchant', deadline: new Date('2026-01-01T00:00:00Z') }),
        notification({ id: 'e', kind: 'informational-change', recipient: 'team-merchant' })
      ],
      now
    });
    assert.equal(inbox.awaitingMyApproval.length, 1);
    assert.equal(inbox.awaitingMyImplementation.length, 2, 'implementation + migration requests');
    assert.equal(inbox.contextsToReview.length, 1);
    assert.equal(inbox.overdue.length, 1, 'passed deadline lands in overdue');
    assert.equal(inbox.informational.length, 1);
  });

  it('resolved items leave the actionable sections (INV-023-style honesty)', () => {
    const inbox = buildActionInbox({
      recipient: { kind: 'team', id: 'team-merchant' },
      notifications: [notification({ id: 'a', kind: 'approval-request', recipient: 'team-merchant', status: 'resolved' })],
      now
    });
    assert.equal(inbox.awaitingMyApproval.length, 0);
  });

  it('fallback owner applies when the primary is absent', () => {
    const fallback = withFallbackOwner({ primary: undefined, fallbackOwner: { kind: 'team', id: 'team-fallback' }, primaryAbsent: true });
    assert.equal(fallback.id, 'team-fallback');
    const kept = withFallbackOwner({ primary: { kind: 'team', id: 'team-primary' }, fallbackOwner: { kind: 'team', id: 'team-fallback' }, primaryAbsent: false });
    assert.equal(kept.id, 'team-primary');
  });
});
