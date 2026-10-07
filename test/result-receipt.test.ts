import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError } from '../src/domain/errors.js';
import { SampleChainApplication } from '../src/app.js';
import { buildChain, registerRun, ingest, type ChainFixture } from './helpers.js';

function expectCode(promise: () => unknown, code: string): void {
  assert.throws(promise, (error: unknown) => error instanceof DomainError && error.code === code, `expected DomainError ${code}`);
}

describe('instrument run registration', () => {
  it('is idempotent for the same external run number and identical file fingerprint', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const first = registerRun(fixture, batch.id, 'RUN-1', 'raw-hash-1');
    const second = registerRun(fixture, batch.id, 'RUN-1', 'raw-hash-1');
    assert.equal(second.id, first.id);
    assert.equal(fixture.app.store.runs.size, 1);
  });

  it('raises an explicit fingerprint conflict when the same run number is resent with a different file', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    registerRun(fixture, batch.id, 'RUN-1', 'raw-hash-1');
    expectCode(() => registerRun(fixture, batch.id, 'RUN-1', 'raw-hash-DIFFERENT'), 'result.run_conflict');
    // The first fingerprint is preserved, nothing is overwritten.
    const run = [...fixture.app.store.runs.values()][0]!;
    assert.equal(run.rawFileHash, 'raw-hash-1');
  });

  it('scopes external run numbers per project: the same number in another tenant is independent', () => {
    const app = new SampleChainApplication();
    const fixtureA = buildChain({ app, tenantId: 'tenant-A', projectId: 'project-shared' });
    const fixtureB = buildChain({ app, tenantId: 'tenant-B', projectId: 'project-shared' });
    const batchA = fixtureA.startBatch();
    const batchB = fixtureB.startBatch();
    const runA = registerRun(fixtureA, batchA.id, 'SHARED-RUN', 'hash-a');
    const runB = registerRun(fixtureB, batchB.id, 'SHARED-RUN', 'hash-b');
    assert.notEqual(runA.id, runB.id);
    assert.equal(runA.projectId, runB.projectId); // same project name
    assert.notEqual(runA.tenantId, runB.tenantId);
    // A fingerprint clash in one tenant must not leak into the other tenant.
    assert.equal(app.store.runs.size, 2);
    assert.equal(registerRun(fixtureA, batchA.id, 'SHARED-RUN', 'hash-a').id, runA.id);
    assert.equal(registerRun(fixtureB, batchB.id, 'SHARED-RUN', 'hash-b').id, runB.id);
    expectCode(() => registerRun(fixtureA, batchA.id, 'SHARED-RUN', 'hash-b'), 'result.run_conflict');
  });

  it('isolates external run numbers across projects within the same tenant', () => {
    const app = new SampleChainApplication();
    const fixture = buildChain({ app, tenantId: 'tenant-shared', projectId: 'project-A' });
    const other = buildChain({ app, tenantId: 'tenant-shared', projectId: 'project-B' });
    const batchA = fixture.startBatch();
    const batchB = other.startBatch();
    const runA = registerRun(fixture, batchA.id, 'RUN-X', 'hash-a');
    const runB = registerRun(other, batchB.id, 'RUN-X', 'hash-b');
    assert.notEqual(runA.id, runB.id);
    // Within one project the number still conflicts on differing fingerprint.
    expectCode(() => registerRun(fixture, batchA.id, 'RUN-X', 'hash-b'), 'result.run_conflict');
    assert.equal(registerRun(other, batchB.id, 'RUN-X', 'hash-b').id, runB.id);
  });

  it('rejects a reused run number pointed at a different batch in the same project', () => {
    const fixture = buildChain({ aliquotCount: 4 });
    const batch1 = fixture.startBatch({ memberAliquotIds: [fixture.aliquots[0]!.id, fixture.aliquots[1]!.id] });
    const batch2 = fixture.startBatch({ memberAliquotIds: [fixture.aliquots[2]!.id, fixture.aliquots[3]!.id] });
    registerRun(fixture, batch1.id, 'RUN-1', 'raw-hash-1');
    expectCode(() => registerRun(fixture, batch2.id, 'RUN-1', 'raw-hash-1'), 'result.run_batch_conflict');
  });

  it('refuses new runs once the batch is rejected, but still replays a previously registered run', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1', 'raw-hash-1');
    fixture.app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
    const result = ingest(fixture, batch.id, run.id, { contentHash: 'h1' });
    fixture.app.quality.decide({
      tenantId: fixture.tenantId,
      projectId: fixture.projectId,
      batchId: batch.id,
      resultId: result.id,
      decision: 'REJECTED',
      reason: 'bad',
      ruleVersion: 'quality-v2',
      reviewerId: 'reviewer_01',
    });
    assert.equal(batch.status, 'REJECTED');
    expectCode(() => registerRun(fixture, batch.id, 'RUN-2', 'raw-hash-2'), 'result.batch_rejected');
    // Redrive of the already known run is still idempotent.
    assert.equal(registerRun(fixture, batch.id, 'RUN-1', 'raw-hash-1').id, run.id);
  });
});

