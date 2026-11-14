/**
 * In-memory implementation of AgentcoreLoginRepository.
 *
 * Used for single-process (SQLite) mode where all requests run in the same
 * process.  State is not persisted to the database — device-code flows timeout
 * naturally and do not need cross-restart persistence in single-process mode.
 */

import type {
  AgentcoreLoginRepository,
  AgentcoreLoginEntry,
} from './agentcore-login.ts';

export class InMemoryAgentcoreLoginRepository implements AgentcoreLoginRepository {
  private readonly _map = new Map<string, AgentcoreLoginEntry>();

  async create(credentialId: string, createdAt: string): Promise<void> {
    this._map.set(credentialId, {
      credentialId,
      settled: false,
      state: null,
      errorMessage: null,
      createdAt,
    });
  }

  async get(credentialId: string): Promise<AgentcoreLoginEntry | null> {
    return this._map.get(credentialId) ?? null;
  }

  async complete(
    credentialId: string,
    tokenPayload: AgentcoreLoginEntry['tokenPayload'],
  ): Promise<void> {
    const entry = this._map.get(credentialId);
    if (!entry) return;
    entry.settled = true;
    entry.state = 'complete';
    entry.tokenPayload = tokenPayload;
  }

  async fail(credentialId: string, errorMessage: string): Promise<void> {
    const entry = this._map.get(credentialId);
    if (!entry) return;
    entry.settled = true;
    entry.state = 'failed';
    entry.errorMessage = errorMessage;
  }

  async delete(credentialId: string): Promise<void> {
    this._map.delete(credentialId);
  }
}
