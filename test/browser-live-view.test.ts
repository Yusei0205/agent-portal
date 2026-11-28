/** The signed address the portal hands the page for AgentCore Browser Live View. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { presignLiveViewUrl } from '../server/browser-live-view.ts';

describe('presignLiveViewUrl', () => {
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const k of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION']) saved[k] = process.env[k];
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'secretexample';
    process.env.AWS_SESSION_TOKEN = 'tokenexample';
    process.env.AWS_REGION = 'ap-southeast-1';
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('signs the live-view stream address of the session for a short time', async () => {
    const url = new URL(await presignLiveViewUrl('aws.browser.v1', 'sess-123', 300));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.host, 'bedrock-agentcore.ap-southeast-1.amazonaws.com');
    assert.equal(url.pathname, '/browser-streams/aws.browser.v1/sessions/sess-123/live-view');
    assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
    assert.equal(url.searchParams.get('X-Amz-Security-Token'), 'tokenexample');
    assert.match(url.searchParams.get('X-Amz-Credential') ?? '', /^AKIDEXAMPLE\/\d{8}\/ap-southeast-1\/bedrock-agentcore\/aws4_request$/);
    assert.match(url.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
  });

  it('refuses ids that could change the path', async () => {
    await assert.rejects(presignLiveViewUrl('aws.browser.v1', '../x'));
    await assert.rejects(presignLiveViewUrl('a/b', 'sess'));
  });
});
