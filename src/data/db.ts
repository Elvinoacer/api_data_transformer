import Dexie, { Table } from 'dexie';
import {
  CaptureError,
  CaptureSession,
  EndpointSchema,
  EndpointSource,
  ExtractedRecord,
  RawResponse,
} from '../shared/types';

export class CollectorDatabase extends Dexie {
  capture_sessions!: Table<CaptureSession, string>;
  raw_responses!: Table<RawResponse, string>;
  extracted_records!: Table<ExtractedRecord, string>;
  sources!: Table<EndpointSource, string>;
  capture_errors!: Table<CaptureError, string>;
  schemas!: Table<EndpointSchema, string>;

  constructor() {
    super('LiveNetworkDataCollectorDB');

    this.version(1).stores({
      capture_sessions: 'id, status, startedAt, originalUrl',
      raw_responses: 'id, sessionId, capturedAt, normalizedEndpoint, parseStatus',
      extracted_records: 'id, sessionId, sourceId, identityKey, [sessionId+sourceId+identityKey], extractedAt',
      sources: 'id, sessionId, normalizedEndpoint',
      capture_errors: 'id, sessionId, timestamp, kind',
      schemas: 'sourceId, sessionId, [sessionId+sourceId]',
    });
  }
}

export const db = new CollectorDatabase();
