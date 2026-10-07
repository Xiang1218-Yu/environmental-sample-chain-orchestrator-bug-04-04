import type { AnalysisBatch, BatchStatus, InstrumentRun, ResultRevision } from '../domain/types.js';
import { assertCondition, assertFound, DomainError } from '../domain/errors.js';
import { Store } from '../store/store.js';

export interface RegisterRunInput {
  tenantId: string;
  projectId: string;
  batchId: string;
  externalRunId: string;
  rawFileHash: string;
  instrumentSoftwareVersion: string;
  startedAt: string;
}

export interface ResultInput {
  tenantId: string;
  projectId: string;
  batchId: string;
  runId: string;
  aliquotId?: string;
  controlKind?: 'BLANK' | 'CALIBRATION' | 'POSITIVE_CONTROL' | 'NEGATIVE_CONTROL';
  analyte: string;
  value: number;
  unit: string;
  detectionLimit: number;
  qualityFlags: string[];
  instrumentSoftwareVersion: string;
  contentHash: string;
}

export interface AmendRevisionInput extends ResultInput {
  previousResultId: string;
  reason: string;
}

const ACCEPTING_BATCH_STATUSES: ReadonlySet<BatchStatus> = new Set(['RUNNING', 'RESULTS_PENDING', 'UNDER_REVIEW']);

export class ResultService {
  constructor(private readonly store: Store) {}

  registerRun(input: RegisterRunInput): InstrumentRun {
    assertCondition(input.externalRunId.trim().length > 0, 'result.invalid_run', 'external run id is required');
    assertCondition(input.rawFileHash.trim().length > 0, 'result.invalid_run', 'raw file fingerprint is required');
    assertCondition(input.instrumentSoftwareVersion.trim().length > 0, 'result.invalid_run', 'instrument software version is required');
    // External run numbers are only unique within a single tenant + project;
    // another project (or tenant) reusing the same instrument number is independent.
    const existing = [...this.store.runs.values()].find((run) =>
      run.tenantId === input.tenantId && run.projectId === input.projectId && run.externalRunId === input.externalRunId);
    if (existing) {
      assertCondition(existing.batchId === input.batchId, 'result.run_batch_conflict', 'external run id is already registered to a different batch');
      assertCondition(existing.rawFileHash === input.rawFileHash, 'result.run_conflict', 'external run id was resubmitted with a different raw file fingerprint');
      return existing; // identical retransmission: idempotent, regardless of the batch's later status
    }
    const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
    assertCondition(batch.tenantId === input.tenantId && batch.projectId === input.projectId, 'scope.forbidden', 'batch is outside the requested project');
    assertCondition(batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING', this.batchStatusCode(batch.status), this.batchStatusMessage(batch.status));
    const run: InstrumentRun = {
      id: this.store.nextId('run'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      batchId: input.batchId,
      externalRunId: input.externalRunId,
      rawFileHash: input.rawFileHash,
      instrumentSoftwareVersion: input.instrumentSoftwareVersion,
      startedAt: input.startedAt,
      status: 'REGISTERED',
      version: 1,
    };
    this.store.runs.set(run.id, run);
    if (batch.status === 'RUNNING') {
      batch.status = 'RESULTS_PENDING';
      batch.version += 1;
    }
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'instrument.run_registered', entity: 'run', entityId: run.id, metadata: { batchId: batch.id, externalRunId: input.externalRunId } });
    return run;
  }

  completeRun(runId: string, completedAt: string, status: 'COMPLETED' | 'FAILED'): InstrumentRun {
    const run = assertFound(this.store.runs.get(runId), 'result.run_not_found', 'instrument run not found');
    assertCondition(run.status === 'REGISTERED' || run.status === 'RUNNING', 'result.run_closed', 'instrument run is already closed');
    run.status = status;
    run.completedAt = completedAt;
    run.version += 1;
    this.store.addAudit({ tenantId: run.tenantId, projectId: run.projectId, action: status === 'FAILED' ? 'instrument.run_failed' : 'instrument.run_completed', entity: 'run', entityId: run.id, metadata: { completedAt } });
    return run;
  }

