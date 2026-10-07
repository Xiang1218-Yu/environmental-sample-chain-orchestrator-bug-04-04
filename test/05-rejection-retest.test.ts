import { describe, it } from 'node:test';
import { assert, controlResultInput, expectError, registerRun, sampleResultInput, setupStartedBatch } from './helpers.js';

describe('batch rejection and retest reprocessing', () => {
  it('rejects new uploads after rejection, then re-opens with history preserved and re-approves the retest', () => {
    const fixture = setupStartedBatch({ controls: [{ kind: 'BLANK', minimumCount: 1 }] });
    const { app } = fixture;
    const batchId = fixture.batchId;

    // Rejected first execution: one sample result + one blank control.
    const run1 = registerRun(fixture, 'RUN-RT-1', 'raw-rt-1');
    const sample1 = app.results.ingestRevision(sampleResultInput(fixture, run1.id, 'sample-v1'));
    const blank1 = app.results.ingestRevision(controlResultInput(fixture, run1.id, 'blank-v1', 'BLANK'));
    app.results.completeRun(run1.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
    app.batches.attachControlResult(batchId, blank1.id);
    app.quality.decide({ tenantId: fixture.tenantId, projectId: fixture.projectId, batchId, resultId: sample1.id, decision: 'APPROVED', reason: 'ok', ruleVersion: 'quality-v2', reviewerId: 'rv' });
    app.quality.decide({ tenantId: fixture.tenantId, projectId: fixture.projectId, batchId, resultId: blank1.id, decision: 'APPROVED', reason: 'ok', ruleVersion: 'quality-v2', reviewerId: 'rv' });
    app.quality.decide({ tenantId: fixture.tenantId, projectId: fixture.projectId, batchId, resultId: sample1.id, decision: 'RETEST_REQUIRED', reason: 'qc out of range', ruleVersion: 'quality-v2', reviewerId: 'rv' });
    assert.equal(fixture.batch.status, 'REJECTED');

    // Closed for intake: new runs and late callbacks are refused.
    expectError('result.batch_not_running', () => registerRun(fixture, 'RUN-RT-2', 'raw-rt-2'));
    expectError('result.batch_closed', () => app.results.ingestRevision(sampleResultInput(fixture, run1.id, 'sample-v1')));

    // Cannot reopen a non-rejected batch.
    const fresh = setupStartedBatch();
    expectError('batch.not_rejected', () => fresh.app.batches.reopenForRetest(fresh.batch.id, 'rv', '2026-10-06T13:00:00.000Z'));

    const snapshotBefore = structuredClone(fixture.batch.frozenSnapshot);
    app.batches.reopenForRetest(batchId, 'reviewer_01', '2026-10-06T13:00:00.000Z');
    assert.equal(fixture.batch.status, 'RUNNING');

    // Frozen definition is identical for the retest.
    assert.deepEqual(fixture.batch.frozenSnapshot, snapshotBefore);

    // History is preserved but withdrawn; nothing was deleted or rewritten.
    assert.equal(app.store.results.get(sample1.id)!.status, 'WITHDRAWN');
    assert.equal(app.store.results.get(sample1.id)!.contentHash, 'sample-v1');
    assert.equal(app.store.results.get(sample1.id)!.revisionNumber, 1);
    assert.equal(app.store.results.get(blank1.id)!.status, 'WITHDRAWN');
    // Late retry from the invalidated old run is explicitly refused.
    expectError('result.result_withdrawn', () => app.results.ingestRevision(sampleResultInput(fixture, run1.id, 'sample-v1')));

    // Retest execution produces fresh CURRENT results.
    const run2 = registerRun(fixture, 'RUN-RT-2', 'raw-rt-2');
    const sample2 = app.results.ingestRevision(sampleResultInput(fixture, run2.id, 'sample-v2', { value: 0.1 }));
    const blank2 = app.results.ingestRevision(controlResultInput(fixture, run2.id, 'blank-v2', 'BLANK'));
    assert.equal(sample2.status, 'CURRENT');
    assert.equal(blank2.status, 'CURRENT');
    const currents = [...app.store.results.values()].filter((r) => r.batchId === batchId && r.status === 'CURRENT');
    assert.equal(currents.length, 2);
    // Retest creates fresh revisions, never revives old rows.
    assert.notEqual(sample2.id, sample1.id);

    // Retest is reviewed and approved.
    app.quality.decide({ tenantId: fixture.tenantId, projectId: fixture.projectId, batchId, resultId: sample2.id, decision: 'APPROVED', reason: 'within limits', ruleVersion: 'quality-v2', reviewerId: 'rv' });
    app.quality.decide({ tenantId: fixture.tenantId, projectId: fixture.projectId, batchId, resultId: blank2.id, decision: 'APPROVED', reason: 'clean', ruleVersion: 'quality-v2', reviewerId: 'rv' });
    app.batches.attachControlResult(batchId, blank2.id);
    app.quality.approveBatch(batchId, 'reviewer_01');
    assert.equal(fixture.batch.status, 'APPROVED');

    // Approved batch is sealed against further instrument intake.
    expectError('result.batch_approved', () => app.results.ingestRevision(sampleResultInput(fixture, run2.id, 'sample-v3')));
    expectError('batch.not_rejected', () => app.batches.reopenForRetest(batchId, 'rv', '2026-10-06T14:00:00.000Z'));

    // Full audit trail of both executions survives.
    assert.ok(app.store.audit.some((a) => a.action === 'batch.reopened_for_retest'));
    assert.equal(app.store.results.get(sample1.id)!.status, 'WITHDRAWN');
    assert.equal(app.store.results.get(blank1.id)!.status, 'WITHDRAWN');
  });
});
