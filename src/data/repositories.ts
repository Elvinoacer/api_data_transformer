import { db } from './db';
import {
  CaptureError,
  CaptureSession,
  CaptureStatus,
  EndpointSchema,
  EndpointSource,
  ExtractedRecord,
  RawResponse,
  SessionMetrics,
} from '../shared/types';
import { normalizeEndpoint } from '../privacy/url-redaction';
import { inferBestRecordPath } from '../extraction/path-selector';

export const sessionRepo = {
  async createSession(params: {
    targetTabId: number | null;
    originalUrl: string;
    allowedHostnames: string[];
    label?: string;
  }): Promise<CaptureSession> {
    const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const urlObj = new URL(params.originalUrl || 'http://localhost');
    const label = params.label || `${urlObj.hostname} session`;

    const session: CaptureSession = {
      id,
      label,
      targetTabId: params.targetTabId,
      originalUrl: params.originalUrl,
      allowedHostnames: params.allowedHostnames,
      status: 'starting',
      startedAt: new Date().toISOString(),
    };

    await db.capture_sessions.put(session);
    return session;
  },

  async updateStatus(sessionId: string, status: CaptureStatus, reason?: string): Promise<void> {
    const updates: Partial<CaptureSession> = { status };
    if (reason) updates.errorReason = reason;
    if (status === 'stopped' || status === 'detached') {
      updates.endedAt = new Date().toISOString();
    }
    await db.capture_sessions.update(sessionId, updates);
  },

  async getSession(sessionId: string): Promise<CaptureSession | undefined> {
    return db.capture_sessions.get(sessionId);
  },

  async getActiveSession(): Promise<CaptureSession | undefined> {
    return db.capture_sessions
      .where('status')
      .anyOf(['recording', 'starting', 'paused'])
      .first();
  },

  async getAllSessions(): Promise<CaptureSession[]> {
    return db.capture_sessions.orderBy('startedAt').reverse().toArray();
  },

  async deleteSession(sessionId: string): Promise<void> {
    await db.transaction(
      'rw',
      [
        db.capture_sessions,
        db.raw_responses,
        db.extracted_records,
        db.sources,
        db.capture_errors,
        db.schemas,
      ],
      async () => {
        await db.capture_sessions.delete(sessionId);
        await db.raw_responses.where('sessionId').equals(sessionId).delete();
        await db.extracted_records.where('sessionId').equals(sessionId).delete();
        await db.sources.where('sessionId').equals(sessionId).delete();
        await db.capture_errors.where('sessionId').equals(sessionId).delete();
        await db.schemas.where('sessionId').equals(sessionId).delete();
      }
    );
  },

  async clearSessionRecords(sessionId: string): Promise<void> {
    await db.extracted_records.where('sessionId').equals(sessionId).delete();
  },
};

export const rawResponseRepo = {
  async addResponse(response: RawResponse): Promise<void> {
    await db.raw_responses.put(response);
    await db.capture_sessions.update(response.sessionId, {
      lastResponseAt: response.capturedAt,
    });
  },

  async getBySession(sessionId: string, limit = 100): Promise<RawResponse[]> {
    return db.raw_responses
      .where('sessionId')
      .equals(sessionId)
      .reverse()
      .limit(limit)
      .toArray();
  },

  async getById(id: string): Promise<RawResponse | undefined> {
    return db.raw_responses.get(id);
  },

  async getAllBySession(sessionId: string): Promise<RawResponse[]> {
    return db.raw_responses.where('sessionId').equals(sessionId).toArray();
  },
};

