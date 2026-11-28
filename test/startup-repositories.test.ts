/**
 * Regression test: every repository is initialised at startup.
 *
 * Production runs USE_DYNAMODB=true. A repository whose init*Repository() is never called from startServer() falls back
 * to SQLite through its lazy getter, where foreign keys to tables that only exist in DynamoDB (projects) fail. This
 * happened to pipeline-runs and autofix-findings: every stored run and every Auto-fix finding failed in production.
 *
 * 1. Every exported init*Repository() in server/repositories is called from server/index.ts.
 * 2. With USE_DYNAMODB=true the pipeline-runs and autofix-findings init functions select the DynamoDB classes (no
 *    network: constructing a DynamoDB client does not connect).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function exportedInitFunctions(): string[] {
  const dir = path.join(root, 'server', 'repositories');
  const names: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/export\s+async\s+function\s+(init\w*Repository)\s*\(/g)) names.push(m[1]);
  }
  return names.sort();
}

describe('startup initialises every repository', () => {
  it('server/index.ts calls every exported init*Repository()', () => {
    const index = fs.readFileSync(path.join(root, 'server', 'index.ts'), 'utf8');
    const names = exportedInitFunctions();
    assert.ok(names.includes('initPipelineRunsRepository'));
    assert.ok(names.includes('initAutofixFindingsRepository'));
    const missing = names.filter((n) => !new RegExp(`\\b${n}\\s*\\(\\s*\\)`).test(index));
    assert.deepEqual(missing, [], `not initialised at startup: ${missing.join(', ')}`);
  });

  describe('with USE_DYNAMODB=true', () => {
    const saved = { use: process.env.USE_DYNAMODB, endpoint: process.env.DYNAMODB_ENDPOINT };
    after(async () => {
      if (saved.use === undefined) delete process.env.USE_DYNAMODB; else process.env.USE_DYNAMODB = saved.use;
      if (saved.endpoint === undefined) delete process.env.DYNAMODB_ENDPOINT; else process.env.DYNAMODB_ENDPOINT = saved.endpoint;
      (await import('../server/repositories/pipeline-runs.ts')).clearPipelineRunsRepository();
      (await import('../server/repositories/autofix-findings.ts')).clearAutofixFindingsRepository();
    });

    it('pipeline-runs and autofix-findings are the DynamoDB classes', async () => {
      process.env.USE_DYNAMODB = 'true';
      process.env.DYNAMODB_ENDPOINT ??= 'http://127.0.0.1:1';
      const runs = await import('../server/repositories/pipeline-runs.ts');
      const findings = await import('../server/repositories/autofix-findings.ts');
      runs.clearPipelineRunsRepository();
      findings.clearAutofixFindingsRepository();
      await runs.initPipelineRunsRepository();
      await findings.initAutofixFindingsRepository();
      const { DynamoDbPipelineRunsRepository } = await import('../server/repositories/pipeline-runs-dynamodb.ts');
      const { DynamoDbAutofixFindingsRepository } = await import('../server/repositories/autofix-findings-dynamodb.ts');
      assert.ok(runs.getPipelineRunsRepository() instanceof DynamoDbPipelineRunsRepository);
      assert.ok(findings.getAutofixFindingsRepository() instanceof DynamoDbAutofixFindingsRepository);
    });
  });
});
