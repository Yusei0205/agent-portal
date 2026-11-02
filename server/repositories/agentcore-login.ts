/**
 * Repository interface for AgentCore login state.
 *
 * Replaces the in-process _agentCoreLoginState Map so that a sign-in started
 * on one Lambda instance can be polled from another.
 *
 * SQLite / single-process mode: in-memory Map (no persistence needed; Lambda
 * restarts are rare in single-process mode and the device-code flow times out
 * anyway).
 *
 * DynamoDB mode: portal-runs table with a short TTL (30 minutes).
 *   PK=ACLOGIN#<credentialId>   SK=#STATE
 */

import { InMemoryAgentcoreLoginRepository } from './agentcore-login-sqlite.ts';
import { usesDynamoDb } from './backend.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentcoreLoginEntry {
  credentialId: string;
  settled: boolean;
  /** 'complete' | 'failed' | null (not yet settled) */
  state: 'complete' | 'failed' | null;
  tokenPayload?: {
    access_token: string;
    expires_at: string;
    refresh_token?: string;
    region?: string;
    start_url?: string;
  };
  errorMessage: string | null;
  /** ISO timestamp; used to set DynamoDB TTL. */
  createdAt: string;
}

// ── Repository interface ───────────────────────────────────────────────────────

export interface AgentcoreLoginRepository {
  /** Create or replace a pending login entry. */
  create(credentialId: string, createdAt: string): Promise<void>;

  /** Get a login entry. Returns null if not found or expired. */
  get(credentialId: string): Promise<AgentcoreLoginEntry | null>;

  /** Mark the login as complete with a token payload. */
  complete(credentialId: string, tokenPayload: AgentcoreLoginEntry['tokenPayload']): Promise<void>;

  /** Mark the login as failed with an error message. */
  fail(credentialId: string, errorMessage: string): Promise<void>;

  /** Delete (consume) a login entry. */
  delete(credentialId: string): Promise<void>;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: AgentcoreLoginRepository | null = null;

export async function initAgentcoreLoginRepository(): Promise<void> {
  if (_instance) return;
  if (usesDynamoDb()) {
    const { DynamoDbAgentcoreLoginRepository } = await import('./agentcore-login-dynamodb.ts');
    _instance = new DynamoDbAgentcoreLoginRepository();
  } else {
    _instance = new InMemoryAgentcoreLoginRepository();
  }
}

export function getAgentcoreLoginRepository(): AgentcoreLoginRepository {
  if (!_instance) _instance = new InMemoryAgentcoreLoginRepository();
  return _instance;
}

export function setAgentcoreLoginRepository(repo: AgentcoreLoginRepository): void { _instance = repo; }
export function clearAgentcoreLoginRepository(): void { _instance = null; }
