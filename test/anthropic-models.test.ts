import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicModelFor, resolveAnthropicModel, DEFAULT_ANTHROPIC_RUN_MODEL } from '../server/agent/anthropic-models.ts';

describe('model names for runs with an Anthropic key or Claude plan', () => {
  it('keeps Claude IDs and aliases, and turns Bedrock IDs and profile ARNs into the same model\'s Anthropic ID', () => {
    assert.equal(anthropicModelFor('claude-opus-5-5'), 'claude-opus-5-5');
    assert.equal(anthropicModelFor('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5-20250929');
    assert.equal(anthropicModelFor(' Sonnet '), 'sonnet');
    assert.equal(anthropicModelFor('fable'), 'fable');
    // The model of the session that failed with "There's an issue with the selected model".
    assert.equal(anthropicModelFor('global.anthropic.claude-opus-4-6-v1'), 'claude-opus-4-6');
    assert.equal(anthropicModelFor('global.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5-20250929');
    assert.equal(anthropicModelFor('apac.anthropic.claude-haiku-4-5-20251001-v1:0'), 'claude-haiku-4-5-20251001');
    assert.equal(anthropicModelFor('anthropic.claude-opus-5-5'), 'claude-opus-5-5');
    assert.equal(anthropicModelFor('global.anthropic.claude-sonnet-4-6'), 'claude-sonnet-4-6');
    assert.equal(anthropicModelFor('arn:aws:bedrock:ap-southeast-1:123456789012:inference-profile/global.anthropic.claude-sonnet-4-6'), 'claude-sonnet-4-6');
    for (const other of ['', '   ', null, undefined, 'gpt-5', 'global.anthropic.x:0', 'arn:aws:bedrock:ap-southeast-1:123456789012:application-inference-profile/abc123', 'meta.llama3-70b-instruct-v1:0']) {
      assert.equal(anthropicModelFor(other), undefined, String(other));
    }
  });

  it("uses the session's model, its Anthropic name when it is a Bedrock ID, else the portal default, and says why", () => {
    assert.deepEqual(resolveAnthropicModel('claude-opus-5-5', 'global.anthropic.claude-opus-4-6-v1'), { model: 'claude-opus-5-5' });
    assert.deepEqual(resolveAnthropicModel('opus', null), { model: 'opus' });

    const bedrock = resolveAnthropicModel('global.anthropic.claude-opus-4-6-v1', null);
    assert.equal(bedrock.model, 'claude-opus-4-6');
    assert.match(bedrock.note ?? '', /global\.anthropic\.claude-opus-4-6-v1 is a Bedrock name, so the run uses claude-opus-4-6/);

    // No model of its own: the portal's default, which on a Bedrock portal is a Bedrock name too.
    assert.deepEqual(resolveAnthropicModel('', 'global.anthropic.claude-opus-4-6-v1'), { model: 'claude-opus-4-6' });
    assert.deepEqual(resolveAnthropicModel(null, 'claude-sonnet-5-5'), { model: 'claude-sonnet-5-5' });
    assert.deepEqual(resolveAnthropicModel(undefined, ''), { model: DEFAULT_ANTHROPIC_RUN_MODEL });
    assert.deepEqual(resolveAnthropicModel('  ', 'arn:aws:bedrock:x:1:application-inference-profile/abc'), { model: DEFAULT_ANTHROPIC_RUN_MODEL });

    const unknown = resolveAnthropicModel('arn:aws:bedrock:ap-southeast-1:1:application-inference-profile/abc', 'claude-sonnet-5-5');
    assert.equal(unknown.model, 'claude-sonnet-5-5');
    assert.match(unknown.note ?? '', /cannot run with an Anthropic sign-in, so the run uses claude-sonnet-5-5\. Pick another with \/model/);
  });
});
