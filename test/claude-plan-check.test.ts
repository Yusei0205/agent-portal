import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planTokenShapeProblem, planTokenFailureMessage } from '../server/claude-plan-check.ts';

describe('Claude plan token check', () => {
  it('refuses an API key or a token with line breaks before any call', () => {
    assert.match(planTokenShapeProblem('sk-ant-api03-xyz')!, /API key/);
    assert.match(planTokenShapeProblem('sk-ant-oat01-a\nb')!, /line breaks/);
    assert.equal(planTokenShapeProblem('sk-ant-oat01-abc'), null);
  });
  it('words the common failures', () => {
    assert.match(planTokenFailureMessage('Invalid bearer token'), /setup-token/);
    assert.match(planTokenFailureMessage('429 usage limit reached'), /usage limit/);
    assert.match(planTokenFailureMessage('boom', 'm'), /could not run m with this token: boom/);
  });
});
