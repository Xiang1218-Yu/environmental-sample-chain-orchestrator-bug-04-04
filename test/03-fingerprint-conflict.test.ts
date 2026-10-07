import { describe, it } from 'node:test';
import { assert, controlResultInput, expectError, registerRun, sampleResultInput, setupStartedBatch } from './helpers.js';

describe('raw-file / content fingerprint conflicts', () => {
  it('rejects a second registration of the same external run number with a different raw file hash', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-DUP', 'raw-A');
    expectError('result.run_conflict', () => registerRun(fixture, 'RUN-DUP', 'raw-B'));
    // Original run remains bound to the first fingerprint.
    assert.equal(fixture.app.store.runs.get(run.id)!.rawFileHash, 'raw-A');
    assert.equal(fixture.app.store.runs.size, 1);
  });

  it('conflicts instead of superseding when a different content hash arrives for an existing result', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-C', 'raw-C');
    const first = fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'content-A'));
    expectError('result.content_conflict', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'content-B', { value: 0.31 })));
    // History untouched: first result stays CURRENT with revision 1, no SUPERSEDED rows.
    const chain = [...fixture.app.store.results.values()].filter((r) => r.runId === run.id).sort((a, b) => a.revisionNumber - b.revisionNumber);
    assert.equal(chain.length, 1);
    assert.equal(chain[0]!.id, first.id);
    assert.equal(chain[0]!.status, 'CURRENT');
    assert.equal(chain[0]!.revisionNumber, 1);
    assert.equal(chain[0]!.contentHash, 'content-A');
  });

  it('allows an explicit, audited amendment which preserves the full history', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-AM', 'raw-AM');
    const first = fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'content-A'));
    const amended = fixture.app.results.amendRevision({
      ...sampleResultInput(fixture, run.id, 'content-B', { value: 0.31 }),
      supersedesResultId: first.id,
      reviewerId: 'reviewer_01',
      reason: 'instrument calibration correction',
    });
    assert.equal(amended.revisionNumber, 2);
    assert.equal(amended.status, 'CURRENT');
    assert.equal(amended.supersedesRevisionId, first.id);
    assert.equal(fixture.app.store.results.get(first.id)!.status, 'SUPERSEDED');
    const audit = fixture.app.store.audit.find((a) => a.action === 'result.amended');
    assert.ok(audit);
    assert.equal(audit!.metadata.reason, 'instrument calibration correction');

    // Amendments cannot re-submit identical content.
    expectError('result.same_content', () => fixture.app.results.amendRevision({
      ...sampleResultInput(fixture, run.id, 'content-B', { value: 0.31 }),
      supersedesResultId: amended.id, reviewerId: 'reviewer_01', reason: 'again',
    }));
    // Instrument retries of the old fingerprint remain a conflict against the new CURRENT value.
    expectError('result.content_conflict', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'content-A')));
  });

  it('cannot attach foreign or non-control results as batch controls', () => {
    const fixture = setupStartedBatch({ controls: [{ kind: 'BLANK', minimumCount: 1 }] });
    const run = registerRun(fixture, 'RUN-CT', 'raw-CT');
    const sampleResult = fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'c'));
    expectError('batch.control_result_required', () => fixture.app.batches.attachControlResult(fixture.batch.id, sampleResult.id));

    const control = fixture.app.results.ingestRevision(controlResultInput(fixture, run.id, 'c-blank', 'BLANK'));
    fixture.app.batches.attachControlResult(fixture.batch.id, control.id);
    // Idempotent attachment.
    fixture.app.batches.attachControlResult(fixture.batch.id, control.id);
    assert.deepEqual(fixture.batch.controlResultIds, [control.id]);

    const other = setupStartedBatch({ app: fixture.app, controls: [{ kind: 'BLANK', minimumCount: 1 }] });
    const otherRun = registerRun(other, 'RUN-CT2', 'raw-CT2');
    const foreignControl = other.app.results.ingestRevision(controlResultInput(other, otherRun.id, 'c-blank', 'BLANK'));
    expectError('scope.forbidden', () => fixture.app.batches.attachControlResult(fixture.batch.id, foreignControl.id));
  });
});
