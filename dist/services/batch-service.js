import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
const EDITABLE_STATUSES = new Set(['DRAFT', 'READY']);
export class BatchService {
    store;
    aliquots;
    constructor(store, aliquots) {
        this.store = store;
        this.aliquots = aliquots;
    }
    create(input) {
        assertCondition(input.protocolVersion.trim().length > 0, 'batch.protocol_required', 'batch protocol is required');
        this.validateControls(input.requiredControls);
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
    }
    addAliquot(batchId, aliquotId) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
        assertCondition(batch.tenantId === aliquot.tenantId && batch.projectId === aliquot.projectId, 'scope.forbidden', 'batch and aliquot belong to different projects');
        this.assertEditable(batch, 'batch.members_locked', 'batch members are locked after execution starts');
        assertCondition(aliquotId.trim().length > 0, 'batch.invalid_member', 'aliquot id is required');
        assertCondition(batch.memberAliquotIds.length < 1000, 'batch.too_many_members', 'batch member limit exceeded');
        if (!batch.memberAliquotIds.includes(aliquotId)) {
            this.aliquots.allocate(aliquotId, batchId);
            batch.memberAliquotIds.push(aliquotId);
            batch.version += 1;
            this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.member_added', entity: 'batch', entityId: batch.id, metadata: { aliquotId } });
        }
        return batch;
    }
    updateProtocol(batchId, protocolVersion) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        this.assertEditable(batch, 'batch.protocol_locked', 'batch protocol is locked after execution starts');
        assertCondition(protocolVersion.trim().length > 0, 'batch.protocol_required', 'batch protocol is required');
        if (batch.protocolVersion !== protocolVersion) {
            batch.protocolVersion = protocolVersion;
            batch.version += 1;
            this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.protocol_updated', entity: 'batch', entityId: batch.id, metadata: { protocolVersion } });
        }
        return batch;
    }
    updateRequiredControls(batchId, requiredControls) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        this.assertEditable(batch, 'batch.controls_locked', 'quality control rules are locked after execution starts');
        this.validateControls(requiredControls);
        batch.requiredControls = structuredClone(requiredControls);
        batch.version += 1;
        this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.controls_updated', entity: 'batch', entityId: batch.id, metadata: { controlCount: requiredControls.length } });
        return batch;
    }
    markReady(batchId) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        assertCondition(batch.status === 'DRAFT' && batch.memberAliquotIds.length > 0, 'batch.not_ready', 'batch needs at least one aliquot before it can be prepared');
        batch.status = 'READY';
        batch.version += 1;
        this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.ready', entity: 'batch', entityId: batch.id, metadata: { memberCount: batch.memberAliquotIds.length } });
        return batch;
    }
    start(batchId, startedAt) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        assertCondition(batch.status === 'READY', 'batch.invalid_start', 'only ready batches can start');
        // Validate before any mutation so a failed start leaves the batch untouched.
        for (const aliquotId of batch.memberAliquotIds) {
            const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'batch member aliquot not found');
            assertCondition(aliquot.status === 'ALLOCATED', 'batch.member_not_allocated', 'all batch members must be allocated');
        }
        batch.status = 'RUNNING';
        batch.startedAt = startedAt;
        batch.frozenAt = startedAt;
        // Immutable execution snapshot: results must always reference the members,
        // protocol and control rules that were in place when the run started.
        batch.frozenSnapshot = {
            protocolVersion: batch.protocolVersion,
            memberAliquotIds: [...batch.memberAliquotIds],
            requiredControls: structuredClone(batch.requiredControls),
        };
        batch.version += 1;
        this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.started', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: batch.protocolVersion } });
        this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.started', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, version: batch.version }) });
        return batch;
    }
    reopenForRetest(batchId, reviewerId, reason) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        assertCondition(reason.trim().length > 0, 'batch.retest_reason_required', 'a reason is required to reopen a rejected batch');
        assertCondition(batch.status === 'REJECTED', 'batch.not_rejected', 'only rejected batches can be reopened for retest');
        // Previous execution evidence stays intact: every result from the rejected
        // execution is withdrawn (never deleted or overwritten) and still references
        // the frozen snapshot, so the retest starts with no lingering CURRENT rows.
        const withdrawn = [];
        for (const result of this.store.results.values()) {
            if (result.batchId === batch.id && result.status !== 'WITHDRAWN') {
                result.status = 'WITHDRAWN';
                result.version += 1;
                withdrawn.push(result.id);
            }
        }
        batch.status = 'RUNNING';
        batch.version += 1;
        this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.reopened_for_retest', entity: 'batch', entityId: batch.id, metadata: { reviewerId, withdrawnCount: withdrawn.length, reason } });
        this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.reopened-for-retest', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, withdrawnResultIds: withdrawn }) });
        return batch;
    }
    attachControlResult(batchId, resultId) {
        const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
        const result = assertFound(this.store.results.get(resultId), 'result.not_found', 'result not found');
        assertCondition(result.batchId === batch.id && result.tenantId === batch.tenantId && result.projectId === batch.projectId, 'scope.forbidden', 'control result does not belong to this batch');
        assertCondition(result.controlKind !== undefined, 'batch.control_result_invalid', 'only control results can be attached to the control list');
        if (batch.controlResultIds.includes(resultId))
            return; // idempotent reattach
        assertCondition(batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'batch.controls_closed', 'control results can only be attached while the batch is executing');
        batch.controlResultIds.push(resultId);
        batch.version += 1;
        this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.control_attached', entity: 'batch', entityId: batch.id, metadata: { resultId, controlKind: result.controlKind } });
    }
    /** Batch definition (members, protocol, control rules) may only change before execution starts. */
    assertEditable(batch, code, message) {
        if (!EDITABLE_STATUSES.has(batch.status))
            throw new DomainError(code, message);
    }
    validateControls(requiredControls) {
        assertCondition(requiredControls.every((control) => control.minimumCount > 0), 'batch.invalid_controls', 'control minimums must be positive');
        const kinds = requiredControls.map((control) => control.kind);
        assertCondition(new Set(kinds).size === kinds.length, 'batch.duplicate_control_rule', 'control rules must not repeat the same kind');
    }
}
