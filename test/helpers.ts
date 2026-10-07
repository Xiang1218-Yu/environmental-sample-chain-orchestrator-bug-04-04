import { SampleChainApplication } from '../src/app.js';
import type { AnalysisBatch, Aliquot, ControlRequirement, ResultRevision } from '../src/domain/types.js';
import type { ResultInput } from '../src/services/result-service.js';

export interface ChainOptions {
  app?: SampleChainApplication;
  tenantId?: string;
  projectId?: string;
  aliquotCount?: number;
  totalVolumeMl?: number;
}

export interface ChainFixture {
  app: SampleChainApplication;
  tenantId: string;
  projectId: string;
  aliquots: Aliquot[];
  startBatch: (options?: StartBatchOptions) => AnalysisBatch;
}

export interface StartBatchOptions {
  protocolVersion?: string;
  controls?: ControlRequirement[];
  memberAliquotIds?: string[];
  startedAt?: string;
}

let chainCounter = 0;

/** Builds a fully accepted sample chain: sealed sample -> custody -> lab receipt -> aliquots. */
export function buildChain(options: ChainOptions = {}): ChainFixture {
  chainCounter += 1;
  const suffix = chainCounter.toString().padStart(2, '0');
  const app = options.app ?? new SampleChainApplication();
  const tenantId = options.tenantId ?? `tenant_${suffix}`;
  const projectId = options.projectId ?? `project_${suffix}`;
  const aliquotCount = options.aliquotCount ?? 3;
  const totalVolumeMl = options.totalVolumeMl ?? 10000;

  const sealed = app.sampling.createSealedSample({
    tenantId,
    projectId,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00.000Z',
    location: { latitude: 31.23, longitude: 121.47, siteCode: `SITE-${suffix}` },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: `device_${suffix}`,
    clientSequence: 1,
    containerBarcode: `CNT-${suffix}`,
    sealCode: `SEAL-${suffix}`,
    totalVolumeMl,
  });
  const transfer = app.custody.handOver({
    tenantId,
    projectId,
    containerId: sealed.container.id,
    fromHolderId: 'collector_01',
    toHolderId: 'courier_01',
    fromLocation: 'SITE',
    toLocation: 'LAB',
    handedOverAt: '2026-10-06T08:30:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    clientOperationId: `handover-${suffix}`,
  });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
  app.receiving.receive({
    tenantId,
    projectId,
    containerId: sealed.container.id,
    receivedBy: 'lab_receiver_01',
    receivedAt: '2026-10-06T10:15:00.000Z',
    temperatureCelsius: 5,
    sealStatus: 'INTACT',
    decision: 'ACCEPTED',
    clientOperationId: `receive-${suffix}`,
  });
  const aliquots = app.aliquots.createMany({
    tenantId,
    projectId,
    parentContainerId: sealed.container.id,
    protocolVersion: 'water-v3',
    createdBy: 'analyst_01',
    operationId: `aliquot-${suffix}`,
    items: Array.from({ length: aliquotCount }, (_unused, index) => ({ barcode: `ALQ-${suffix}-${index + 1}`, volumeMl: 20, unit: 'ML' as const })),
  });

  const startBatch = (batchOptions: StartBatchOptions = {}): AnalysisBatch => {
    const batch = app.batches.create({
      tenantId,
      projectId,
      protocolVersion: batchOptions.protocolVersion ?? 'water-v3',
      instrumentType: 'ICP-MS',
      requiredControls: batchOptions.controls ?? [{ kind: 'BLANK', minimumCount: 1 }],
      createdBy: 'analyst_01',
    });
    const members = batchOptions.memberAliquotIds ?? aliquots.map((item) => item.id);
    for (const aliquotId of members) app.batches.addAliquot(batch.id, aliquotId);
    app.batches.markReady(batch.id);
    return app.batches.start(batch.id, batchOptions.startedAt ?? '2026-10-06T11:00:00.000Z');
  };

  return { app, tenantId, projectId, aliquots, startBatch };
}

export function registerRun(fixture: ChainFixture, batchId: string, externalRunId: string, rawFileHash = `raw-${externalRunId}`) {
  return fixture.app.results.registerRun({
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    batchId,
    externalRunId,
    rawFileHash,
    instrumentSoftwareVersion: 'instrument-7.2',
    startedAt: '2026-10-06T11:10:00.000Z',
  });
}

export type IngestOverrides = Partial<Omit<ResultInput, 'tenantId' | 'projectId' | 'batchId' | 'runId' | 'aliquotId' | 'controlKind'>> & {
  aliquotId?: string | undefined;
  controlKind?: ResultInput['controlKind'] | undefined;
};

export function ingest(
  fixture: ChainFixture,
  batchId: string,
  runId: string,
  overrides: IngestOverrides & Pick<ResultInput, 'contentHash'>,
): ResultRevision {
  const firstAliquot = fixture.aliquots[0]?.id;
  const { aliquotId, controlKind, ...rest } = overrides;
  // Default target is the first batch member; an explicit controlKind switches to a control result.
  const useAliquotId = controlKind === undefined ? (aliquotId ?? firstAliquot) : aliquotId;
  return fixture.app.results.ingestRevision({
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    batchId,
    runId,
    analyte: 'lead',
    value: 0.12,
    unit: 'mg/L',
    detectionLimit: 0.01,
    qualityFlags: [],
    instrumentSoftwareVersion: 'instrument-7.2',
    ...(useAliquotId === undefined ? {} : { aliquotId: useAliquotId }),
    ...(controlKind === undefined ? {} : { controlKind }),
    ...rest,
  });
}