describe('result receipt and idempotency', () => {
  it('returns the same revision for same-content retries and never creates duplicates', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1');
    const first = ingest(fixture, batch.id, run.id, { contentHash: 'h1', value: 0.12 });
    const second = ingest(fixture, batch.id, run.id, { contentHash: 'h1', value: 0.12 });
    const third = ingest(fixture, batch.id, run.id, { contentHash: 'h1', value: 0.12 });
    assert.equal(second.id, first.id);
    assert.equal(third.id, first.id);
    const currents = [...fixture.app.store.results.values()].filter((r) => r.status === 'CURRENT');
    assert.equal(currents.length, 1);
    assert.equal(currents[0]!.revisionNumber, 1);
  });

  it('treats different content for the same run/analyte/slot as an explicit conflict', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1');
    const first = ingest(fixture, batch.id, run.id, { contentHash: 'h1', value: 0.12 });
    expectCode(() => ingest(fixture, batch.id, run.id, { contentHash: 'h2', value: 0.99 }), 'result.content_conflict');
    // The first result stays CURRENT and its value/history are untouched.
    const stored = fixture.app.store.results.get(first.id)!;
    assert.equal(stored.status, 'CURRENT');
    assert.equal(stored.contentHash, 'h1');
    assert.equal(stored.value, 0.12);
    assert.equal(fixture.app.store.results.size, 1);
  });

  it('survives out-of-order delivery: conflicts never overwrite the first accepted content', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1');
    // The "corrected" file arrives first.
    const arrivedFirst = ingest(fixture, batch.id, run.id, { contentHash: 'h2', value: 0.2 });
    // Then the original file is redelivered with different content.
    expectCode(() => ingest(fixture, batch.id, run.id, { contentHash: 'h1', value: 0.12 }), 'result.content_conflict');
    // A redrive of the content that did arrive stays idempotent.
    assert.equal(ingest(fixture, batch.id, run.id, { contentHash: 'h2', value: 0.2 }).id, arrivedFirst.id);
    assert.equal(fixture.app.store.results.size, 1);
  });

  it('scopes revisions per run: a later run cannot supersede an earlier run current result', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run1 = registerRun(fixture, batch.id, 'RUN-1', 'raw-1');
    const run2 = registerRun(fixture, batch.id, 'RUN-2', 'raw-2');
    const result1 = ingest(fixture, batch.id, run1.id, { contentHash: 'h-run1' });
    // The second run must not silently become a new/duplicate CURRENT for the same slot.
    expectCode(() => ingest(fixture, batch.id, run2.id, { contentHash: 'h-run2' }), 'result.duplicate_current');
    // The earlier run's history is intact and remains the single CURRENT.
    assert.equal(fixture.app.store.results.get(result1.id)!.status, 'CURRENT');
    assert.equal(fixture.app.store.results.get(result1.id)!.value, 0.12);
    assert.equal(fixture.app.store.results.size, 1);
    // An explicit, audited amendment is the only way the retest run can replace it.
    const amended = fixture.app.results.amendRevision({
      tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, runId: run2.id,
      aliquotId: fixture.aliquots[0]!.id, analyte: 'lead', value: 0.15, unit: 'mg/L',
      detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'instrument-7.2',
      contentHash: 'h-run2', previousResultId: result1.id, reason: 'instrument rerun corrected the value',
    });
    assert.equal(amended.runId, run2.id);
    assert.equal(fixture.app.store.results.get(result1.id)!.status, 'SUPERSEDED');
  });

  it('rejects results that do not reference the frozen batch snapshot', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1');
    // Aliquot that is not a member of this batch.
    expectCode(() => ingest(fixture, batch.id, run.id, { contentHash: 'h1', aliquotId: 'aliquot_NOT_A_MEMBER' }), 'result.not_batch_member');
    // Control kind not present in the frozen control rules.
    expectCode(
      () => ingest(fixture, batch.id, run.id, { contentHash: 'h1', aliquotId: undefined, controlKind: 'POSITIVE_CONTROL' }),
      'result.control_not_required',
    );
    // Must target exactly one of aliquot / control.
    expectCode(
      () => fixture.app.results.ingestRevision({
        tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, runId: run.id,
        analyte: 'lead', value: 1, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [],
        instrumentSoftwareVersion: 'instrument-7.2', contentHash: 'h1',
      }),
      'result.invalid_target',
    );
  });

  it('accepts control results defined by the frozen control rules', () => {
    const fixture = buildChain({ aliquotCount: 1 });
    const batch = fixture.startBatch({ controls: [{ kind: 'BLANK', minimumCount: 1 }] });
    const run = registerRun(fixture, batch.id, 'RUN-1');
    const control = ingest(fixture, batch.id, run.id, { contentHash: 'h-blank', aliquotId: undefined, controlKind: 'BLANK', analyte: 'blank' });
    assert.equal(control.controlKind, 'BLANK');
    fixture.app.batches.attachControlResult(batch.id, control.id);
    assert.deepEqual(batch.controlResultIds, [control.id]);
    // Re-attaching is idempotent and does not bump the version.
    const versionBefore = batch.version;
    fixture.app.batches.attachControlResult(batch.id, control.id);
    assert.equal(batch.version, versionBefore);
  });

  it('prevents late callbacks from a failed run creating results, while replay stays idempotent', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1');
    // One result did get through before the run was marked failed.
    const existing = ingest(fixture, batch.id, run.id, { contentHash: 'h1' });
    fixture.app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'FAILED');
    // Late, different content cannot resurrect the failed execution.
    expectCode(() => ingest(fixture, batch.id, run.id, { contentHash: 'h2' }), 'result.run_failed');
    // ... but a redrive of the content already accepted is still idempotent.
    assert.equal(ingest(fixture, batch.id, run.id, { contentHash: 'h1' }).id, existing.id);
  });

  it('rejects cross-tenant/cross-project result references', () => {
    const app = new SampleChainApplication();
    const fixture = buildChain({ app, tenantId: 't1', projectId: 'p1' });
    const other = buildChain({ app, tenantId: 't2', projectId: 'p2' });
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1');
    const otherBatch = other.startBatch();
    // Foreign tenant/project cannot use the run id against its own batch.
    expectCode(() => other.app.results.ingestRevision({
      tenantId: other.tenantId, projectId: other.projectId, batchId: otherBatch.id, runId: run.id,
      aliquotId: other.aliquots[0]!.id, analyte: 'lead', value: 1, unit: 'mg/L',
      detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'v', contentHash: 'h',
    }), 'scope.forbidden');
    // ... nor address the original batch without the matching tenant/project.
    expectCode(() => other.app.results.ingestRevision({
      tenantId: other.tenantId, projectId: other.projectId, batchId: batch.id, runId: run.id,
      aliquotId: other.aliquots[0]!.id, analyte: 'lead', value: 1, unit: 'mg/L',
      detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'v', contentHash: 'h',
    }), 'scope.forbidden');
    // Run registration across tenants must not see each other's external run numbers.
    assert.doesNotThrow(() => registerRun(other, otherBatch.id, 'RUN-1'));
  });
});

