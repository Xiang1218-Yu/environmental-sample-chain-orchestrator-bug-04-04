import { describe, it } from 'node:test';
import { assert, expectError, registerRun, sampleResultInput, setupStartedBatch, type Fixture } from './helpers.js';

describe('external run number scoping across projects and tenants', () => {
  it('allows the same external run number in different projects and keeps their data isolated', () => {
    const a = setupStartedBatch();
    const b = setupStartedBatch({ app: a.app });
    assert.notEqual(a.tenantId, b.tenantId);
    const runA = registerRun(a, 'SAME-RUN-NUMBER', 'raw-A');
    const runB = registerRun(b, 'SAME-RUN-NUMBER', 'raw-B');
    assert.notEqual(runA.id, runB.id);
    assert.notEqual(runA.batchId, runB.batchId);
    assert.equal(a.app.store.runs.size, 2);

    // Same fingerprint re-uploaded by each instrument stays idempotent within scope.
    assert.equal(registerRun(a, 'SAME-RUN-NUMBER', 'raw-A').id, runA.id);
    assert.equal(registerRun(b, 'SAME-RUN-NUMBER', 'raw-B').id, runB.id);
  });

  it('never returns another project/tenant run and rejects fingerprint mismatch only within scope', () => {
    const a = setupStartedBatch();
    const b = setupStartedBatch({ app: a.app });
    registerRun(b, 'SHARED-ID', 'raw-from-b');
    // Project A registering the same id with its own file is a brand new run, not a conflict leak.
    const runA = registerRun(a, 'SHARED-ID', 'raw-from-a');
    assert.equal(runA.rawFileHash, 'raw-from-a');
    expectError('result.run_conflict', () => registerRun(a, 'SHARED-ID', 'raw-from-a-2'));
    // B is unaffected.
    assert.equal(registerRun(b, 'SHARED-ID', 'raw-from-b').rawFileHash, 'raw-from-b');
  });

  it('keeps result identities isolated by run: another run cannot overwrite or duplicate current results', () => {
    const fixture = setupStartedBatch();
    const run1 = registerRun(fixture, 'RUN-A', 'raw-A');
    const run2 = registerRun(fixture, 'RUN-B', 'raw-B');
    const first = fixture.app.results.ingestRevision(sampleResultInput(fixture, run1.id, 'content-A'));

    // A different run pushing the same logical target with different content cannot silently supersede run1.
    expectError('result.content_conflict', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run2.id, 'content-B', { value: 0.7 })));

    // ...but identical content replayed via run2 is recognized as the same value, no duplicate CURRENT row.
    const replay = fixture.app.results.ingestRevision(sampleResultInput(fixture, run2.id, 'content-A'));
    assert.equal(replay.id, first.id);
    const currents = [...fixture.app.store.results.values()].filter((r) => r.status === 'CURRENT' && r.analyte === 'lead');
    assert.equal(currents.length, 1);

    // Cross-project/tenant requests are refused (same store, real distinct ids).
    const other: Fixture = setupStartedBatch({ app: fixture.app });
    expectError('scope.forbidden', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run1.id, 'content-A', { projectId: other.projectId })));
    expectError('result.run_not_found', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, 'nonexistent-run', 'content-A')));
  });
});