  ingestRevision(input: ResultInput): ResultRevision {
    const { run, batch } = this.resolveContext(input);
    this.assertValidTarget(input, batch);
    const slot = this.slotRevisions(run.id, input);
    const identical = slot.find((result) => result.contentHash === input.contentHash);
    // Same-content retry / redrive is always idempotent, even after the run failed
    // or the batch was rejected; everything else obeys the lifecycle.
    if (!identical) {
      assertCondition(run.status !== 'FAILED', 'result.run_failed', 'failed instrument runs cannot publish new results');
      // A different file for a slot that already holds content is an explicit conflict:
      // instrument uploads must never silently overwrite or supersede a prior result.
      const current = slot.find((result) => result.status === 'CURRENT');
      if (current) throw new DomainError('result.content_conflict', `result content differs from the already received result ${current.id}; use an explicit amendment`);
      assertCondition(ACCEPTING_BATCH_STATUSES.has(batch.status), this.batchStatusCode(batch.status), this.batchStatusMessage(batch.status));
    }
    // A redrive of content received earlier (e.g. before a retest withdrew it) is
    // returned as-is, even when a newer run now owns the CURRENT slot.
    if (identical) return identical;
    this.assertNoOtherCurrent(input, batch, run.id);
    return this.createRevision(input, 1);
  }

  amendRevision(input: AmendRevisionInput): ResultRevision {
    const { run, batch } = this.resolveContext(input);
    this.assertValidTarget(input, batch);
    assertCondition(input.reason.trim().length > 0, 'result.amend_reason_required', 'a reason is required to amend a result');
    // Replaying an amendment that already produced a revision is idempotent,
    // even if that revision has since been superseded again.
    const replayed = this.slotRevisions(run.id, input).find((result) => result.contentHash === input.contentHash);
    if (replayed) return replayed;
    const previous = assertFound(this.store.results.get(input.previousResultId), 'result.previous_missing', 'previous result revision not found');
    assertCondition(
      previous.batchId === batch.id && previous.analyte === input.analyte
      && previous.aliquotId === input.aliquotId && previous.controlKind === input.controlKind,
      'result.amend_target_mismatch', 'the amendment target does not match the batch/result slot');
    assertCondition(previous.status === 'CURRENT', 'result.not_current', 'only the current result revision can be amended');
    assertCondition(run.status !== 'FAILED', 'result.run_failed', 'failed instrument runs cannot publish amendments');
    assertCondition(ACCEPTING_BATCH_STATUSES.has(batch.status), this.batchStatusCode(batch.status), this.batchStatusMessage(batch.status));
    const revisionNumber = Math.max(...[...this.store.results.values()]
      .filter((result) => result.runId === run.id && result.analyte === input.analyte && result.aliquotId === input.aliquotId && result.controlKind === input.controlKind)
      .map((result) => result.revisionNumber)) + 1;
    return this.createRevision(input, revisionNumber, previous.id, input.reason);
  }

  private resolveContext(input: ResultInput): { run: InstrumentRun; batch: AnalysisBatch } {
    const run = assertFound(this.store.runs.get(input.runId), 'result.run_not_found', 'instrument run not found');
    const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
    assertCondition(run.tenantId === input.tenantId && run.projectId === input.projectId, 'scope.forbidden', 'instrument run is outside the requested project');
    assertCondition(batch.tenantId === input.tenantId && batch.projectId === input.projectId, 'scope.forbidden', 'batch is outside the requested project');
    assertCondition(run.batchId === batch.id, 'scope.forbidden', 'result does not belong to the requested batch');
    return { run, batch };
  }

  /** A result targets exactly one frozen batch member aliquot or one frozen control rule. */
  private assertValidTarget(input: ResultInput, batch: AnalysisBatch): void {
    assertCondition(input.analyte.trim().length > 0 && input.unit.trim().length > 0, 'result.invalid_result', 'analyte and unit are required');
    assertCondition(Number.isFinite(input.value) && Number.isFinite(input.detectionLimit) && input.detectionLimit >= 0, 'result.invalid_result', 'result value and detection limit must be finite numbers');
    assertCondition(input.contentHash.trim().length > 0, 'result.invalid_result', 'result content fingerprint is required');
    const hasAliquot = input.aliquotId !== undefined;
    const hasControl = input.controlKind !== undefined;
    assertCondition(hasAliquot !== hasControl, 'result.invalid_target', 'a result must target either a batch member aliquot or a control kind, not both');
    const snapshot = batch.frozenSnapshot ?? {
      protocolVersion: batch.protocolVersion,
      memberAliquotIds: batch.memberAliquotIds,
      requiredControls: batch.requiredControls,
    };
    if (hasAliquot) {
      assertCondition(snapshot.memberAliquotIds.includes(input.aliquotId as string), 'result.not_batch_member', 'result aliquot is not a member of the frozen batch snapshot');
    } else {
      assertCondition(snapshot.requiredControls.some((control) => control.kind === input.controlKind), 'result.control_not_required', 'control kind is not part of the frozen batch control rules');
    }
  }

