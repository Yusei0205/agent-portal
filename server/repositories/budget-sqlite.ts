/**
 * SQLite implementation of BudgetRepository.
 *
 * Wraps the synchronous node:sqlite insert helper in a Promise.
 * All SQL for budget_usage lives here.
 */

import { insert } from '../db.ts';
import { generateId } from '../util.ts';
import type { BudgetRepository, CreateBudgetInput } from './budget.ts';

export class SqliteBudgetRepository implements BudgetRepository {
  async record(input: CreateBudgetInput): Promise<void> {
    insert('budget_usage', {
      user_id: input.user_id,
      project_id: input.project_id,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      cost_usd: input.cost_usd,
      credits: input.credits ?? 0,
      input_tokens: input.input_tokens,
      output_tokens: input.output_tokens,
      provider: input.provider,
      model: input.model,
      created_at: input.created_at,
    });
    void generateId; // suppress unused warning
  }
}
