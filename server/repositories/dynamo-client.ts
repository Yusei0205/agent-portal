/**
 * Shared DynamoDB client and attribute-marshaling helpers.
 *
 * All DynamoDB repository implementations import from here so the AWS SDK
 * client is created once and the helpers are defined in one place.
 *
 * This file imports @aws-sdk/client-dynamodb and should only be imported
 * by files that are themselves dynamically loaded when DynamoDB is active
 * (i.e. concrete *-dynamodb.ts repository implementations).
 */

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { getDynamoDbEndpoint, getDynamoDbRegion } from './backend.ts';

// ── Shared client singleton ────────────────────────────────────────────────────

let _client: DynamoDBClient | null = null;

/**
 * Return true only when the endpoint points at localhost or 127.0.0.1.
 * Fake credentials must never be injected for a real AWS endpoint.
 */
function isLocalEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Return the shared DynamoDB client (lazily created on first call).
 * Region defaults to ap-southeast-1 when no AWS_REGION env var is set.
 */
export function getDynamoDbClient(): DynamoDBClient {
  if (_client) return _client;
  const endpoint = getDynamoDbEndpoint();
  _client = new DynamoDBClient({
    region: getDynamoDbRegion(),
    ...(endpoint ? { endpoint } : {}),
    // Inject fake credentials only for DynamoDB Local (localhost/127.0.0.1) so the
    // SDK skips the default credential chain.  A misconfigured production endpoint
    // must never silently use fake credentials.
    ...(endpoint && isLocalEndpoint(endpoint) ? {
      credentials: {
        accessKeyId:     'fakeAccessKeyId',
        secretAccessKey: 'fakeSecretAccessKey',
      },
    } : {}),
  });
  return _client;
}

/** Reset the client singleton — for tests that need an injected client. */
export function clearDynamoDbClient(): void {
  _client = null;
}

// ── Attribute value helpers ────────────────────────────────────────────────────

export type JsVal = string | number | null | undefined;

/**
 * Convert a JavaScript primitive to a DynamoDB AttributeValue.
 *   null / undefined → { NULL: true }
 *   number           → { N: '...' }
 *   string           → { S: '...' }
 */
export function av(v: JsVal): AttributeValue {
  if (v == null) return { NULL: true };
  if (typeof v === 'number') return { N: String(v) };
  return { S: String(v) };
}

/**
 * Marshal a plain object of JS primitives into a DynamoDB attribute map.
 * Keys whose value is `undefined` are omitted entirely.
 * Keys whose value is `null` are stored as `{ NULL: true }`.
 */
export function marshalItem(obj: Record<string, JsVal>): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = av(v);
  }
  return out;
}

/** Read a string attribute value (returns null when absent or stored as NULL). */
export function getString(item: Record<string, AttributeValue>, key: string): string | null {
  const v = item[key];
  if (!v) return null;
  if (v.S != null) return v.S;
  if (v.N != null) return v.N;
  if (v.NULL) return null;
  return null;
}

/** Read a numeric attribute value (returns 0 when absent). */
export function getNumber(item: Record<string, AttributeValue>, key: string): number {
  const v = item[key];
  if (!v) return 0;
  if (v.N != null) return Number(v.N);
  if (v.BOOL != null) return v.BOOL ? 1 : 0;
  return 0;
}
