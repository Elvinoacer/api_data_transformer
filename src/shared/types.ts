export type CaptureStatus =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopped"
  | "detached"
  | "error";

export type ScopeMode = "all_tab_apis" | "same_domain" | "selected_hosts";

export interface CaptureSession {
  id: string;
  label: string;
  targetTabId: number | null;
  originalUrl: string;
  allowedHostnames: string[];
  scopeMode?: ScopeMode;
  status: CaptureStatus;
  startedAt: string;
  endedAt?: string;
  lastResponseAt?: string;
  extractionSettingsId?: string;
  errorReason?: string;
}

export type ParseStatus =
  "pending" | "parsed" | "invalid_json" | "excluded" | "failed";

export type PaginationStrategy =
  "page" | "offset" | "cursor" | "next_url" | "none";

export interface DetectedPagination {
  strategy: PaginationStrategy;
  currentPage?: number;
  pageSize?: number;
  totalPages?: number;
  totalRecords?: number;
  hasNextPage?: boolean;
  nextCursor?: string | null;
  nextUrl?: string | null;
  pageParamName?: string;
  limitParamName?: string;
}

export interface SourcePaginationState {
  strategy: PaginationStrategy;
  currentPage?: number;
  pageSize?: number;
  totalPages?: number;
  totalRecords?: number;
  hasNextPage?: boolean;
  nextCursor?: string | null;
  nextUrl?: string | null;
  pageParamName?: string;
  limitParamName?: string;
  observedPages: number[];
  sampleRequestUrl?: string;
}

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
  extractedCount?: number;
  paginationMeta?: DetectedPagination;
  errorMessage?: string;
}

export type ConsolidationPolicy = "keep_latest" | "keep_first" | "keep_all";

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
  id: string; // normalized endpoint key per session
  sessionId: string;
  label: string; // human-friendly dataset label, e.g. "Medicines", "Customers"
  customLabel?: boolean; // true when explicitly edited by user
  normalizedEndpoint: string;
  httpMethod: string;
  operationName?: string;
  included: boolean;
  recordPath: string; // e.g. "root", "data", "results", "data.items", "single_object", or custom
  identityKeyField: string; // e.g. "id", "sku", "_id", or "__hash__"
  consolidationPolicy: ConsolidationPolicy;
  observedCount: number;
  lastObservedAt: string;
  pagination?: SourcePaginationState;
}

export interface SchemaField {
  path: string;
  types: ("string" | "number" | "boolean" | "null" | "object" | "array")[];
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
  kind:
    | "debugger_attach"
    | "body_retrieval"
    | "parse_error"
    | "storage_limit"
    | "other";
  url?: string;
  message: string;
  details?: unknown;
}

export interface ActivityEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  actor: "system" | "user";
  category:
    | "capture"
    | "discovery"
    | "pagination"
    | "extraction"
    | "export"
    | "session"
    | "config"
    | "warning";
  message: string;
  detail?: string;
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

export type AutoPaginateMode = "dom_click" | "api_fetch" | "scroll";

export interface AutoPaginateConfig {
  sessionId: string;
  sourceId?: string;
  mode: AutoPaginateMode;
  delayMs: number;
  maxPages: number;
  customSelector?: string;
  startPage?: number;
  endPage?: number;
}

export interface AutoPaginateState {
  status: "idle" | "running" | "stopping" | "completed" | "error";
  mode?: AutoPaginateMode;
  sourceId?: string;
  pagesAttempted: number;
  maxPages: number;
  initialUniqueRecords: number;
  currentUniqueRecords: number;
  message: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface RedactionRule {
  keyPattern: string; // regex or exact query key to redact
  replaceWith: string;
}

export interface GlobalSettings {
  maxResponseBodyBytes: number; // default 10MB
  formulaInjectionDefense: boolean;
  defaultExportEncoding: "utf-8" | "utf-8-bom";
  sensitiveUrlParams: string[];
  sensitiveEndpointKeywords: string[];
  autoExtractCommonPaths: boolean;
  defaultScopeMode?: ScopeMode;
}
