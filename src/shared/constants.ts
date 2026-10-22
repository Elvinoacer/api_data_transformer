import { GlobalSettings } from './types';

export const DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB

export const DEFAULT_SETTINGS: GlobalSettings = {
  maxResponseBodyBytes: DEFAULT_MAX_BODY_SIZE,
  formulaInjectionDefense: true,
  defaultExportEncoding: 'utf-8-bom',
  sensitiveUrlParams: [
    'access_token',
    'auth_token',
    'token',
    'api_key',
    'apikey',
    'secret',
    'password',
    'pwd',
    'session',
    'session_id',
    'jwt',
    'code',
  ],
  sensitiveEndpointKeywords: [
    '/login',
    '/signin',
    '/signup',
    '/logout',
    '/auth',
    '/oauth',
    '/password',
    '/credentials',
    '/token',
  ],
  autoExtractCommonPaths: true,
};

export const COMMON_ARRAY_PATHS = [
  'root',
  'data',
  'results',
  'items',
  'data.items',
  'data.results',
  'data.records',
  'data.nodes',
  'records',
  'response.data',
  'response.items',
];

export const COMMON_ID_KEYS = [
  'id',
  '_id',
  'uuid',
  'productId',
  'medicineId',
  'medicine_id',
  'sku',
  'code',
  'key',
];