describe('explicit result amendments', () => {
  it('creates an audited new revision and preserves the prior history', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1');
    const v1 = ingest(fixture, batch.id, run.id, { contentHash: 'h1', value: 0.12 });
    const v2 = fixture.app.results.amendRevision({
      tenantId: fixture.tenantId,
      projectId: fixture.projectId,
      batchId: batch.id,
      runId: run.id,
      aliquotId: fixture.aliquots[0]!.id,
      analyte: 'lead',
      value: 0.14,
      unit: 'mg/L',
      detectionLimit: 0.01,
      qualityFlags: ['RECHECKED'],
      instrumentSoftwareVersion: 'instrument-7.2',
      contentHash: 'h2',
      previousResultId: v1.id,
      reason: 'dilution correction',
    });
    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.revisionNumber, 2);
    assert.equal(v2.supersedesRevisionId, v1.id);
    assert.equal(fixture.app.store.results.get(v1.id)!.status, 'SUPERSEDED');
    assert.equal(fixture.app.store.results.get(v1.id)!.value, 0.12); // history preserved
    assert.equal(fixture.app.store.results.get(v2.id)!.status, 'CURRENT');
    const audit = fixture.app.store.audit.find((entry) => entry.action === 'result.amended');
    assert.ok(audit);
    assert.equal(audit!.metadata.reason, 'dilution correction');
    // Amending again with identical content is a no-op replay.
    assert.equal(fixture.app.results.amendRevision({
      tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, runId: run.id,
      aliquotId: fixture.aliquots[0]!.id, analyte: 'lead', value: 0.14, unit: 'mg/L',
      detectionLimit: 0.01, qualityFlags: ['RECHECKED'], instrumentSoftwareVersion: 'instrument-7.2',
      contentHash: 'h2', previousResultId: v1.id, reason: 'dilution correction',
    }).id, v2.id);
  });

  it('refuses amendments that target a different result slot', () => {
    const fixture = buildChain();
    const batch = fixture.startBatch();
    const run1 = registerRun(fixture, batch.id, 'RUN-1');
    const v1 = ingest(fixture, batch.id, run1.id, { contentHash: 'h1' });
    // Amendment must reference the same analyte/member slot as the previous revision.
    expectCode(() => fixture.app.results.amendRevision({
      tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, runId: run1.id,
      aliquotId: fixture.aliquots[0]!.id, analyte: 'cadmium', value: 0.14, unit: 'mg/L',
      detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'v', contentHash: 'h2',
      previousResultId: v1.id, reason: 'x',
    }), 'result.amend_target_mismatch');
    // A reason is mandatory so amendments can never be silent.
    expectCode(() => fixture.app.results.amendRevision({
      tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, runId: run1.id,
      aliquotId: fixture.aliquots[0]!.id, analyte: 'lead', value: 0.14, unit: 'mg/L',
      detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'v', contentHash: 'h2',
      previousResultId: v1.id, reason: '  ',
    }), 'result.amend_reason_required');
  });
});