export const sourceRepo = {
  async getOrCreateSource(params: {
    sessionId: string;
    url: string;
    httpMethod: string;
    parsedBody?: unknown;
    operationName?: string;
  }): Promise<EndpointSource> {
    const normalized = normalizeEndpoint(params.url);
    const id = `${params.sessionId}_${params.httpMethod}_${normalized}`;

    const existing = await db.sources.get(id);
    if (existing) {
      existing.observedCount += 1;
      existing.lastObservedAt = new Date().toISOString();
      await db.sources.put(existing);
      return existing;
    }

    // Infer default record path if sample body is provided
    let recordPath = 'root';
    if (params.parsedBody) {
      recordPath = inferBestRecordPath(params.parsedBody);
    }

    const newSource: EndpointSource = {
      id,
      sessionId: params.sessionId,
      normalizedEndpoint: normalized,
      httpMethod: params.httpMethod,
      operationName: params.operationName,
      included: true,
      recordPath,
      identityKeyField: 'id',
      consolidationPolicy: 'keep_latest',
      observedCount: 1,
      lastObservedAt: new Date().toISOString(),
    };

    await db.sources.put(newSource);
    return newSource;
  },

  async updateSource(id: string, updates: Partial<EndpointSource>): Promise<void> {
    await db.sources.update(id, updates);
  },

  async getSourcesBySession(sessionId: string): Promise<EndpointSource[]> {
    return db.sources.where('sessionId').equals(sessionId).toArray();
  },

  async getSource(id: string): Promise<EndpointSource | undefined> {
    return db.sources.get(id);
  },
};

export const recordRepo = {
  async upsertRecords(toInsert: ExtractedRecord[], toUpdate: ExtractedRecord[]): Promise<void> {
    await db.transaction('rw', db.extracted_records, async () => {
      if (toInsert.length > 0) {
        await db.extracted_records.bulkPut(toInsert);
      }
      if (toUpdate.length > 0) {
        await db.extracted_records.bulkPut(toUpdate);
      }
    });
  },

  async getRecordsBySession(sessionId: string, limit = 500): Promise<ExtractedRecord[]> {
    return db.extracted_records
      .where('sessionId')
      .equals(sessionId)
      .limit(limit)
      .toArray();
  },

  async getAllRecordsBySession(sessionId: string): Promise<ExtractedRecord[]> {
    return db.extracted_records.where('sessionId').equals(sessionId).toArray();
  },

  async getRecordsBySource(sessionId: string, sourceId: string): Promise<ExtractedRecord[]> {
    return db.extracted_records
      .where('sessionId')
      .equals(sessionId)
      .filter((r) => r.sourceId === sourceId)
      .toArray();
  },
};

export const schemaRepo = {
  async saveSchema(schema: EndpointSchema): Promise<void> {
    await db.schemas.put(schema);
  },

  async getSchema(sourceId: string): Promise<EndpointSchema | undefined> {
    return db.schemas.get(sourceId);
  },

  async getSchemasBySession(sessionId: string): Promise<EndpointSchema[]> {
    return db.schemas.where('sessionId').equals(sessionId).toArray();
  },
};

export const errorRepo = {
  async logError(params: {
    sessionId: string;
    kind: CaptureError['kind'];
    message: string;
    url?: string;
    details?: unknown;
  }): Promise<void> {
    const error: CaptureError = {
      id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      sessionId: params.sessionId,
      timestamp: new Date().toISOString(),
      kind: params.kind,
      url: params.url,
      message: params.message,
      details: params.details,
    };
    await db.capture_errors.put(error);
  },

  async getErrorsBySession(sessionId: string, limit = 50): Promise<CaptureError[]> {
    return db.capture_errors
      .where('sessionId')
      .equals(sessionId)
      .reverse()
      .limit(limit)
      .toArray();
  },
};

export async function calculateSessionMetrics(sessionId: string): Promise<SessionMetrics> {
  const [
    rawResponses,
    captureErrors,
    uniqueRecords,
    sources,
  ] = await Promise.all([
    db.raw_responses.where('sessionId').equals(sessionId).toArray(),
    db.capture_errors.where('sessionId').equals(sessionId).count(),
    db.extracted_records.where('sessionId').equals(sessionId).count(),
    db.sources.where('sessionId').equals(sessionId).count(),
  ]);

  const responsesObserved = rawResponses.length;
  const responsesSaved = rawResponses.filter((r) => r.parseStatus === 'parsed' || r.parseStatus === 'pending').length;
  let bytesStored = 0;
  for (const r of rawResponses) {
    bytesStored += r.responseBytes || 0;
  }

  // Count total parsed items before deduplication
  const parsedRecords = uniqueRecords; // In MVP, uniqueRecords represents current materialized records

  return {
    responsesObserved,
    responsesSaved,
    captureErrors,
    parsedRecords,
    uniqueRecords,
    endpointGroups: sources,
    bytesStored,
  };
}
