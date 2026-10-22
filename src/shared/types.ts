export type CaptureStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopped'
  | 'detached'
  | 'error';

export interface CaptureSession {
  id: string;
  label: string;
  targetTabId: number | null;
  originalUrl: string;
  allowedHostnames: string[];
  status: CaptureStatus;
  startedAt: string;
  endedAt?: string;
  lastResponseAt?: string;
  extractionSettingsId?: string;
  errorReason?: string;
}

export type ParseStatus =
  | 'pending'
  | 'parsed'
  | 'invalid_json'
  | 'excluded'
  | 'failed';

export interface RawResponse {
  id: string;
  sessionId: string;
  capturedAt: string;
  url: string;
  normalizedEndpoint: string;
  httpStatus: number;
  httpMethod: string;
  resourceType: string;
  mimeType: string;
  responseBody: string;
  parseStatus: ParseStatus;
  responseBytes: number;
  contentHash?: string;
  operationName?: string;
  errorMessage?: string;
}

export type ConsolidationPolicy = 'keep_latest' | 'keep_first' | 'keep_all';

export interface ExtractedRecord {
  id: string;
  sessionId: string;
  sourceId: string;
  identityKey: string;
  extractedAt: string;
  latestResponseId: string;
  rawRecord: unknown;
  normalizedFields?: Record<string, unknown>;
  version: number;
}

export interface EndpointSource {
  id: string; // usually normalized endpoint or UUID
  sessionId: string;
  normalizedEndpoint: string;
  httpMethod: string;
  operationName?: string;
  included: boolean;
  recordPath: string; // e.g. "root", "data", "results", "data.items", or custom
  identityKeyField: string; // e.g. "id", "sku", "_id", or "__hash__"
  consolidationPolicy: ConsolidationPolicy;
  observedCount: number;
  lastObservedAt: string;
}

export interface SchemaField {
  path: string;
  types: ('string' | 'number' | 'boolean' | 'null' | 'object' | 'array')[];
  optional: boolean;
  sampleValues: unknown[];
  hasConflict: boolean;
}

export interface EndpointSchema {
  sourceId: string;
  sessionId: string;
  fields: Record<string, SchemaField>;
  inferredRecordPath: string;
  detectedCount: number;
  updatedAt: string;
}

export interface CaptureError {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: 'debugger_attach' | 'body_retrieval' | 'parse_error' | 'storage_limit' | 'other';
  url?: string;
  message: string;
  details?: unknown;
}

export interface SessionMetrics {
  responsesObserved: number;
  responsesSaved: number;
  captureErrors: number;
  parsedRecords: number;
  uniqueRecords: number;
  endpointGroups: number;
  bytesStored: number;
}

export interface RedactionRule {
  keyPattern: string; // regex or exact query key to redact
  replaceWith: string;
}

export interface GlobalSettings {
  maxResponseBodyBytes: number; // default 10MB
  formulaInjectionDefense: boolean;
  defaultExportEncoding: 'utf-8' | 'utf-8-bom';
  sensitiveUrlParams: string[];
  sensitiveEndpointKeywords: string[];
  autoExtractCommonPaths: boolean;
}