describe('rejected-batch reprocessing', () => {
  function rejectBatch(fixture: ChainFixture) {
    const batch = fixture.startBatch();
    const run = registerRun(fixture, batch.id, 'RUN-1');
    fixture.app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
    const result = ingest(fixture, batch.id, run.id, { contentHash: 'h1' });
    fixture.app.quality.decide({
      tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: batch.id, resultId: result.id,
      decision: 'REJECTED', reason: 'out of range', ruleVersion: 'quality-v2', reviewerId: 'reviewer_01',
    });
    return { batch, run, result, fixture };
  }

  it('blocks new results on a rejected batch but keeps redrives idempotent', () => {
    const fixture = buildChain();
    const { batch, run, result } = rejectBatch(fixture);
    expectCode(() => ingest(fixture, batch.id, run.id, { contentHash: 'h2' }), 'result.content_conflict');
    assert.equal(ingest(fixture, batch.id, run.id, { contentHash: 'h1' }).id, result.id);
  });

  it('only rejected batches may be reopened for retest and requires a reason', () => {
    const runningFixture = buildChain();
    const running = runningFixture.startBatch();
    expectCode(() => runningFixture.app.batches.reopenForRetest(running.id, 'reviewer_01', 'retry'), 'batch.not_rejected');

    const rejected = rejectBatch(buildChain());
    expectCode(() => rejected.fixture.app.batches.reopenForRetest(rejected.batch.id, 'reviewer_01', '   '), 'batch.retest_reason_required');
    // The failed call leaves the batch rejected and its results untouched.
    assert.equal(rejected.batch.status, 'REJECTED');
    assert.equal(rejected.fixture.app.store.results.get(rejected.result.id)!.status, 'CURRENT');
  });

  it('reprocessing after reopen withdraws prior results, preserves history and accepts a fresh run', () => {
    const fixture = buildChain();
    const { batch, run, result } = rejectBatch(fixture);
    const reopened = fixture.app.batches.reopenForRetest(batch.id, 'reviewer_01', 'dilution issue confirmed');
    assert.equal(reopened.status, 'RUNNING');
    // Prior execution result is withdrawn (history retained), not deleted or overwritten.
    const withdrawn = fixture.app.store.results.get(result.id)!;
    assert.equal(withdrawn.status, 'WITHDRAWN');
    assert.equal(withdrawn.contentHash, 'h1');
    // Frozen snapshot is still intact for the old result references.
    assert.ok(reopened.frozenSnapshot);

    // A fresh instrument run for the retest registers and delivers results.
    const run2 = registerRun(fixture, batch.id, 'RUN-2', 'raw-hash-2');
    const retest = ingest(fixture, batch.id, run2.id, { contentHash: 'h1-retest', value: 0.1 });
    assert.equal(retest.status, 'CURRENT');
    // Old run's redrive remains idempotent and cannot publish new content.
    assert.equal(ingest(fixture, batch.id, run.id, { contentHash: 'h1' }).id, result.id);
    expectCode(() => ingest(fixture, batch.id, run.id, { contentHash: 'h-new' }), 'result.duplicate_current');
    // Exactly one CURRENT result for this slot.
    const currents = [...fixture.app.store.results.values()].filter((r) => r.analyte === 'lead' && r.status === 'CURRENT');
    assert.equal(currents.length, 1);
    assert.equal(currents[0]!.id, retest.id);
  });
});
