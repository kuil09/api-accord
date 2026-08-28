import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChangeProposalState, ContextItem } from './model.js';
import {
  canAcceptProposal,
  canConfirmContext,
  canCorrectContext,
  canMarkCompleted,
  canPublishContractVersion
} from './rules.js';
import { apiContractId, changeProposalId, contextItemId, contractVersionId, principalRef } from './primitives.js';

describe('domain rules', () => {
  it('blocks acceptance while a blocking objection is open (INV-005)', () => {
    const result = canAcceptProposal({ openBlockingObjections: 1, requiredApproversSatisfied: true });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.reason, /INV-005/);
  });

  it('allows acceptance when no blocking objection and approvers satisfied', () => {
    const result = canAcceptProposal({ openBlockingObjections: 0, requiredApproversSatisfied: true });
    assert.equal(result.ok, true);
  });

  it('blocks completion until every lifecycle state holds (INV-002, INV-006)', () => {
    const base: ChangeProposalState = {
      id: changeProposalId('p1'),
      contractId: apiContractId('c1'),
      title: 'x',
      phase: 'opened',
      accepted: true,
      implemented: false,
      consumerReady: false,
      verified: false,
      deployed: false,
      observed: false,
      outcome: 'none',
      openBlockingObjections: 0,
      requiredApproversSatisfied: true,
      consumerMigrationComplete: false
    };
    assert.equal(canMarkCompleted(base).ok, false);
    const done: ChangeProposalState = {
      ...base,
      implemented: true,
      verified: true,
      deployed: true,
      observed: true,
      consumerMigrationComplete: true
    };
    assert.equal(canMarkCompleted(done).ok, true);
  });

  it('requires source/author/validFrom for confirmed context (INV-011)', () => {
    assert.equal(
      canConfirmContext({ source: '', author: principalRef('human', 'a'), scope: 'operation', validFrom: new Date() }).ok,
      false
    );
    assert.equal(
      canConfirmContext({ source: 'doc', author: principalRef('human', 'a'), scope: 'operation', validFrom: new Date() }).ok,
      true
    );
  });

  it('allows a single correction but rejects a second (INV-012)', () => {
    const clean: ContextItem = {
      id: contextItemId('c1'),
      scope: 'operation',
      statement: 'x',
      contextType: 'assumption',
      author: principalRef('human', 'a'),
      source: 'doc',
      confidence: 'confirmed',
      visibility: 'organization',
      disputed: false,
      validFrom: new Date()
    };
    assert.equal(canCorrectContext(clean).ok, true);
    const corrected: ContextItem = { ...clean, correctedBy: contextItemId('c2') };
    assert.equal(canCorrectContext(corrected).ok, false);
  });

  it('rejects republishing an immutable contract version (INV-003)', () => {
    const existing = [contractVersionId('v1')];
    assert.equal(canPublishContractVersion(existing, contractVersionId('v1')).ok, false);
    assert.equal(canPublishContractVersion(existing, contractVersionId('v2')).ok, true);
  });
});
