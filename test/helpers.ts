import assert from 'node:assert/strict';
import { SampleChainApplication } from '../src/app.js';
import type { AnalysisBatch, InstrumentRun } from '../src/domain/types.js';
import { DomainError } from '../src/domain/errors.js';

export interface Fixture {
  app: SampleChainApplication;
  tenantId: string;
  projectId: string;
  batchId: string;
  aliquotIds: string[];
  readonly batch: AnalysisBatch;
}

export function getBatch(fixture: Fixture): AnalysisBatch {
  return fixture.app.store.batches.get(fixture.batchId)!;
}

let counter = 0;

export function expectError<T>(code: string, work: () => T): void {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected DomainError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected DomainError(${code}) but no error was thrown`);
}

/** Build a full chain: sealed sample -> received -> aliquots -> started batch. Pass `app` to place a new tenant/project chain in the same store. */
export function setupStartedBatch(options: { app?: SampleChainApplication; controls?: Array<{ kind: 'BLANK' | 'CALIBRATION' | 'POSITIVE_CONTROL' | 'NEGATIVE_CONTROL'; minimumCount: number }>; aliquotCount?: number; memberCount?: number } = {}): Fixture {
  counter += 1;
  const app = options.app ?? new SampleChainApplication();
  const tenantId = `tenant_${counter}`;
  const projectId = `project_${counter}`;
  const suffix = counter;
  const sealed = app.sampling.createSealedSample({
    tenantId,
    projectId,
    collectorId: 'collector_01',
    protocolVersion: 'water-v3',
    medium: 'WATER',
    collectedAt: '2026-10-06T08:00:00.000Z',
    location: { latitude: 31.23, longitude: 121.47, siteCode: `SITE-${suffix}` },
    preservation: { temperatureCelsius: 4, method: 'cooled', maxTransitHours: 48 },
    clientDeviceId: 'device_01',
    clientSequence: 1,
    containerBarcode: `CNT-${suffix}`,
    sealCode: `SEAL-${suffix}`,
    totalVolumeMl: 1000,
  });
  const transfer = app.custody.handOver({
    tenantId, projectId, containerId: sealed.container.id,
    fromHolderId: 'collector_01', toHolderId: 'courier_01',
    fromLocation: 'SITE', toLocation: 'LAB',
    handedOverAt: '2026-10-06T08:30:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT',
    clientOperationId: `handover-${suffix}`,
  });
  app.custody.confirmReceipt(transfer.id, { receiverId: 'courier_01', receivedAt: '2026-10-06T10:00:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT' });
  app.receiving.receive({ tenantId, projectId, containerId: sealed.container.id, receivedBy: 'lab_01', receivedAt: '2026-10-06T10:15:00.000Z', temperatureCelsius: 5, sealStatus: 'INTACT', decision: 'ACCEPTED', clientOperationId: `receive-${suffix}` });
  const aliquotCount = options.aliquotCount ?? 2;
  const items = Array.from({ length: aliquotCount }, (_unused, index) => ({ barcode: `ALQ-${suffix}-${index}`, volumeMl: 20, unit: 'ML' as const }));
  const aliquots = app.aliquots.createMany({ tenantId, projectId, parentContainerId: sealed.container.id, protocolVersion: 'water-v3', createdBy: 'analyst_01', operationId: `aliquot-${suffix}`, items });
  const batch = app.batches.create({ tenantId, projectId, protocolVersion: 'water-v3', instrumentType: 'ICP-MS', requiredControls: options.controls ?? [], createdBy: 'analyst_01' });
  const memberCount = options.memberCount ?? aliquots.length;
  for (const aliquot of aliquots.slice(0, memberCount)) app.batches.addAliquot(batch.id, aliquot.id);
  app.batches.markReady(batch.id);
  app.batches.start(batch.id, '2026-10-06T11:00:00.000Z');
  return {
    app,
    tenantId,
    projectId,
    batchId: batch.id,
    aliquotIds: aliquots.map((item) => item.id),
    get batch(): AnalysisBatch {
      return app.store.batches.get(batch.id)!;
    },
  };
}

export function registerRun(fixture: Fixture, externalRunId: string, rawFileHash: string, batchId: string = fixture.batch.id): InstrumentRun {
  return fixture.app.results.registerRun({ tenantId: fixture.tenantId, projectId: fixture.projectId, batchId, externalRunId, rawFileHash, instrumentSoftwareVersion: 'instrument-7.2', startedAt: '2026-10-06T11:10:00.000Z' });
}

type IngestParameters = Parameters<SampleChainApplication['results']['ingestRevision']>[0];

export function sampleResultInput(fixture: Fixture, runId: string, contentHash: string, overrides: Partial<Omit<IngestParameters, 'aliquotId' | 'controlKind'>> = {}): IngestParameters {
  return {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    batchId: fixture.batch.id,
    runId,
    aliquotId: fixture.aliquotIds[0]!,
    analyte: 'lead',
    value: 0.12,
    unit: 'mg/L',
    detectionLimit: 0.01,
    qualityFlags: [],
    instrumentSoftwareVersion: 'instrument-7.2',
    contentHash,
    ...overrides,
  };
}

export function controlResultInput(fixture: Fixture, runId: string, contentHash: string, controlKind: 'BLANK' | 'CALIBRATION' | 'POSITIVE_CONTROL' | 'NEGATIVE_CONTROL', overrides: Partial<Omit<IngestParameters, 'aliquotId' | 'controlKind'>> = {}): IngestParameters {
  return {
    tenantId: fixture.tenantId,
    projectId: fixture.projectId,
    batchId: fixture.batch.id,
    runId,
    controlKind,
    analyte: 'blank-lead',
    value: 0,
    unit: 'mg/L',
    detectionLimit: 0.01,
    qualityFlags: [],
    instrumentSoftwareVersion: 'instrument-7.2',
    contentHash,
    ...overrides,
  };
}

export { assert };