  /**
   * Revisions are keyed per instrument run + analyte + member/control slot.
   * Scoping by run prevents a later run's upload from superseding an earlier
   * run's current result for the same analyte.
   */
  private slotRevisions(runId: string, input: ResultInput): ResultRevision[] {
    return [...this.store.results.values()].filter((result) =>
      result.runId === runId
      && result.aliquotId === input.aliquotId
      && result.controlKind === input.controlKind
      && result.analyte === input.analyte);
  }

  /** One CURRENT result per analyte slot per batch execution cycle (a different run is a retest, not a duplicate current). */
  private assertNoOtherCurrent(input: ResultInput, batch: AnalysisBatch, runId: string): void {
    const other = [...this.store.results.values()].find((result) =>
      result.batchId === batch.id
      && result.runId !== runId
      && result.analyte === input.analyte
      && result.aliquotId === input.aliquotId
      && result.controlKind === input.controlKind
      && result.status === 'CURRENT');
    if (other) throw new DomainError('result.duplicate_current', `another run (${other.runId}) already holds the current result for this analyte slot`);
  }

  private createRevision(input: ResultInput, revisionNumber: number, supersedesRevisionId?: string, amendReason?: string): ResultRevision {
    const result: ResultRevision = {
      id: this.store.nextId('result'),
      tenantId: input.tenantId,
      projectId: input.projectId,
      batchId: input.batchId,
      runId: input.runId,
      ...(input.aliquotId === undefined ? {} : { aliquotId: input.aliquotId }),
      ...(input.controlKind === undefined ? {} : { controlKind: input.controlKind }),
      analyte: input.analyte,
      value: input.value,
      unit: input.unit,
      detectionLimit: input.detectionLimit,
      qualityFlags: [...input.qualityFlags],
      instrumentSoftwareVersion: input.instrumentSoftwareVersion,
      contentHash: input.contentHash,
      revisionNumber,
      ...(supersedesRevisionId === undefined ? {} : { supersedesRevisionId }),
      status: 'CURRENT',
      createdAt: this.store.now(),
      version: 1,
    };
    if (supersedesRevisionId) {
      const prior = assertFound(this.store.results.get(supersedesRevisionId), 'result.previous_missing', 'previous result revision not found');
      prior.status = 'SUPERSEDED';
      prior.version += 1;
    }
    this.store.results.set(result.id, result);
    this.store.addAudit({
      tenantId: input.tenantId,
      projectId: input.projectId,
      action: supersedesRevisionId ? 'result.amended' : 'result.revision_created',
      entity: 'result',
      entityId: result.id,
      metadata: { batchId: input.batchId, runId: input.runId, revisionNumber, analyte: input.analyte, ...(amendReason === undefined ? {} : { reason: amendReason }) },
    });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'result.revision-created', aggregateId: result.id, payload: JSON.stringify({ resultId: result.id, batchId: input.batchId, runId: input.runId, revisionNumber }) });
    return result;
  }

  private batchStatusCode(status: BatchStatus): string {
    if (status === 'REJECTED') return 'result.batch_rejected';
    if (status === 'APPROVED' || status === 'CANCELLED') return 'result.batch_closed';
    return 'result.batch_not_running';
  }

  private batchStatusMessage(status: BatchStatus): string {
    if (status === 'REJECTED') return 'rejected batch does not accept new results; reopen it for retest first';
    if (status === 'APPROVED' || status === 'CANCELLED') return 'batch is closed and does not accept new results';
    return 'batch is not accepting instrument results';
  }
}
