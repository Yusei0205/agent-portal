import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../infra/lib/automation-bridge.js', import.meta.url), 'utf8');

function bridge(response: unknown, functionError = false) {
  const calls: any[] = [];
  class Command { constructor(public input: any) {} }
  class LambdaClient { async send(command: Command) { calls.push(command.input); return { Payload: Buffer.from(JSON.stringify(response)), FunctionError: functionError ? 'Error' : undefined }; } }
  class SecretsManagerClient { async send() { return { SecretString: 'internal-secret' }; } }
  const context: any = { exports: {}, Buffer, process: { env: { PORTAL_FUNCTION_NAME: 'portal', SECRET_ARN: 'secret-arn' } }, require: (name: string) => name.includes('lambda') ? { LambdaClient, InvokeCommand: Command } : { SecretsManagerClient, GetSecretValueCommand: Command } };
  vm.runInNewContext(source, context);
  return { handler: context.exports.handler, calls };
}
test('cloud bridge unwraps the actual Web Adapter proxy response and returns only routing state', async () => {
  const { handler, calls } = bridge({ statusCode: 200, body: JSON.stringify({ ok: true, result: { done: false } }) });
  const out = await handler({ projectId: 'p', runId: 'r' });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { projectId: 'p', runId: 'r', done: false });
  const request = JSON.parse(calls[0].Payload.toString()); assert.equal(request.secret, 'internal-secret'); assert.equal(request.job, 'automation-tick');
});
test('cloud bridge records coordinator failures through the same authenticated path', async () => {
  const { handler, calls } = bridge({ result: { done: true } });
  assert.equal((await handler({ projectId: 'p', runId: 'r', fail: true })).done, true);
  assert.equal(JSON.parse(calls[0].Payload.toString()).job, 'automation-fail');
});
test('cloud bridge rejects Lambda failures, HTTP errors, and malformed results so Step Functions retries', async () => {
  for (const [payload, error] of [[{}, true], [{ statusCode: 500 }, false], [{ result: {} }, false]] as const) {
    await assert.rejects(bridge(payload, error).handler({ projectId: 'p', runId: 'r' }), /failed|error|invalid/);
  }
});
