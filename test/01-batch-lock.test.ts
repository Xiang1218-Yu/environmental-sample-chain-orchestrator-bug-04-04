import { describe, it } from 'node:test';
import { assert, expectError, setupStartedBatch } from './helpers.js';

describe('batch locking after run start', () => {
  it('rejects adding or removing members while RUNNING and later', () => {
    const fixture = setupStartedBatch({ aliquotCount: 3, memberCount: 2 });
    const { app } = fixture;
    // Lock already applies in RUNNING (the original bug allowed it).
    expectError('batch.members_locked', () => app.batches.addAliquot(fixture.batchId, fixture.aliquotIds[2]!));
    expectError('batch.members_locked', () => app.batches.removeAliquot(fixture.batchId, fixture.aliquotIds[0]!));

    // Still locked after the first run registers (RESULTS_PENDING).
    app.results.registerRun({ tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: fixture.batchId, externalRunId: 'RUN-LK', rawFileHash: 'raw-lk', instrumentSoftwareVersion: 'i', startedAt: '2026-10-06T11:10:00.000Z' });
    expectError('batch.members_locked', () => app.batches.addAliquot(fixture.batchId, fixture.aliquotIds[2]!));
    expectError('batch.members_locked', () => app.batches.removeAliquot(fixture.batchId, fixture.aliquotIds[0]!));
  });

  it('rejects protocol and control-rule changes once started and keeps the frozen snapshot unchanged', () => {
    const fixture = setupStartedBatch({ controls: [{ kind: 'BLANK', minimumCount: 1 }] });
    const { app } = fixture;
    const snapshot = fixture.batch.frozenSnapshot!;
    assert.equal(snapshot.protocolVersion, 'water-v3');
    assert.deepEqual(snapshot.memberAliquotIds, fixture.aliquotIds);
    assert.deepEqual(snapshot.requiredControls, [{ kind: 'BLANK', minimumCount: 1 }]);

    expectError('batch.locked', () => app.batches.updateProtocol(fixture.batchId, 'water-v9', 'admin_01'));
    expectError('batch.locked', () => app.batches.updateRequiredControls(fixture.batchId, [{ kind: 'CALIBRATION', minimumCount: 2 }], 'admin_01'));

    assert.equal(fixture.batch.protocolVersion, 'water-v3');
    assert.deepEqual(fixture.batch.frozenSnapshot!.requiredControls, [{ kind: 'BLANK', minimumCount: 1 }]);
  });

  it('still allows protocol/control/member edits before start', () => {
    const fixture = setupStartedBatch({ aliquotCount: 4, memberCount: 2 });
    // The two extra aliquots stay available: main batch only got the first two... build a draft using them.
    const draft = fixture.app.batches.create({ tenantId: fixture.tenantId, projectId: fixture.projectId, protocolVersion: 'water-v1', instrumentType: 'ICP-MS', requiredControls: [], createdBy: 'analyst_01' });
    fixture.app.batches.updateProtocol(draft.id, 'water-v2', 'analyst_01');
    fixture.app.batches.updateRequiredControls(draft.id, [{ kind: 'BLANK', minimumCount: 1 }], 'analyst_01');
    fixture.app.batches.addAliquot(draft.id, fixture.aliquotIds[2]!);
    assert.deepEqual(draft.memberAliquotIds, [fixture.aliquotIds[2]]);
    fixture.app.batches.removeAliquot(draft.id, fixture.aliquotIds[2]!);
    assert.equal(draft.protocolVersion, 'water-v2');
    assert.deepEqual(draft.memberAliquotIds, []);
    // Validation rules still apply before lock.
    expectError('batch.invalid_controls', () => fixture.app.batches.updateRequiredControls(draft.id, [{ kind: 'BLANK', minimumCount: 0 }], 'admin_01'));
    // Cannot ready without members.
    expectError('batch.no_members', () => fixture.app.batches.markReady(draft.id));
    // An aliquot already allocated to another batch cannot be added.
    const other = setupStartedBatch();
    expectError('aliquot.not_available', () => fixture.app.batches.addAliquot(draft.id, other.aliquotIds[0]!));
  });
});
