import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError } from '../src/domain/errors.js';
import { buildChain, registerRun, ingest } from './helpers.js';

describe('quality review against the frozen execution snapshot', () => {
  it('approves the batch when frozen control rules are satisfied, even if live rules were edited post-lock', () => {
    // Locking already forbids post-start edits; this test pins the approval path
    // to the frozen snapshot by directly simulating a diverged live definition.
    const fixture = buildChain({ aliquotCount: 1 });
    const batch = fixture.startBatch({ controls: [{ kind: 'BLANK', minimumCount: 1 }] });
    const run = registerRun(fixture, batch.id, 'RUN-1');
    fixture.app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
    const memberResult = ingest(fixture, batch.id, run.id, { contentHash: 'h-member' });
    const blank = ingest(fixture, batch.id, run.id, { contentHash: 'h-blank', aliquotId: undefined, controlKind: 'BLANK', analyte: 'blank' });
    fixture.app.batches.attachControlResult(batch.id, blank.id);
    fixture.app.quality.decide({
      tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, resultId: memberResult.id,
      decision: 'APPROVED', reason: 'ok', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01',
    });
    fixture.app.quality.decide({
      tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, resultId: blank.id,
      decision: 'APPROVED', reason: 'ok', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01',
    });
    // Diverge the live rule set (cannot happen through the locked service API, but
    // approval must still use the frozen snapshot captured at start).
    batch.requiredControls = [{ kind: 'POSITIVE_CONTROL', minimumCount: 3 }];
    fixture.app.quality.approveBatch(batch.id, 'reviewer_01');
    assert.equal(batch.status, 'APPROVED');
    assert.deepEqual(batch.frozenSnapshot!.requiredControls, [{ kind: 'BLANK', minimumCount: 1 }]);
  });

  it('rejects approval when frozen control requirements are missing', () => {
    const fixture = buildChain({ aliquotCount: 1 });
    const batch = fixture.startBatch({ controls: [{ kind: 'BLANK', minimumCount: 1 }] });
    const run = registerRun(fixture, batch.id, 'RUN-1');
    const memberResult = ingest(fixture, batch.id, run.id, { contentHash: 'h-member' });
    fixture.app.quality.decide({
      tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, resultId: memberResult.id,
      decision: 'APPROVED', reason: 'ok', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01',
    });
    assert.throws(
      () => fixture.app.quality.approveBatch(batch.id, 'reviewer_01'),
      (e: unknown) => e instanceof DomainError && e.code === 'quality.control_missing',
    );
    assert.notEqual(batch.status, 'APPROVED');
  });
});
