import type { ControlRequirement, InstrumentRun, ResultRevision } from '../domain/types.js';
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

const INTAKE_STATUSES: ReadonlySet<InstrumentRun['status']> = new Set(['REGISTERED', 'RUNNING', 'COMPLETED']);

type ResultTarget = { aliquotId: string; controlKind?: never } | { aliquotId?: never; controlKind: ControlRequirement['kind'] };

export class ResultService {
  constructor(private readonly store: Store) {}

  registerRun(input: RegisterRunInput): InstrumentRun {
    return this.store.transactionSync(() => {
      // External run numbers are unique within a tenant+project; the same number
      // used by another tenant or project is an unrelated instrument run.
      const existing = [...this.store.runs.values()].find((run) =>
        run.tenantId === input.tenantId && run.projectId === input.projectId && run.externalRunId === input.externalRunId);
      if (existing) {
        // Retried upload of the same raw file is idempotent; a different
        // fingerprint under the same run number is an explicit conflict and
        // must never silently rebind the run to the new file.
        assertCondition(existing.rawFileHash === input.rawFileHash, 'result.run_conflict', `external run id ${input.externalRunId} was already registered with a different raw file`);
        return existing;
      }
      const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
      assertCondition(batch.tenantId === input.tenantId && batch.projectId === input.projectId, 'scope.forbidden', 'batch is outside the requested project');
      assertCondition(batch.status === 'RUNNING' || batch.status === 'RESULTS_PENDING', 'result.batch_not_running', 'batch is not accepting instrument runs');
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
      batch.status = 'RESULTS_PENDING';
      batch.version += 1;
      this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'instrument.run_registered', entity: 'run', entityId: run.id, metadata: { batchId: batch.id, externalRunId: input.externalRunId, rawFileHash: input.rawFileHash } });
      return run;
    });
  }

  completeRun(runId: string, completedAt: string, status: 'COMPLETED' | 'FAILED'): InstrumentRun {
    return this.store.transactionSync(() => {
      const run = assertFound(this.store.runs.get(runId), 'result.run_not_found', 'instrument run not found');
      assertCondition(run.status !== 'COMPLETED' && run.status !== 'FAILED', 'result.run_closed', 'instrument run is already closed');
      run.status = status;
      run.completedAt = completedAt;
      run.version += 1;
      return run;
    });
  }

  /**
   * Accept one instrument result callback.
   *
   * - Same logical result (run + target + analyte) with the same content hash
   *   is idempotent and returns the already-stored revision unchanged, no
   *   matter how late or out of order it arrives.
   * - A different content hash for a result that already exists is a conflict
   *   (`result.content_conflict`): the first-arriving result is never
   *   overwritten. Legitimate corrections must go through `amendRevision`.
   */
  ingestRevision(input: ResultInput): ResultRevision {
    return this.store.transactionSync(() => {
      const run = assertFound(this.store.runs.get(input.runId), 'result.run_not_found', 'instrument run not found');
      const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
      assertCondition(run.tenantId === input.tenantId && run.projectId === input.projectId, 'scope.forbidden', 'run is outside the requested project');
      assertCondition(batch.tenantId === input.tenantId && batch.projectId === input.projectId, 'scope.forbidden', 'batch is outside the requested project');
      assertCondition(run.batchId === batch.id, 'result.different_batch', 'run does not belong to the stated batch');
      assertCondition(batch.status !== 'REJECTED' && batch.status !== 'CANCELLED', 'result.batch_closed', 'rejected or cancelled batches cannot receive results');
      assertCondition(batch.status !== 'APPROVED', 'result.batch_approved', 'approved batches cannot receive new results');
      assertCondition(run.status !== 'FAILED', 'result.run_failed', 'failed instrument runs cannot publish results');
      assertCondition(INTAKE_STATUSES.has(run.status), 'result.run_closed', 'closed instrument runs cannot publish results');

      const target = this.assertTarget(batch, input);

      // Anything already recorded for this exact run+target+analyte is an
      // instrument retry: idempotent for identical content, conflict otherwise.
      const sameRun = this.findChain(input.tenantId, input.projectId, input.batchId, input.runId, target, input.analyte);
      const latestSameRun = sameRun.sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
      if (latestSameRun) {
        // The run already delivered this result. It may only be replayed
        // verbatim while the revision is the current one (idempotent retry);
        // any other case is either a fingerprint conflict or a late callback
        // for a result that was withdrawn/superseded.
        if (latestSameRun.status !== 'CURRENT') {
          assertCondition(latestSameRun.contentHash !== input.contentHash, 'result.result_withdrawn', 'result revision is no longer current; use a new retest run instead');
          throw new DomainError('result.content_conflict', 'result content differs from a non-current revision of this run; amend explicitly or reject the upload');
        }
        assertCondition(latestSameRun.contentHash === input.contentHash, 'result.content_conflict', 'result content differs from what was already recorded for this run; amend explicitly or reject the upload');
        return latestSameRun;
      }

      // A different run delivering the same logical result (e.g. a re-run
      // after the old run was withdrawn): identical content is an idempotent
      // replay of the value, differing content is a conflict.
      const currentOther = this.findCurrent(input.tenantId, input.projectId, input.batchId, target, input.analyte);
      if (currentOther) {
        assertCondition(currentOther.contentHash === input.contentHash, 'result.content_conflict', 'a different run already recorded different content for this result; amend explicitly or reject the upload');
        return currentOther;
      }

      return this.createRevision(input, 1);
    });
  }

  /**
   * Deliberate, auditable correction of a result. Supersedes the current
   * revision and preserves the complete revision history. Requires an
   * explicit reviewer and reason; instrument retries cannot reach this path.
   */
  amendRevision(input: ResultInput & { supersedesResultId: string; reviewerId: string; reason: string }): ResultRevision {
    return this.store.transactionSync(() => {
      const current = assertFound(this.store.results.get(input.supersedesResultId), 'result.not_found', 'result to amend was not found');
      assertCondition(current.tenantId === input.tenantId && current.projectId === input.projectId, 'scope.forbidden', 'result is outside the requested project');
      assertCondition(current.batchId === input.batchId && current.runId === input.runId, 'result.different_batch', 'amendment target does not match the stated batch/run');
      assertCondition(current.status === 'CURRENT', 'result.not_current', 'only the current result revision can be amended');
      assertCondition(current.contentHash !== input.contentHash, 'result.same_content', 'amendment content is identical to the current revision');
      assertCondition(input.reason.trim().length > 0, 'result.amend_reason_required', 'an amendment reason is required');
      const batch = assertFound(this.store.batches.get(input.batchId), 'batch.not_found', 'batch not found');
      assertCondition(batch.status === 'RESULTS_PENDING' || batch.status === 'UNDER_REVIEW', 'result.batch_not_amendable', 'results can only be amended while the batch awaits quality review');
      const target = this.assertTarget(batch, input);
      const chain = this.findChain(input.tenantId, input.projectId, input.batchId, input.runId, target, input.analyte);
      const nextRevision = Math.max(...chain.map((result) => result.revisionNumber)) + 1;
      const amended = this.createRevision(input, nextRevision, current.id);
      this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'result.amended', entity: 'result', entityId: amended.id, metadata: { previousResultId: current.id, reviewerId: input.reviewerId, reason: input.reason } });
      return amended;
    });
  }

  private assertTarget(batch: { tenantId: string; projectId: string; frozenSnapshot?: { memberAliquotIds: string[]; requiredControls: ControlRequirement[] } }, input: ResultInput): ResultTarget {
    const hasAliquot = input.aliquotId !== undefined;
    const hasControl = input.controlKind !== undefined;
    assertCondition(hasAliquot !== hasControl, 'result.invalid_target', 'result must reference exactly one aliquot or one control kind');
    const frozen = batch.frozenSnapshot;
    assertCondition(frozen !== undefined, 'result.batch_not_frozen', 'results can only be attached to a started batch with a frozen snapshot');
    if (input.aliquotId !== undefined) {
      const aliquot = this.store.aliquots.get(input.aliquotId);
      assertCondition(aliquot !== undefined && aliquot.tenantId === batch.tenantId && aliquot.projectId === batch.projectId, 'scope.forbidden', 'result aliquot is outside the requested project');
      assertCondition(frozen.memberAliquotIds.includes(input.aliquotId), 'result.unknown_member', 'result aliquot is not a member of the frozen batch snapshot');
      return { aliquotId: input.aliquotId };
    }
    const controlKind = input.controlKind as ControlRequirement['kind'];
    assertCondition(frozen.requiredControls.some((requirement) => requirement.kind === controlKind), 'result.unknown_control', 'result control kind is not part of the frozen control rules');
    return { controlKind };
  }

  private createRevision(input: ResultInput, revisionNumber: number, supersedesRevisionId?: string): ResultRevision {
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
      assertCondition(prior.runId === result.runId && prior.batchId === result.batchId && prior.analyte === result.analyte && prior.aliquotId === result.aliquotId && prior.controlKind === result.controlKind, 'result.revision_chain_mismatch', 'revisions must form a chain for the same run target and analyte');
      prior.status = 'SUPERSEDED';
      prior.version += 1;
    }
    this.store.results.set(result.id, result);
    this.store.addAudit({ tenantId: input.tenantId, projectId: input.projectId, action: 'result.revision_created', entity: 'result', entityId: result.id, metadata: { batchId: input.batchId, runId: input.runId, revisionNumber, analyte: input.analyte } });
    this.store.addOutbox({ tenantId: input.tenantId, projectId: input.projectId, topic: 'result.revision-created', aggregateId: result.id, payload: JSON.stringify({ resultId: result.id, batchId: input.batchId, revisionNumber }) });
    return result;
  }

  private findCurrent(tenantId: string, projectId: string, batchId: string, target: ResultTarget, analyte: string): ResultRevision | undefined {
    return [...this.store.results.values()].find((result) =>
      result.tenantId === tenantId && result.projectId === projectId && result.batchId === batchId
      && result.analyte === analyte && result.aliquotId === target.aliquotId && result.controlKind === target.controlKind
      && result.status === 'CURRENT');
  }

  private findChain(tenantId: string, projectId: string, batchId: string, runId: string, target: ResultTarget, analyte: string): ResultRevision[] {
    return [...this.store.results.values()].filter((result) =>
      result.tenantId === tenantId && result.projectId === projectId && result.batchId === batchId && result.runId === runId
      && result.analyte === analyte && result.aliquotId === target.aliquotId && result.controlKind === target.controlKind);
  }
}
