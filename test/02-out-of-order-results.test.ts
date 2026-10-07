import { describe, it } from 'node:test';
import { assert, controlResultInput, expectError, registerRun, sampleResultInput, setupStartedBatch } from './helpers.js';

describe('out-of-order instrument result delivery', () => {
  it('replays the same content hash idempotently and never creates duplicate CURRENT results', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-1', 'raw-1');
    const input = sampleResultInput(fixture, run.id, 'hash-A');
    const first = fixture.app.results.ingestRevision(input);
    // Duplicate upload (instrument retry) after the run was completed.
    fixture.app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
    const replay = fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-A', { value: 0.99 })); // body differs, fingerprint identical
    assert.equal(replay.id, first.id, 'same content hash must return the same stored revision');
    assert.equal(replay.value, 0.12, 'stored result must not be rewritten by the replay');

    const currents = [...fixture.app.store.results.values()].filter((r) => r.runId === run.id && r.status === 'CURRENT');
    assert.equal(currents.length, 1, 'exactly one CURRENT revision must exist for the run target');
    assert.equal(first.status, 'CURRENT');
    assert.equal(first.revisionNumber, 1);
  });

  it('treats results for a different aliquot/analyte as separate identities', () => {
    const fixture = setupStartedBatch({ aliquotCount: 3 });
    const run = registerRun(fixture, 'RUN-2', 'raw-2');
    fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-lead', { analyte: 'lead' }));
    fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-cadmium', { analyte: 'cadmium', value: 0.03, aliquotId: fixture.aliquotIds[2]! } as never));
    const currents = [...fixture.app.store.results.values()].filter((r) => r.runId === run.id && r.status === 'CURRENT');
    assert.equal(currents.length, 2);
  });

  it('accepts late COMPLETED-run callbacks and idempotent run re-registration without state changes', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-3', 'raw-3');
    fixture.app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
    // Instrument re-sends the run registration (same fingerprint) then the result.
    const again = registerRun(fixture, 'RUN-3', 'raw-3');
    assert.equal(again.id, run.id);
    const result = fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-L'));
    assert.equal(fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-L')).id, result.id);
  });

  it('does not let a late callback from a failed run publish results', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-4', 'raw-4');
    fixture.app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'FAILED');
    expectError('result.run_failed', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-F')));
  });

  it('validates result targets against the frozen batch snapshot', () => {
    const fixture = setupStartedBatch({ controls: [{ kind: 'BLANK', minimumCount: 1 }], aliquotCount: 3, memberCount: 2 });
    const run = registerRun(fixture, 'RUN-5', 'raw-5');
    // Same-tenant aliquot that exists but is not a frozen batch member.
    expectError('result.unknown_member', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-X', { aliquotId: fixture.aliquotIds[2]! } as never)));
    // Aliquot that belongs to another tenant/project (same store, distinct id space by tenant) is a scope violation.
    const stranger = setupStartedBatch({ app: fixture.app });
    expectError('scope.forbidden', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-X', { aliquotId: stranger.aliquotIds[0]! } as never)));
    // Control kind not declared in frozen rules.
    expectError('result.unknown_control', () => fixture.app.results.ingestRevision(controlResultInput(fixture, run.id, 'hash-X', 'CALIBRATION')));
    // Neither aliquot nor control kind.
    const neither = { tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: fixture.batch.id, runId: run.id, analyte: 'lead', value: 1, unit: 'mg/L', detectionLimit: 0.01, qualityFlags: [], instrumentSoftwareVersion: 'i', contentHash: 'hash-X' };
    expectError('result.invalid_target', () => fixture.app.results.ingestRevision(neither as never));
  });

  it('keeps first-arriving content when the instrument sends conflicting hashes out of order', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-6', 'raw-6');
    fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-first'));
    expectError('result.content_conflict', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'hash-second', { value: 0.5 })));
    // The losing upload must not leave any partial state behind.
    const all = [...fixture.app.store.results.values()].filter((r) => r.runId === run.id);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.contentHash, 'hash-first');
    assert.equal(all[0]!.value, 0.12);
  });
});
