import { assertCondition, assertFound } from '../domain/errors.js';
const EDITABLE_STATUSES = ['DRAFT', 'READY'];
export class BatchService {
    store;
    aliquots;
    constructor(store, aliquots) {
        this.store = store;
        this.aliquots = aliquots;
    }
    create(input) {
        return this.store.transactionSync(() => {
            assertCondition(input.protocolVersion.trim().length > 0, 'batch.protocol_required', 'batch protocol is required');
            assertCondition(input.instrumentType.trim().length > 0, 'batch.instrument_required', 'batch instrument type is required');
            this.assertControlsValid(input.requiredControls);
            const batch = {
                id: this.store.nextId('batch'),
                tenantId: input.tenantId,
                projectId: input.projectId,
                protocolVersion: input.protocolVersion,
                instrumentType: input.instrumentType,
                status: 'DRAFT',
                memberAliquotIds: [],
                requiredControls: structuredClone(input.requiredControls),
                controlResultIds: [],
                createdBy: input.createdBy,
                createdAt: this.store.now(),
                version: 1,
            };
            this.store.batches.set(batch.id, batch);
            this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'batch.created', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: input.protocolVersion } });
            return batch;
        });
    }
    addAliquot(batchId, aliquotId) {
        return this.store.transactionSync(() => {
            const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
            const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
            assertCondition(batch.tenantId === aliquot.tenantId && batch.projectId === aliquot.projectId, 'scope.forbidden', 'batch and aliquot belong to different projects');
            this.assertMembershipEditable(batch);
            assertCondition(aliquotId.trim().length > 0, 'batch.invalid_member', 'aliquot id is required');
            assertCondition(batch.memberAliquotIds.length < 1000, 'batch.too_many_members', 'batch member limit exceeded');
            if (!batch.memberAliquotIds.includes(aliquotId)) {
                this.aliquots.allocate(aliquotId, batchId);
                batch.memberAliquotIds.push(aliquotId);
                batch.version += 1;
            }
            return batch;
        });
    }
    removeAliquot(batchId, aliquotId) {
        return this.store.transactionSync(() => {
            const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
            this.assertMembershipEditable(batch);
            if (batch.memberAliquotIds.includes(aliquotId)) {
                this.aliquots.release(aliquotId, batchId);
                batch.memberAliquotIds = batch.memberAliquotIds.filter((id) => id !== aliquotId);
                batch.version += 1;
            }
            return batch;
        });
    }
    updateProtocol(batchId, protocolVersion, actorId) {
        return this.store.transactionSync(() => {
            const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
            this.assertDefinitionEditable(batch);
            assertCondition(protocolVersion.trim().length > 0, 'batch.protocol_required', 'batch protocol is required');
            batch.protocolVersion = protocolVersion;
            batch.version += 1;
            this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.protocol_updated', entity: 'batch', entityId: batch.id, metadata: { protocolVersion, actorId } });
            return batch;
        });
    }
    updateRequiredControls(batchId, requiredControls, actorId) {
        return this.store.transactionSync(() => {
            const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
            this.assertDefinitionEditable(batch);
            this.assertControlsValid(requiredControls);
            batch.requiredControls = structuredClone(requiredControls);
            batch.version += 1;
            this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.controls_updated', entity: 'batch', entityId: batch.id, metadata: { controlKinds: requiredControls.map((control) => control.kind).join(','), actorId } });
            return batch;
        });
    }
    markReady(batchId) {
        return this.store.transactionSync(() => {
            const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
            assertCondition(batch.status === 'DRAFT', 'batch.not_ready', 'only draft batches can be prepared');
            assertCondition(batch.memberAliquotIds.length > 0, 'batch.no_members', 'batch needs at least one aliquot before it can be prepared');
            this.assertControlsValid(batch.requiredControls);
            batch.status = 'READY';
            batch.version += 1;
            this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.ready', entity: 'batch', entityId: batch.id, metadata: { memberCount: batch.memberAliquotIds.length } });
            return batch;
        });
    }
    start(batchId, startedAt) {
        return this.store.transactionSync(() => {
            const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
            assertCondition(batch.status === 'READY', 'batch.invalid_start', 'only ready batches can start');
            for (const aliquotId of batch.memberAliquotIds) {
                const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'batch member aliquot not found');
                assertCondition(aliquot.status === 'ALLOCATED', 'batch.member_not_allocated', 'all batch members must be allocated');
            }
            const snapshot = {
                protocolVersion: batch.protocolVersion,
                instrumentType: batch.instrumentType,
                memberAliquotIds: [...batch.memberAliquotIds],
                requiredControls: structuredClone(batch.requiredControls),
                frozenAt: startedAt,
            };
            batch.status = 'RUNNING';
            batch.startedAt = startedAt;
            batch.frozenAt = startedAt;
            batch.frozenSnapshot = snapshot;
            batch.version += 1;
            this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.started', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: batch.protocolVersion, memberCount: snapshot.memberAliquotIds.length } });
            this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.started', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, version: batch.version }) });
            return batch;
        });
    }
    /**
     * Re-open a rejected batch for a new (re-test) run. The frozen definition
     * (members, protocol, control rules) is deliberately left untouched, so the
     * re-run stays comparable to the rejected execution. Results of the rejected
     * execution are withdrawn (never deleted or silently rewritten), and their
     * full revision history remains for audit.
     */
    reopenForRetest(batchId, reviewerId, reopenedAt) {
        return this.store.transactionSync(() => {
            const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
            assertCondition(batch.status === 'REJECTED', 'batch.not_rejected', 'only rejected batches can be re-opened for retest');
            assertCondition(batch.frozenSnapshot !== undefined, 'batch.snapshot_missing', 'rejected batch has no frozen snapshot');
            const withdrawn = [];
            for (const result of this.store.results.values()) {
                if (result.tenantId === batch.tenantId && result.projectId === batch.projectId && result.batchId === batch.id && result.status === 'CURRENT') {
                    result.status = 'WITHDRAWN';
                    result.version += 1;
                    withdrawn.push(result.id);
                }
            }
            batch.status = 'RUNNING';
            batch.version += 1;
            this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.reopened_for_retest', entity: 'batch', entityId: batch.id, metadata: { reviewerId, withdrawnResultCount: withdrawn.length } });
            this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.reopened-for-retest', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, withdrawnResultIds: withdrawn }) });
            return batch;
        });
    }
    attachControlResult(batchId, resultId) {
        this.store.transactionSync(() => {
            const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
            const result = assertFound(this.store.results.get(resultId), 'result.not_found', 'control result not found');
            assertCondition(result.tenantId === batch.tenantId && result.projectId === batch.projectId, 'scope.forbidden', 'control result belongs to a different project');
            assertCondition(result.batchId === batch.id, 'result.different_batch', 'control result belongs to a different batch');
            assertCondition(result.controlKind !== undefined, 'batch.control_result_required', 'attached result must be a control result');
            assertCondition(batch.status !== 'CANCELLED', 'batch.locked', 'cancelled batches cannot accept control results');
            if (batch.controlResultIds.includes(resultId))
                return;
            batch.controlResultIds.push(resultId);
            batch.version += 1;
        });
    }
    assertDefinitionEditable(batch) {
        assertCondition(EDITABLE_STATUSES.includes(batch.status), 'batch.locked', 'batch protocol and control rules are locked once execution starts');
    }
    assertMembershipEditable(batch) {
        assertCondition(batch.status === 'DRAFT' || batch.status === 'READY', 'batch.members_locked', 'batch members are locked after execution starts');
    }
    assertControlsValid(requiredControls) {
        assertCondition(requiredControls.every((control) => control.minimumCount > 0), 'batch.invalid_controls', 'control minimums must be positive');
        const kinds = requiredControls.map((control) => control.kind);
        assertCondition(new Set(kinds).size === kinds.length, 'batch.duplicate_control_kind', 'control requirements must not repeat a control kind');
    }
}
