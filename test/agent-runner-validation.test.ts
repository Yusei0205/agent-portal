/**
 * Unit tests for agent-runner payload validation.
 *
 * Tests validatePayload() from agent-runner/src/validate.ts.
 * No portal dependencies — pure validation logic only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePayload,
  DEFAULT_MODEL,
  DEFAULT_MAX_TURNS,
  DEFAULT_MAX_BUDGET_USD,
  DEFAULT_MAX_MINUTES,
} from '../agent-runner/src/validate.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function minPayload(): Record<string, unknown> {
  return { runId: 'run-001', prompt: 'Hello agent' };
}

function ok(raw: unknown) {
  const r = validatePayload(raw);
  assert.ok(r.ok, `Expected ok but got error: ${r.ok ? '' : r.error}`);
  if (!r.ok) throw new Error(r.error);
  return r.payload;
}

function fail(raw: unknown, expectedFragment?: string) {
  const r = validatePayload(raw);
  assert.ok(!r.ok, `Expected validation error but got ok: ${JSON.stringify(raw)}`);
  if (!r.ok && expectedFragment) {
    assert.ok(
      r.error.includes(expectedFragment),
      `Error "${r.error}" does not include "${expectedFragment}"`,
    );
  }
}

// ── Valid payloads ────────────────────────────────────────────────────────────

describe('validatePayload — valid inputs', () => {
  test('minimal payload (runId + prompt)', () => {
    const p = ok(minPayload());
    assert.equal(p.runId, 'run-001');
    assert.equal(p.prompt, 'Hello agent');
    assert.equal(p.model, undefined);
    assert.equal(p.maxTurns, undefined);
    assert.equal(p.maxBudgetUsd, undefined);
    assert.equal(p.maxMinutes, undefined);
    assert.equal(p.repo, undefined);
    assert.equal(p.portal, undefined);
  });

  test('full payload with all optional fields', () => {
    const p = ok({
      ...minPayload(),
      model: 'us.anthropic.claude-sonnet-4-5-20251001-v1:0',
      maxTurns: 5,
      maxBudgetUsd: 1.0,
      maxMinutes: 15,
      repo: { url: 'https://github.com/example/repo', branch: 'main' },
      portal: { url: 'https://portal.example.com', runToken: 'tok-abc' },
    });
    assert.equal(p.model, 'us.anthropic.claude-sonnet-4-5-20251001-v1:0');
    assert.equal(p.maxTurns, 5);
    assert.equal(p.maxBudgetUsd, 1.0);
    assert.equal(p.maxMinutes, 15);
    assert.equal(p.repo?.url, 'https://github.com/example/repo');
    assert.equal(p.repo?.branch, 'main');
    assert.equal(p.portal?.url, 'https://portal.example.com');
    assert.equal(p.portal?.runToken, 'tok-abc');
  });

  test('repo without branch', () => {
    const p = ok({ ...minPayload(), repo: { url: 'https://github.com/example/repo' } });
    assert.equal(p.repo?.url, 'https://github.com/example/repo');
    assert.equal(p.repo?.branch, undefined);
  });

  test('runId with leading/trailing whitespace is trimmed', () => {
    const p = ok({ runId: '  run-trim  ', prompt: 'hi' });
    assert.equal(p.runId, 'run-trim');
  });

  test('model is trimmed', () => {
    const p = ok({ ...minPayload(), model: '  claude-model  ' });
    assert.equal(p.model, 'claude-model');
  });

  test('defaults are exported and have expected values', () => {
    assert.ok(DEFAULT_MODEL.length > 0);
    assert.equal(DEFAULT_MAX_TURNS, 10);
    assert.equal(DEFAULT_MAX_BUDGET_USD, 0.5);
    assert.equal(DEFAULT_MAX_MINUTES, 10);
  });
});

// ── Invalid top-level structure ───────────────────────────────────────────────

describe('validatePayload — top-level structure', () => {
  test('null is rejected', () => fail(null, 'JSON object'));
  test('array is rejected', () => fail([], 'JSON object'));
  test('string is rejected', () => fail('hello', 'JSON object'));
  test('number is rejected', () => fail(42, 'JSON object'));
});

// ── Unknown fields ────────────────────────────────────────────────────────────

describe('validatePayload — unknown fields', () => {
  test('unknown top-level field is rejected', () => {
    fail({ ...minPayload(), extra: 'surprise' }, 'Unknown field: "extra"');
  });

  test('unknown field in repo is rejected', () => {
    fail(
      { ...minPayload(), repo: { url: 'https://github.com/x/y', secret: 'oops' } },
      'Unknown field in "repo"',
    );
  });

  test('unknown field in portal is rejected', () => {
    fail(
      { ...minPayload(), portal: { url: 'https://p.example.com', runToken: 't', hack: 1 } },
      'Unknown field in "portal"',
    );
  });
});

// ── runId ─────────────────────────────────────────────────────────────────────

describe('validatePayload — runId', () => {
  test('missing runId is rejected', () => fail({ prompt: 'hi' }, '"runId"'));
  test('empty runId is rejected', () => fail({ runId: '', prompt: 'hi' }, '"runId"'));
  test('whitespace-only runId is rejected', () => fail({ runId: '   ', prompt: 'hi' }, '"runId"'));
  test('non-string runId is rejected', () => fail({ runId: 123, prompt: 'hi' }, '"runId"'));
  test('oversized runId is rejected', () => {
    fail({ runId: 'x'.repeat(257), prompt: 'hi' }, '"runId"');
  });
});

// ── prompt ────────────────────────────────────────────────────────────────────

describe('validatePayload — prompt', () => {
  test('missing prompt is rejected', () => fail({ runId: 'r1' }, '"prompt"'));
  test('empty prompt is rejected', () => fail({ runId: 'r1', prompt: '' }, '"prompt"'));
  test('whitespace-only prompt is rejected', () => fail({ runId: 'r1', prompt: '   ' }, '"prompt"'));
  test('non-string prompt is rejected', () => fail({ runId: 'r1', prompt: 42 }, '"prompt"'));
  test('oversized prompt is rejected', () => {
    fail({ runId: 'r1', prompt: 'x'.repeat(100_001) }, 'exceeds maximum length');
  });
  test('max-length prompt (100,000 chars) is accepted', () => {
    ok({ runId: 'r1', prompt: 'x'.repeat(100_000) });
  });
});

// ── model ─────────────────────────────────────────────────────────────────────

describe('validatePayload — model', () => {
  test('omitted model is accepted', () => ok(minPayload()));
  test('empty model string is rejected', () => fail({ ...minPayload(), model: '' }, '"model"'));
  test('whitespace-only model is rejected', () => fail({ ...minPayload(), model: '  ' }, '"model"'));
  test('non-string model is rejected', () => fail({ ...minPayload(), model: 123 }, '"model"'));
});

// ── maxTurns ──────────────────────────────────────────────────────────────────

describe('validatePayload — maxTurns', () => {
  test('valid maxTurns accepted', () => {
    const p = ok({ ...minPayload(), maxTurns: 5 });
    assert.equal(p.maxTurns, 5);
  });
  test('maxTurns = 1 accepted', () => ok({ ...minPayload(), maxTurns: 1 }));
  test('maxTurns = 200 accepted', () => ok({ ...minPayload(), maxTurns: 200 }));
  test('maxTurns = 0 rejected', () => fail({ ...minPayload(), maxTurns: 0 }, '"maxTurns"'));
  test('maxTurns = 201 rejected', () => fail({ ...minPayload(), maxTurns: 201 }, '"maxTurns"'));
  test('fractional maxTurns rejected', () => fail({ ...minPayload(), maxTurns: 1.5 }, '"maxTurns"'));
  test('string maxTurns rejected', () => fail({ ...minPayload(), maxTurns: '10' }, '"maxTurns"'));
});

// ── maxBudgetUsd ──────────────────────────────────────────────────────────────

describe('validatePayload — maxBudgetUsd', () => {
  test('valid maxBudgetUsd accepted', () => {
    const p = ok({ ...minPayload(), maxBudgetUsd: 0.25 });
    assert.equal(p.maxBudgetUsd, 0.25);
  });
  test('maxBudgetUsd = 100 accepted', () => ok({ ...minPayload(), maxBudgetUsd: 100 }));
  test('maxBudgetUsd = 0 rejected', () => fail({ ...minPayload(), maxBudgetUsd: 0 }, '"maxBudgetUsd"'));
  test('maxBudgetUsd > 100 rejected', () => fail({ ...minPayload(), maxBudgetUsd: 100.01 }, '"maxBudgetUsd"'));
  test('negative maxBudgetUsd rejected', () => fail({ ...minPayload(), maxBudgetUsd: -1 }, '"maxBudgetUsd"'));
  test('string maxBudgetUsd rejected', () => fail({ ...minPayload(), maxBudgetUsd: '1.5' }, '"maxBudgetUsd"'));
});

// ── maxMinutes ────────────────────────────────────────────────────────────────

describe('validatePayload — maxMinutes', () => {
  test('valid maxMinutes accepted', () => {
    const p = ok({ ...minPayload(), maxMinutes: 15 });
    assert.equal(p.maxMinutes, 15);
  });
  test('maxMinutes = 480 accepted', () => ok({ ...minPayload(), maxMinutes: 480 }));
  test('maxMinutes = 0 rejected', () => fail({ ...minPayload(), maxMinutes: 0 }, '"maxMinutes"'));
  test('maxMinutes > 480 rejected', () => fail({ ...minPayload(), maxMinutes: 481 }, '"maxMinutes"'));
});

// ── repo ──────────────────────────────────────────────────────────────────────

describe('validatePayload — repo', () => {
  test('non-HTTPS repo URL is rejected', () => {
    fail({ ...minPayload(), repo: { url: 'git@github.com:x/y.git' } }, 'HTTPS');
  });
  test('http:// repo URL is rejected', () => {
    fail({ ...minPayload(), repo: { url: 'http://github.com/x/y' } }, 'HTTPS');
  });
  test('empty repo.url is rejected', () => {
    fail({ ...minPayload(), repo: { url: '' } }, '"repo.url"');
  });
  test('repo without url is rejected', () => {
    fail({ ...minPayload(), repo: { branch: 'main' } }, '"repo.url"');
  });
  test('valid repo without branch is accepted', () => {
    const p = ok({ ...minPayload(), repo: { url: 'https://github.com/x/y' } });
    assert.equal(p.repo?.url, 'https://github.com/x/y');
    assert.equal(p.repo?.branch, undefined);
  });
  test('repo URL is trimmed', () => {
    const p = ok({ ...minPayload(), repo: { url: '  https://github.com/x/y  ' } });
    assert.equal(p.repo?.url, 'https://github.com/x/y');
  });
});

// ── portal ────────────────────────────────────────────────────────────────────

describe('validatePayload — portal', () => {
  test('valid portal accepted', () => {
    const p = ok({
      ...minPayload(),
      portal: { url: 'https://portal.example.com', runToken: 'tok-123' },
    });
    assert.equal(p.portal?.url, 'https://portal.example.com');
    assert.equal(p.portal?.runToken, 'tok-123');
  });
  test('portal without url is rejected', () => {
    fail(
      { ...minPayload(), portal: { runToken: 'tok-123' } },
      '"portal.url"',
    );
  });
  test('portal without runToken is rejected', () => {
    fail(
      { ...minPayload(), portal: { url: 'https://portal.example.com' } },
      '"portal.runToken"',
    );
  });
  test('portal is not required (omitted is ok)', () => {
    const p = ok(minPayload());
    assert.equal(p.portal, undefined);
  });
});

describe('validatePayload — auth (Anthropic credential)', () => {
  test('accepts an API key or an OAuth token and trims the secret', () => {
    const a = ok({ ...minPayload(), auth: { kind: 'api_key', secret: '  sk-ant-test  ' } });
    assert.deepEqual(a.auth, { kind: 'api_key', secret: 'sk-ant-test' });
    const b = ok({ ...minPayload(), auth: { kind: 'oauth_token', secret: 'tok' } });
    assert.equal(b.auth?.kind, 'oauth_token');
  });

  test('is optional (Bedrock path keeps working)', () => {
    assert.equal(ok(minPayload()).auth, undefined);
  });

  test('rejects bad kind, empty/oversized secret, unknown fields, non-objects', () => {
    for (const auth of [
      { kind: 'password', secret: 'x' },
      { kind: 'api_key', secret: '' },
      { kind: 'api_key', secret: 'x'.repeat(5000) },
      { kind: 'api_key', secret: 'x', extra: 1 },
      'sk-ant',
      null,
      [],
    ]) {
      assert.equal(validatePayload({ ...minPayload(), auth }).ok, false, JSON.stringify(auth));
    }
  });
});

describe('validatePayload — browser', () => {
  it('accepts a boolean and drops false', () => {
    assert.equal(ok({ ...minPayload(), browser: true }).browser, true);
    assert.equal(ok({ ...minPayload(), browser: false }).browser, undefined);
    assert.equal(ok(minPayload()).browser, undefined);
    assert.equal(validatePayload({ ...minPayload(), browser: 'yes' }).ok, false);
  });
});

describe('validatePayload — trustTools', () => {
  test('accepts a boolean and rejects other types', () => {
    assert.equal(ok({ ...minPayload(), trustTools: false }).trustTools, false);
    assert.equal(ok({ ...minPayload(), trustTools: true }).trustTools, true);
    assert.equal(ok(minPayload()).trustTools, undefined);
    assert.equal(validatePayload({ ...minPayload(), trustTools: 'yes' }).ok, false);
  });
});

describe('validatePayload — effort', () => {
  test('accepts the known levels and keeps them', () => {
    assert.equal(ok({ ...minPayload(), effort: 'high' }).effort, 'high');
    assert.equal(ok({ ...minPayload(), effort: 'xhigh' }).effort, 'xhigh');
    assert.equal(ok(minPayload()).effort, undefined);
  });
  test('rejects an unknown level', () => fail({ ...minPayload(), effort: 'extreme' }, '"effort"'));
});
