import { describe, it } from 'node:test';
import { assert, expectError, registerRun, sampleResultInput, setupStartedBatch } from './helpers.js';

describe('receiving transaction atomicity and current-result invariant', () => {
  it('rolls back every partial mutation when intake validation fails', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-TX', 'raw-tx');
    const resultsBefore = fixture.app.store.results.size;
    const auditBefore = fixture.app.store.audit.length;
    const outboxBefore = fixture.app.store.outbox.length;
    const batchVersionBefore = fixture.batch.version;

    // Unknown aliquot id -> scope failure, no result row written.
    expectError('scope.forbidden', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'h', { aliquotId: 'aliquot_does_not_exist' } as never)));
    assert.equal(fixture.app.store.results.size, resultsBefore);
    assert.equal(fixture.app.store.audit.length, auditBefore);
    assert.equal(fixture.app.store.outbox.length, outboxBefore);
    assert.equal(fixture.batch.version, batchVersionBefore);

    // Same-tenant aliquot that is not a frozen batch member reaches the membership check and also rolls back cleanly.
    const containerId = fixture.app.store.aliquots.get(fixture.aliquotIds[0]!)!.parentContainerId;
    const nonMember = fixture.app.aliquots.createMany({ tenantId: fixture.tenantId, projectId: fixture.projectId, parentContainerId: containerId, protocolVersion: 'water-v3', createdBy: 'a', operationId: 'extra', items: [{ barcode: 'ALQ-EXTRA', volumeMl: 5, unit: 'ML' }] })[0]!;
    const beforeMembershipFailure = { results: fixture.app.store.results.size, audit: fixture.app.store.audit.length, outbox: fixture.app.store.outbox.length, version: fixture.batch.version };
    expectError('result.unknown_member', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'h', { aliquotId: nonMember.id } as never)));
    assert.equal(fixture.app.store.results.size, beforeMembershipFailure.results);
    assert.equal(fixture.app.store.audit.length, beforeMembershipFailure.audit);
    assert.equal(fixture.app.store.outbox.length, beforeMembershipFailure.outbox);
    assert.equal(fixture.batch.version, beforeMembershipFailure.version);
  });

  it('rolls back the current->superseded flip when a conflicting amendment aborts', () => {
    const fixture = setupStartedBatch();
    const run = registerRun(fixture, 'RUN-TX2', 'raw-tx2');
    const first = fixture.app.results.ingestRevision(sampleResultInput(fixture, run.id, 'c1'));
    // Amendment onto a non-existent previous id must leave `first` CURRENT.
    expectError('result.not_found', () => fixture.app.results.amendRevision({
      ...sampleResultInput(fixture, run.id, 'c2'),
      supersedesResultId: 'result_missing', reviewerId: 'rv', reason: 'x',
    }));
    assert.equal(fixture.app.store.results.get(first.id)!.status, 'CURRENT');
  });

  it('guarantees at most one CURRENT revision per logical target through conflict, retry and retest', () => {
    const fixture = setupStartedBatch();
    const run1 = registerRun(fixture, 'RUN-I1', 'raw-i1');
    fixture.app.results.ingestRevision(sampleResultInput(fixture, run1.id, 'c1'));
    expectError('result.content_conflict', () => fixture.app.results.ingestRevision(sampleResultInput(fixture, run1.id, 'c2')));
    fixture.app.results.ingestRevision(sampleResultInput(fixture, run1.id, 'c1'));
    const countCurrent = () => [...fixture.app.store.results.values()].filter((r) => r.batchId === fixture.batchId && r.aliquotId === fixture.aliquotIds[0] && r.analyte === 'lead' && r.status === 'CURRENT').length;
    assert.equal(countCurrent(), 1);

    // Reject and reopen; old row withdrawn, retest row current — still a single CURRENT.
    fixture.app.quality.decide({ tenantId: fixture.tenantId, projectId: fixture.projectId, batchId: fixture.batchId, resultId: [...fixture.app.store.results.values()].find((r) => r.runId === run1.id)!.id, decision: 'REJECTED', reason: 'bad', ruleVersion: 'v', reviewerId: 'rv' });
    fixture.app.batches.reopenForRetest(fixture.batchId, 'rv', '2026-10-06T13:00:00.000Z');
    const run2 = registerRun(fixture, 'RUN-I2', 'raw-i2');
    fixture.app.results.ingestRevision(sampleResultInput(fixture, run2.id, 'c1'));
    assert.equal(countCurrent(), 1);
  });
});
