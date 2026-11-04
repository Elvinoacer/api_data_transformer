import Dexie, { Table } from "dexie";
import {
  ActivityEvent,
  CaptureError,
  CaptureSession,
  EndpointSchema,
  EndpointSource,
  ExtractedRecord,
  RawResponse,
} from "../shared/types";

export interface SyncQueueItem {
  id?: number;
  externalPosId: string;
  payload: Record<string, any>;
  status: "PENDING" | "SYNCING" | "SUCCESS" | "FAILED";
  retryCount: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export class CollectorDatabase extends Dexie {
  capture_sessions!: Table<CaptureSession, string>;
  raw_responses!: Table<RawResponse, string>;
  extracted_records!: Table<ExtractedRecord, string>;
  sources!: Table<EndpointSource, string>;
  capture_errors!: Table<CaptureError, string>;
  schemas!: Table<EndpointSchema, string>;
  activity_events!: Table<ActivityEvent, string>;
  sync_queue!: Table<SyncQueueItem, number>;

  constructor() {
    super("LiveNetworkDataCollectorDB");

    this.version(1).stores({
      capture_sessions: "id, status, startedAt, originalUrl",
      raw_responses:
        "id, sessionId, capturedAt, normalizedEndpoint, parseStatus",
      extracted_records:
        "id, sessionId, sourceId, identityKey, [sessionId+sourceId+identityKey], extractedAt",
      sources: "id, sessionId, normalizedEndpoint",
      capture_errors: "id, sessionId, timestamp, kind",
      schemas: "sourceId, sessionId, [sessionId+sourceId]",
    });

    this.version(2).stores({
      capture_sessions: "id, status, startedAt, originalUrl",
      raw_responses:
        "id, sessionId, capturedAt, normalizedEndpoint, parseStatus",
      extracted_records:
        "id, sessionId, sourceId, identityKey, [sessionId+sourceId+identityKey], extractedAt",
      sources: "id, sessionId, normalizedEndpoint, label",
      capture_errors: "id, sessionId, timestamp, kind",
      schemas: "sourceId, sessionId, [sessionId+sourceId]",
      activity_events: "id, sessionId, timestamp, actor, category",
    });

    // Version 3: Add sync_queue for POS integration & live sync to Sphere Pharmacy
    this.version(3).stores({
      sync_queue: "++id, externalPosId, status, createdAt, updatedAt",
    });
  }
}

export const db = new CollectorDatabase();
export const TransformerDatabase = CollectorDatabase;
export type TransformerDatabase = CollectorDatabase;
