/**
 * Shared types for client API simulation (see docs/plans/2026-11-10-api-simulation.md).
 *
 * The canonical spec format is a subset of OpenAPI 3.0 held as plain JSON. Extension fields:
 *   x-conditional  text of a rule we cannot enforce ("mandatory when action = 142")
 *   x-flags        things a person should look at (shown with an exclamation icon)
 *   x-source       where in the client's document a schema came from
 */

export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface Schema {
  type?: SchemaType;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: Array<string | number | boolean>;
  maxLength?: number;
  minLength?: number;
  format?: string;
  example?: unknown;
  /** Rule we cannot express as a schema; reported as a warning, never an error. */
  'x-conditional'?: string;
  'x-enum-descriptions'?: Record<string, string>;
  'x-flags'?: Flag[];
}

/** Something a person should check. Never blocks a request; `error` severity is reserved for real failures. */
export interface Flag {
  code: string;
  message: string;
  severity: 'warning' | 'info';
  /** Where it applies, e.g. "request.collateralList[].collateralType". */
  at?: string;
}

export interface Parameter {
  name: string;
  in: 'header' | 'query' | 'path';
  required?: boolean;
  schema?: Schema;
  description?: string;
}

export interface Operation {
  operationId: string;
  summary?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: { 'application/json': { schema: Schema } } };
  responses: Record<string, { description?: string; content?: { 'application/json': { schema: Schema; example?: unknown } } }>;
  /** Present (even if empty-valued) means the operation needs an Authorization header. */
  security?: Array<Record<string, string[]>>;
  'x-flags'?: Flag[];
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ApiSpec {
  openapi: '3.0.3';
  info: { title: string; version: string };
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
  components?: { securitySchemes?: Record<string, unknown> };
  'x-flags'?: Flag[];
}

export type FailureKind = 'timeout' | 'server_error' | 'rate_limited' | 'malformed';

/** A scripted answer for one operation. */
export interface MockRule {
  id: string;
  operationId: string;
  name: string;
  /** Top-level body fields (dot paths allowed) and query values that must equal these. Empty = always matches. */
  when?: { body?: Record<string, unknown>; query?: Record<string, string> };
  response?: { status: number; headers?: Record<string, string>; body?: unknown };
  failure?: FailureKind;
  delayMs?: number;
  /** Set when the spec changed under the rule; the rule is blocked until a person confirms it. */
  needsReview?: boolean;
}

export interface MockRequest {
  method: string;
  /** Path below the API's base path, starting with "/". */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export type MockSource = 'rule' | 'generated' | 'invalid' | 'blocked' | 'failure';

export interface MockResult {
  status: number;
  headers: Record<string, string>;
  /** A parsed value, or a raw string for a deliberately malformed body. */
  body: unknown;
  delayMs: number;
  source: MockSource;
  operationId?: string;
  ruleId?: string;
  /** Non-blocking findings, e.g. a conditional rule the request may break. */
  warnings: Flag[];
}
