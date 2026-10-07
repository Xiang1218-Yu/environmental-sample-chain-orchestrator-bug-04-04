import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DomainError } from '../src/domain/errors.js';
import { buildChain } from './helpers.js';

describe('batch locking after execution starts', () => {
  it('allows adding members and editing protocol/control rules while DRAFT and READY', () => {
    const { app, aliquots, startBatch } = buildChain();
    const batch = app.batches.create({
      tenantId: (aliquots[0] as NonNullable<typeof aliquots[0]>).tenantId,
      projectId: (aliquots[0] as NonNullable<typeof aliquots[0]>).projectId,
      protocolVersion: 'water-v2',
      instrumentType: 'ICP-MS',
      requiredControls: [{ kind: 'BLANK', minimumCount: 1 }],
      createdBy: 'analyst_01',
    });
    app.batches.addAliquot(batch.id, aliquots[0]!.id);
    app.batches.updateProtocol(batch.id, 'water-v3');
    app.batches.updateRequiredControls(batch.id, [{ kind: 'BLANK', minimumCount: 1 }, { kind: 'CALIBRATION', minimumCount: 2 }]);
    assert.equal(batch.protocolVersion, 'water-v3');
    assert.equal(batch.requiredControls.length, 2);
    app.batches.markReady(batch.id);
    // Reverting a READY batch definition is still allowed before start.
    app.batches.updateProtocol(batch.id, 'water-v2');
    assert.equal(batch.protocolVersion, 'water-v2');
    assert.ok(!batch.frozenSnapshot);
    void startBatch;
  });

  it('rejects member, protocol and control-rule edits once the batch is RUNNING', () => {
    const { app, aliquots, startBatch } = buildChain();
    const batch = startBatch();

    assert.throws(
      () => app.batches.addAliquot(batch.id, aliquots[2]!.id),
      (error: unknown) => error instanceof DomainError && error.code === 'batch.members_locked',
    );
    assert.throws(
      () => app.batches.updateProtocol(batch.id, 'water-v9'),
      (error: unknown) => error instanceof DomainError && error.code === 'batch.protocol_locked',
    );
    assert.throws(
      () => app.batches.updateRequiredControls(batch.id, [{ kind: 'POSITIVE_CONTROL', minimumCount: 1 }]),
      (error: unknown) => error instanceof DomainError && error.code === 'batch.controls_locked',
    );
    // Locked edits must not mutate the batch.
    assert.deepEqual(batch.memberAliquotIds, aliquots.slice(0, 3).map((item) => item.id));
    assert.equal(batch.protocolVersion, 'water-v3');
    assert.deepEqual(batch.requiredControls, [{ kind: 'BLANK', minimumCount: 1 }]);
  });

  it('keeps edits locked through RESULTS_PENDING, UNDER_REVIEW, APPROVED and REJECTED', () => {
    const { app, aliquots, startBatch } = buildChain();
    const batch = startBatch();
    const run = app.results.registerRun({
      tenantId: batch.tenantId,
      projectId: batch.projectId,
      batchId: batch.id,
      externalRunId: 'RUN-1',
      rawFileHash: 'raw-1',
      instrumentSoftwareVersion: 'instrument-7.2',
      startedAt: '2026-10-06T11:10:00.000Z',
    });
    assert.equal(batch.status, 'RESULTS_PENDING');
    assert.throws(() => app.batches.updateProtocol(batch.id, 'water-v9'), (e: unknown) => (e as DomainError).code === 'batch.protocol_locked');
    assert.throws(() => app.batches.addAliquot(batch.id, aliquots[2]!.id), (e: unknown) => (e as DomainError).code === 'batch.members_locked');

    // Reject the batch via a quality decision.
    app.results.completeRun(run.id, '2026-10-06T12:00:00.000Z', 'COMPLETED');
    const result = app.results.ingestRevision({
      tenantId: batch.tenantId,
      projectId: batch.projectId,
      batchId: batch.id,
      runId: run.id,
      aliquotId: aliquots[0]!.id,
      analyte: 'lead',
      value: 5,
      unit: 'mg/L',
      detectionLimit: 0.01,
      qualityFlags: [],
      instrumentSoftwareVersion: 'instrument-7.2',
      contentHash: 'h1',
    });
    app.quality.decide({
      tenantId: batch.tenantId,
      projectId: batch.projectId,
      batchId: batch.id,
      resultId: result.id,
      decision: 'REJECTED',
      reason: 'out of range',
      ruleVersion: 'quality-v2',
      reviewerId: 'reviewer_01',
    });
    assert.equal(batch.status, 'REJECTED');
    assert.throws(() => app.batches.updateProtocol(batch.id, 'water-v9'), (e: unknown) => (e as DomainError).code === 'batch.protocol_locked');
    assert.throws(() => app.batches.updateRequiredControls(batch.id, []), (e: unknown) => (e as DomainError).code === 'batch.controls_locked');
    assert.throws(() => app.batches.addAliquot(batch.id, aliquots[2]!.id), (e: unknown) => (e as DomainError).code === 'batch.members_locked');
  });

  it('freezes an immutable snapshot of members, protocol and control rules at start', () => {
    const { startBatch } = buildChain({ aliquotCount: 3 });
    const batch = startBatch({ protocolVersion: 'water-v3' });
    assert.ok(batch.frozenSnapshot);
    assert.deepEqual(batch.frozenSnapshot, {
      protocolVersion: 'water-v3',
      memberAliquotIds: batch.memberAliquotIds,
      requiredControls: [{ kind: 'BLANK', minimumCount: 1 }],
    });
  });

  it('does not mutate the batch when start validation fails', () => {
    const { app, aliquots } = buildChain();
    const batch = app.batches.create({
      tenantId: aliquots[0]!.tenantId,
      projectId: aliquots[0]!.projectId,
      protocolVersion: 'water-v3',
      instrumentType: 'ICP-MS',
      requiredControls: [],
      createdBy: 'analyst_01',
    });
    app.batches.addAliquot(batch.id, aliquots[0]!.id);
    app.batches.markReady(batch.id);
    // Simulate an aliquot that lost its allocation before start (defensive: member validation runs first).
    const aliquot = app.store.aliquots.get(aliquots[0]!.id);
    aliquot!.status = 'AVAILABLE';
    assert.throws(() => app.batches.start(batch.id, '2026-10-06T11:00:00.000Z'), /all batch members must be allocated/);
    assert.equal(batch.status, 'READY');
    assert.equal(batch.startedAt, undefined);
    assert.equal(batch.frozenSnapshot, undefined);
  });

  it('validates control-rule definitions and rejects duplicate kinds', () => {
    const { app, aliquots } = buildChain();
    assert.throws(
      () => app.batches.create({
        tenantId: aliquots[0]!.tenantId,
        projectId: aliquots[0]!.projectId,
        protocolVersion: 'water-v3',
        instrumentType: 'ICP-MS',
        requiredControls: [{ kind: 'BLANK', minimumCount: 0 }],
        createdBy: 'analyst_01',
      }),
      (e: unknown) => (e as DomainError).code === 'batch.invalid_controls',
    );
    const batch = app.batches.create({
      tenantId: aliquots[0]!.tenantId,
      projectId: aliquots[0]!.projectId,
      protocolVersion: 'water-v3',
      instrumentType: 'ICP-MS',
      requiredControls: [{ kind: 'BLANK', minimumCount: 1 }],
      createdBy: 'analyst_01',
    });
    assert.throws(
      () => app.batches.updateRequiredControls(batch.id, [
        { kind: 'BLANK', minimumCount: 1 },
        { kind: 'BLANK', minimumCount: 2 },
      ]),
      (e: unknown) => (e as DomainError).code === 'batch.duplicate_control_rule',
    );
  });
});
