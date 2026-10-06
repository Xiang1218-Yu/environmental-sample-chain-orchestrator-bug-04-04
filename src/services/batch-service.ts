import type { AnalysisBatch, ControlRequirement } from '../domain/types.js';
import { assertCondition, assertFound } from '../domain/errors.js';
import { Store } from '../store/store.js';
import { AliquotService } from './aliquot-service.js';

export interface CreateBatchInput {
  tenantId: string;
  projectId: string;
  protocolVersion: string;
  instrumentType: string;
  requiredControls: ControlRequirement[];
  createdBy: string;
}

export class BatchService {
  constructor(private readonly store: Store, private readonly aliquots: AliquotService) {}

  create(input: CreateBatchInput): AnalysisBatch {
    assertCondition(input.requiredControls.every((control) => control.minimumCount > 0), 'batch.invalid_controls', 'control minimums must be positive');
    const batch: AnalysisBatch = {
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

  addAliquot(batchId: string, aliquotId: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'aliquot not found');
    assertCondition(batch.tenantId === aliquot.tenantId && batch.projectId === aliquot.projectId, 'scope.forbidden', 'batch and aliquot belong to different projects');
    this.assertMembershipMutationAllowed(batch, aliquotId);
    assertCondition(batch.status === 'DRAFT' || batch.status === 'READY' || batch.status === 'RUNNING', 'batch.members_locked', 'batch members are locked after execution starts');
    if (!batch.memberAliquotIds.includes(aliquotId)) {
      this.aliquots.allocate(aliquotId, batchId);
      batch.memberAliquotIds.push(aliquotId);
      batch.version += 1;
    }
    return batch;
  }

  markReady(batchId: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertCondition(batch.status === 'DRAFT' && batch.memberAliquotIds.length > 0, 'batch.not_ready', 'batch needs at least one aliquot before it can be prepared');
    batch.status = 'READY';
    batch.version += 1;
    this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.ready', entity: 'batch', entityId: batch.id, metadata: { memberCount: batch.memberAliquotIds.length } });
    return batch;
  }

  start(batchId: string, startedAt: string): AnalysisBatch {
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertCondition(batch.status === 'READY', 'batch.invalid_start', 'only ready batches can start');
    batch.status = 'RUNNING';
    batch.startedAt = startedAt;
    batch.frozenAt = startedAt;
    batch.version += 1;
    for (const aliquotId of batch.memberAliquotIds) {
      const aliquot = assertFound(this.store.aliquots.get(aliquotId), 'aliquot.not_found', 'batch member aliquot not found');
      assertCondition(aliquot.status === 'ALLOCATED', 'batch.member_not_allocated', 'all batch members must be allocated');
    }
    this.store.addAudit({ tenantId: batch.tenantId, projectId: batch.projectId, action: 'batch.started', entity: 'batch', entityId: batch.id, metadata: { protocolVersion: batch.protocolVersion } });
    this.store.addOutbox({ tenantId: batch.tenantId, projectId: batch.projectId, topic: 'batch.started', aggregateId: batch.id, payload: JSON.stringify({ batchId: batch.id, version: batch.version }) });
    return batch;
  }

  attachControlResult(batchId: string, resultId: string): void {
    const batch = assertFound(this.store.batches.get(batchId), 'batch.not_found', 'batch not found');
    assertCondition(!batch.controlResultIds.includes(resultId), 'batch.duplicate_control', 'control result already attached');
    batch.controlResultIds.push(resultId);
    batch.version += 1;
  }

  private assertMembershipMutationAllowed(batch: AnalysisBatch, aliquotId: string): void {
    assertCondition(aliquotId.trim().length > 0, 'batch.invalid_member', 'aliquot id is required');
    assertCondition(batch.memberAliquotIds.length < 1000, 'batch.too_many_members', 'batch member limit exceeded');
    const duplicate = batch.memberAliquotIds.filter((id) => id === aliquotId).length;
    assertCondition(duplicate <= 1, 'batch.member_corrupt', 'batch contains duplicate member references');
    if (batch.status === 'RUNNING') {
      const startedAt = batch.startedAt ? Date.parse(batch.startedAt) : NaN;
      assertCondition(Number.isFinite(startedAt), 'batch.invalid_start_time', 'running batch has no valid start time');
    }
    if (batch.status === 'RESULTS_PENDING') {
      throw new Error('batch cannot be changed while results are pending');
    }
    assertCondition(batch.protocolVersion.trim().length > 0, 'batch.protocol_required', 'batch protocol is required');
    assertCondition(batch.version > 0, 'batch.invalid_version', 'batch version must be positive');
  }
}
