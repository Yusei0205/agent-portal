/**
 * Tests for git progress parsing and the live-progress API.
 *
 * Covers:
 *   1. parseProgressLine — all git progress line formats
 *   2. parseProgressChunk — \r-separated bursts, partial lines, remote: prefix
 *   3. computeOverallPercent — phase weightings
 *   4. ProgressTracker — monotonicity, throttle, finalize, indeterminate
 *   5. redactCredentials — Authorization header and URL userinfo scrubbing
 *   6. GET /repos/progress endpoint — shape, idle null, injected state
 *   7. POST .../sync — 409 on concurrent sync
 *   8. Existing list/get endpoints include `progress` field
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProgressLine,
  parseProgressChunk,
  computeOverallPercent,
  redactCredentials,
  ProgressTracker,
  phaseOrder,
  PHASE_LABELS,
} from '../server/git-progress.ts';
import type { Phase } from '../server/git-progress.ts';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { _repoProgressForTest, _syncInFlightForTest } from '../server/repos.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 1. parseProgressLine — unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parseProgressLine', () => {
  it('parses Counting objects with percent and count', () => {
    const r = parseProgressLine('Counting objects: 45% (180/400)');
    assert.ok(r, 'should parse');
    assert.equal(r.phase, 'counting');
    assert.equal(r.phasePercent, 45);
    assert.match(r.detail ?? '', /180.*400/);
  });

  it('parses Compressing objects with done marker', () => {
    const r = parseProgressLine('Compressing objects: 100% (360/400), done.');
    assert.ok(r);
    assert.equal(r.phase, 'compressing');
    assert.equal(r.phasePercent, 100);
    assert.match(r.detail ?? '', /360.*400/);
  });

  it('parses Receiving objects with size and speed', () => {
    const r = parseProgressLine('Receiving objects:  37% (1234/3333), 12.34 MiB | 2.10 MiB/s');
    assert.ok(r);
    assert.equal(r.phase, 'receiving');
    assert.equal(r.phasePercent, 37);
    assert.ok(r.detail, 'detail should be non-null');
    assert.match(r.detail!, /1,234.*3,333/);
    assert.match(r.detail!, /12\.34 MiB/);
    assert.match(r.detail!, /2\.10 MiB\/s/);
  });

  it('parses Receiving objects at 100% with size and no speed', () => {
    const r = parseProgressLine('Receiving objects: 100% (3333/3333), 45.67 MiB | 5.21 MiB/s, done.');
    assert.ok(r);
    assert.equal(r.phase, 'receiving');
    assert.equal(r.phasePercent, 100);
    assert.match(r.detail ?? '', /3,333.*3,333/);
  });

  it('parses Resolving deltas', () => {
    const r = parseProgressLine('Resolving deltas:  80% (123/456)');
    assert.ok(r);
    assert.equal(r.phase, 'resolving');
    assert.equal(r.phasePercent, 80);
  });

  it('parses Updating files (checkout phase)', () => {
    const r = parseProgressLine('Updating files: 60% (123/400)');
    assert.ok(r);
    assert.equal(r.phase, 'checkout');
    assert.equal(r.phasePercent, 60);
  });

  it('parses remote: Enumerating objects (indeterminate — no %)', () => {
    const r = parseProgressLine('remote: Enumerating objects: 400, done.');
    assert.ok(r);
    assert.equal(r.phase, 'counting');
    assert.equal(r.phasePercent, null);
    assert.equal(r.detail, null);
  });

  it('parses remote: Enumerating objects mid-count (no "done.")', () => {
    const r = parseProgressLine('remote: Enumerating objects: 400');
    assert.ok(r);
    assert.equal(r.phase, 'counting');
    assert.equal(r.phasePercent, null);
  });

  it('parses remote: Counting objects with percent', () => {
    const r = parseProgressLine('remote: Counting objects: 100% (400/400), done.');
    assert.ok(r);
    assert.equal(r.phase, 'counting');
    assert.equal(r.phasePercent, 100);
    assert.match(r.detail ?? '', /400.*400/);
  });

  it('parses remote: Compressing objects', () => {
    const r = parseProgressLine('remote: Compressing objects:  78% (234/300)');
    assert.ok(r);
    assert.equal(r.phase, 'compressing');
    assert.equal(r.phasePercent, 78);
  });

  it('ignores leading/trailing whitespace', () => {
    const r = parseProgressLine('  Counting objects: 50% (50/100)  ');
    assert.ok(r);
    assert.equal(r.phase, 'counting');
  });

  it('returns null for empty line', () => {
    assert.equal(parseProgressLine(''), null);
    assert.equal(parseProgressLine('   '), null);
  });

  it('returns null for unrecognized git output', () => {
    assert.equal(parseProgressLine('From https://github.com/example/repo'), null);
    assert.equal(parseProgressLine('Already up to date.'), null);
    assert.equal(parseProgressLine(' * [new branch]    feature-x -> origin/feature-x'), null);
  });

  it('returns null for hint/fatal lines', () => {
    assert.equal(parseProgressLine('fatal: repository not found'), null);
    assert.equal(parseProgressLine('error: could not read Username'), null);
  });

  it('formats detail numbers with thousand separators', () => {
    const r = parseProgressLine('Receiving objects:  10% (1234/9876)');
    assert.ok(r);
    // Should have en-US commas
    assert.ok(r.detail?.includes('1,234'), `expected 1,234 in detail, got: ${r.detail}`);
    assert.ok(r.detail?.includes('9,876'), `expected 9,876 in detail, got: ${r.detail}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. parseProgressChunk — \r chunks and partial lines
// ─────────────────────────────────────────────────────────────────────────────

describe('parseProgressChunk', () => {
  it('splits a single complete line (\\r terminated)', () => {
    const { updates, newPartial } = parseProgressChunk('Counting objects: 50% (50/100)\r', '');
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.phase, 'counting');
    assert.equal(newPartial, '');
  });

  it('accumulates partial line with no \\r', () => {
    const { updates, newPartial } = parseProgressChunk('Counting objects: 50%', '');
    assert.equal(updates.length, 0);
    assert.equal(newPartial, 'Counting objects: 50%');
  });

  it('completes partial line when \\r arrives in next chunk', () => {
    const { updates: u1, newPartial: p1 } = parseProgressChunk('Counting objects: 50%', '');
    assert.equal(u1.length, 0);

    const { updates: u2, newPartial: p2 } = parseProgressChunk(' (50/100)\r', p1);
    assert.equal(u2.length, 1);
    assert.equal(u2[0]!.phase, 'counting');
    assert.equal(p2, '');
  });

  it('extracts multiple updates from a \\r-burst', () => {
    const burst =
      'Counting objects:  10% (10/100)\r' +
      'Counting objects:  50% (50/100)\r' +
      'Counting objects: 100% (100/100), done.\r';
    const { updates, newPartial } = parseProgressChunk(burst, '');
    assert.equal(updates.length, 3);
    assert.equal(updates[2]!.phasePercent, 100);
    assert.equal(newPartial, '');
  });

  it('handles \\n-terminated lines (phase done line)', () => {
    const { updates } = parseProgressChunk('Compressing objects: 100% (360/400), done.\n', '');
    assert.equal(updates.length, 1);
    assert.equal(updates[0]!.phase, 'compressing');
  });

  it('handles mixed \\r and \\n separators', () => {
    const chunk = 'Counting objects: 50% (50/100)\rReceiving objects: 10% (10/100), done.\n';
    const { updates } = parseProgressChunk(chunk, '');
    assert.equal(updates.length, 2);
    assert.equal(updates[0]!.phase, 'counting');
    assert.equal(updates[1]!.phase, 'receiving');
  });

  it('skips non-progress lines in a multi-line chunk', () => {
    const chunk =
      'Fetching origin\r' +
      'remote: Enumerating objects: 500, done.\r' +
      'Receiving objects:  15% (75/500)\r';
    const { updates } = parseProgressChunk(chunk, '');
    // "Fetching origin" is not a progress line
    assert.equal(updates.length, 2);
    assert.equal(updates[0]!.phase, 'counting');
    assert.equal(updates[1]!.phase, 'receiving');
  });

  it('carries partial across multiple chunks correctly', () => {
    const part1 = 'Receiving objects:  37% (1234/3333),';
    const part2 = ' 12.34 MiB | 2.10 MiB/s\r';

    const { updates: u1, newPartial: p1 } = parseProgressChunk(part1, '');
    assert.equal(u1.length, 0);

    const { updates: u2, newPartial: p2 } = parseProgressChunk(part2, p1);
    assert.equal(u2.length, 1);
    assert.equal(u2[0]!.phase, 'receiving');
    assert.equal(u2[0]!.phasePercent, 37);
    assert.match(u2[0]!.detail ?? '', /12\.34 MiB/);
    assert.equal(p2, '');
  });

  it('empty chunk with partial just accumulates', () => {
    const { updates, newPartial } = parseProgressChunk('', 'partial');
    assert.equal(updates.length, 0);
    assert.equal(newPartial, 'partial');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. computeOverallPercent — phase weighting contract
// ─────────────────────────────────────────────────────────────────────────────

describe('computeOverallPercent — phase weightings', () => {
  it('connecting returns null (indeterminate)', () => {
    assert.equal(computeOverallPercent('connecting', null), null);
    assert.equal(computeOverallPercent('connecting', 50), null);
  });

  it('counting maps 0→0%, 50→1-2%, 100→3%', () => {
    assert.equal(computeOverallPercent('counting', 0), 0);
    assert.ok(computeOverallPercent('counting', 50)! > 0);
    assert.equal(computeOverallPercent('counting', 100), 3);
  });

  it('compressing maps 0→3%, 100→5%', () => {
    assert.equal(computeOverallPercent('compressing', 0), 3);
    assert.equal(computeOverallPercent('compressing', 100), 5);
  });

  it('receiving maps 0→5%, 100→75% (70% weight)', () => {
    assert.equal(computeOverallPercent('receiving', 0), 5);
    assert.equal(computeOverallPercent('receiving', 100), 75);
    // 50% through receiving ≈ 40%
    const mid = computeOverallPercent('receiving', 50)!;
    assert.ok(mid >= 39 && mid <= 41, `expected ~40, got ${mid}`);
  });

  it('resolving maps 0→75%, 100→95% (20% weight)', () => {
    assert.equal(computeOverallPercent('resolving', 0), 75);
    assert.equal(computeOverallPercent('resolving', 100), 95);
  });

  it('checkout maps 0→95%, 100→100% (5% weight)', () => {
    assert.equal(computeOverallPercent('checkout', 0), 95);
    assert.equal(computeOverallPercent('checkout', 100), 100);
  });

  it('finalizing always returns 100', () => {
    assert.equal(computeOverallPercent('finalizing', null), 100);
    assert.equal(computeOverallPercent('finalizing', 100), 100);
  });

  it('null phasePercent returns the phase start value', () => {
    assert.equal(computeOverallPercent('receiving', null), 5);
    assert.equal(computeOverallPercent('resolving', null), 75);
    assert.equal(computeOverallPercent('checkout', null), 95);
  });

  it('phase ranges are strictly increasing', () => {
    const phases: Phase[] = ['counting', 'compressing', 'receiving', 'resolving', 'checkout'];
    const ends = phases.map((p) => computeOverallPercent(p, 100) as number);
    for (let i = 1; i < ends.length; i++) {
      assert.ok(
        ends[i]! > ends[i - 1]!,
        `Expected phase end to increase: ${phases[i - 1]} (${ends[i - 1]}) < ${phases[i]} (${ends[i]})`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ProgressTracker — monotonicity, phases, indeterminate, finalize
// ─────────────────────────────────────────────────────────────────────────────

describe('ProgressTracker', () => {
  it('starts in connecting phase with null percent (indeterminate)', () => {
    const t = new ProgressTracker();
    const s = t.snapshot;
    assert.equal(s.phase, 'connecting');
    assert.equal(s.percent, null);
    assert.equal(s.phasePercent, null);
    assert.equal(s.detail, null);
    assert.ok(typeof s.startedAt === 'string');
    assert.ok(typeof s.updatedAt === 'string');
  });

  it('advances phase as chunks are fed', () => {
    const t = new ProgressTracker();
    t.feedChunk('Counting objects: 50% (50/100)\r');
    assert.equal(t.snapshot.phase, 'counting');
    assert.equal(t.snapshot.phasePercent, 50);

    t.feedChunk('Receiving objects:  20% (20/100)\r');
    assert.equal(t.snapshot.phase, 'receiving');
  });

  it('percent is monotonically non-decreasing across phases', () => {
    const t = new ProgressTracker();
    const percents: number[] = [];

    t.feedChunk('Counting objects: 100% (100/100), done.\n');
    percents.push(t.snapshot.percent ?? 0);

    t.feedChunk('Compressing objects: 100% (80/100), done.\n');
    percents.push(t.snapshot.percent ?? 0);

    t.feedChunk('Receiving objects:  50% (500/1000)\r');
    percents.push(t.snapshot.percent ?? 0);

    t.feedChunk('Receiving objects: 100% (1000/1000), done.\n');
    percents.push(t.snapshot.percent ?? 0);

    t.feedChunk('Resolving deltas: 100% (400/400), done.\n');
    percents.push(t.snapshot.percent ?? 0);

    for (let i = 1; i < percents.length; i++) {
      assert.ok(
        percents[i]! >= percents[i - 1]!,
        `percent went backward at step ${i}: ${percents[i - 1]} → ${percents[i]}`,
      );
    }
  });

  it('never goes backward in phases', () => {
    const t = new ProgressTracker();
    t.feedChunk('Resolving deltas: 80% (80/100)\r');
    const beforePhase = t.snapshot.phase;
    // Feed a counting line AFTER resolving — should be ignored
    t.feedChunk('Counting objects: 10% (10/100)\r');
    assert.equal(t.snapshot.phase, beforePhase, 'phase should not go backward');
  });

  it('overall percent never decreases within a phase', () => {
    const t = new ProgressTracker();
    const percents: number[] = [];
    for (let pct = 0; pct <= 100; pct += 10) {
      const total = 1000;
      const done = Math.round((pct / 100) * total);
      t.feedChunk(`Receiving objects:  ${pct}% (${done}/${total})\r`);
      percents.push(t.snapshot.percent!);
    }
    for (let i = 1; i < percents.length; i++) {
      assert.ok(
        percents[i]! >= percents[i - 1]!,
        `within-phase percent decreased: ${percents[i - 1]} → ${percents[i]}`,
      );
    }
  });

  it('finalize moves to 100% and finalizing phase', () => {
    const t = new ProgressTracker();
    t.feedChunk('Receiving objects:  80% (800/1000)\r');
    t.finalize();
    const s = t.snapshot;
    assert.equal(s.phase, 'finalizing');
    assert.equal(s.percent, 100);
    assert.equal(s.phasePercent, 100);
  });

  it('flushes remaining partial line on finalize', () => {
    const t = new ProgressTracker();
    // Simulate a partial line with no terminating \r
    t.feedChunk('Resolving deltas:  50% (50/100)');
    assert.equal(t.snapshot.phase, 'connecting', 'partial line not yet parsed');
    t.finalize();
    // After finalize, partial should be flushed, but finalize overrides to finalizing
    assert.equal(t.snapshot.phase, 'finalizing');
    assert.equal(t.snapshot.percent, 100);
  });

  it('handles "no progress output" case — stays indeterminate until finalize', () => {
    const t = new ProgressTracker();
    // No chunks fed — simulates a no-op fetch
    assert.equal(t.snapshot.percent, null);
    t.finalize();
    assert.equal(t.snapshot.percent, 100);
    assert.equal(t.snapshot.phase, 'finalizing');
  });

  it('detail updates with latest data within a phase', () => {
    const t = new ProgressTracker();
    t.feedChunk('Receiving objects:  10% (100/1000), 1.00 MiB | 1.00 MiB/s\r');
    const detail1 = t.snapshot.detail;
    assert.ok(detail1?.includes('100'));

    t.feedChunk('Receiving objects:  50% (500/1000), 5.00 MiB | 2.00 MiB/s\r');
    const detail2 = t.snapshot.detail;
    assert.ok(detail2?.includes('500'));
    assert.ok(detail2?.includes('5.00 MiB'));
  });

  it('detail resets when phase changes', () => {
    const t = new ProgressTracker();
    t.feedChunk('Receiving objects: 100% (1000/1000), 10.00 MiB | 3.00 MiB/s, done.\n');
    assert.ok(t.snapshot.detail?.includes('1,000'));

    t.feedChunk('Resolving deltas:   1% (1/400)\r');
    // Phase changed — detail should reflect resolving phase, not receiving
    const newDetail = t.snapshot.detail;
    assert.ok(
      newDetail === null || !newDetail.includes('10.00 MiB'),
      `detail should not carry over from receiving phase; got: ${newDetail}`,
    );
  });

  it('phaseLabel matches PHASE_LABELS', () => {
    const t = new ProgressTracker();
    t.feedChunk('Resolving deltas:  40% (40/100)\r');
    assert.equal(t.snapshot.phaseLabel, PHASE_LABELS['resolving']);
  });

  it('all phases have string labels', () => {
    const phases: Phase[] = ['connecting', 'counting', 'compressing', 'receiving', 'resolving', 'checkout', 'finalizing'];
    for (const p of phases) {
      assert.ok(typeof PHASE_LABELS[p] === 'string', `missing label for ${p}`);
      assert.ok(PHASE_LABELS[p].length > 0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. redactCredentials
// ─────────────────────────────────────────────────────────────────────────────

describe('redactCredentials', () => {
  it('redacts Authorization header value', () => {
    const out = redactCredentials('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.xxx');
    assert.ok(out.includes('Authorization: [REDACTED]'));
    assert.ok(!out.includes('Bearer'), 'token should be removed');
  });

  it('redacts Authorization: Basic value', () => {
    const out = redactCredentials('Authorization: Basic dXNlcjpwYXNz');
    assert.ok(out.includes('[REDACTED]'));
    assert.ok(!out.includes('dXNlcjpwYXNz'));
  });

  it('redacts URL userinfo (user:pass@host)', () => {
    const out = redactCredentials('https://user:mySecret@git-codecommit.us-east-1.amazonaws.com/v1/repos/MyApp');
    assert.ok(out.includes('[REDACTED]'), `expected redaction in: ${out}`);
    assert.ok(!out.includes('mySecret'), 'password should be removed');
    assert.ok(out.includes('git-codecommit'), 'hostname should remain');
  });

  it('leaves clean URLs untouched', () => {
    const url = 'https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyApp';
    assert.equal(redactCredentials(url), url);
  });

  it('leaves plain error messages untouched', () => {
    const msg = 'fatal: repository not found';
    assert.equal(redactCredentials(msg), msg);
  });

  it('handles multiple occurrences in a single string', () => {
    const msg = 'GET https://alice:secret1@host.com and Authorization: Bearer tok123';
    const out = redactCredentials(msg);
    assert.ok(!out.includes('secret1'));
    assert.ok(!out.includes('tok123'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6–8. Integration tests (server required)
// ─────────────────────────────────────────────────────────────────────────────

describe('repos progress — API integration', () => {
  let baseUrl: string;
  let adminCookie: string;
  let projectId: string;

  before(async () => {
    const ts = await createTestServer();
    baseUrl = ts.baseUrl;

    await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: 'progress-admin@example.com', name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    const loginR = await fetchJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'progress-admin@example.com', password: 'password1234' },
    });
    adminCookie = loginR.cookie ?? '';

    const pR = await fetchJson(baseUrl, '/api/projects', {
      method: 'POST',
      body: { name: 'Progress Test Project' },
      cookie: adminCookie,
    });
    projectId = ((pR.body as Record<string, unknown>).project as Record<string, unknown>)?.id as string ?? '';
    assert.ok(projectId, 'projectId must be set');
  });

  after(async () => {
    // Clean up any injected state
    _repoProgressForTest.clear();
    _syncInFlightForTest.clear();
    await cleanup();
  });

  // ── 6a. Idle repo has progress: null ─────────────────────────────────────

  it('GET /repos returns progress:null for idle repos', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'idle-repo', url: 'https://github.com/example/idle', provider: 'github' },
      cookie: adminCookie,
    });
    assert.equal(createR.status, 201);
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    // Remove any tracker that may have been set by the background clone attempt
    _repoProgressForTest.delete(repoId);

    const listR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, { cookie: adminCookie });
    assert.equal(listR.status, 200);
    const repos = (listR.body as Record<string, unknown>).repos as Array<Record<string, unknown>>;
    const repo = repos.find((r) => r.id === repoId);
    assert.ok(repo, 'repo should appear in list');
    assert.equal(repo.progress, null, 'progress should be null when idle');
  });

  it('GET /repos/:repoId returns progress:null for idle repo', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'idle-single', url: 'https://github.com/example/idle-single', provider: 'github' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';
    _repoProgressForTest.delete(repoId);

    const getR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${repoId}`, { cookie: adminCookie });
    assert.equal(getR.status, 200);
    const repo = (getR.body as Record<string, unknown>).repo as Record<string, unknown>;
    assert.equal(repo.progress, null);
  });

  // ── 6b. GET /repos/progress endpoint shape ───────────────────────────────

  it('GET /repos/progress endpoint returns correct shape with injected progress', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'progress-shape', url: 'https://github.com/example/shape', provider: 'github' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    // Inject a known progress state
    const tracker = new ProgressTracker();
    tracker.feedChunk('Receiving objects:  45% (450/1000), 12.34 MiB | 2.10 MiB/s\r');
    _repoProgressForTest.set(repoId, tracker);

    try {
      const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/progress`, { cookie: adminCookie });
      assert.equal(r.status, 200);
      const body = r.body as { repos: Array<Record<string, unknown>> };
      assert.ok(Array.isArray(body.repos), 'repos should be an array');

      const entry = body.repos.find((r) => r.id === repoId);
      assert.ok(entry, 'repo should appear in progress list');

      // Shape checks — all required fields
      assert.ok('id' in entry, 'entry must have id');
      assert.ok('status' in entry, 'entry must have status');
      assert.ok('lastError' in entry, 'entry must have lastError (camelCase)');
      assert.ok(entry.progress !== null, 'progress must be non-null when tracker is set');

      const progress = entry.progress as Record<string, unknown>;
      assert.equal(progress.phase, 'receiving');
      assert.equal(progress.phaseLabel, 'Receiving objects');
      assert.equal(progress.phasePercent, 45);
      assert.ok(typeof progress.percent === 'number', 'percent must be a number');
      assert.ok((progress.percent as number) >= 5 && (progress.percent as number) <= 75, `overall percent ${progress.percent} should be in receiving range`);
      assert.ok(typeof progress.detail === 'string', 'detail must be a string');
      assert.match(progress.detail as string, /450.*1,000/);
      assert.match(progress.detail as string, /12\.34 MiB/);
      assert.ok(typeof progress.startedAt === 'string', 'startedAt must be ISO string');
      assert.ok(typeof progress.updatedAt === 'string', 'updatedAt must be ISO string');
    } finally {
      _repoProgressForTest.delete(repoId);
    }
  });

  it('GET /repos/progress returns progress:null for repos with no active tracker', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'no-tracker', url: 'https://github.com/example/no-tracker', provider: 'github' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';
    _repoProgressForTest.delete(repoId);

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/progress`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const body = r.body as { repos: Array<Record<string, unknown>> };
    const entry = body.repos.find((e) => e.id === repoId);
    assert.ok(entry);
    assert.equal(entry.progress, null, 'progress must be null when no tracker exists');
  });

  it('GET /repos/progress requires authentication', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/progress`);
    assert.equal(r.status, 401);
  });

  it('GET /repos/progress progress becomes null after tracker is removed (sync done)', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'done-tracker', url: 'https://github.com/example/done', provider: 'github' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    const tracker = new ProgressTracker();
    tracker.finalize();
    _repoProgressForTest.set(repoId, tracker);

    // Verify it shows 100%
    const r1 = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/progress`, { cookie: adminCookie });
    const body1 = r1.body as { repos: Array<Record<string, unknown>> };
    const entry1 = body1.repos.find((e) => e.id === repoId);
    assert.equal((entry1?.progress as Record<string, unknown>)?.percent, 100);

    // Simulate the 2s cleanup
    _repoProgressForTest.delete(repoId);

    // Now progress should be null
    const r2 = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/progress`, { cookie: adminCookie });
    const body2 = r2.body as { repos: Array<Record<string, unknown>> };
    const entry2 = body2.repos.find((e) => e.id === repoId);
    assert.equal(entry2?.progress, null);
  });

  it('GET /repos/progress indeterminate tracker shows percent:null', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'indeterminate', url: 'https://github.com/example/indet', provider: 'github' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    // A tracker with no chunks fed = connecting phase = indeterminate
    const tracker = new ProgressTracker();
    _repoProgressForTest.set(repoId, tracker);

    try {
      const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/progress`, { cookie: adminCookie });
      const body = r.body as { repos: Array<Record<string, unknown>> };
      const entry = body.repos.find((e) => e.id === repoId);
      assert.ok(entry?.progress !== null, 'progress should exist (tracker is set)');
      const progress = entry?.progress as Record<string, unknown>;
      assert.equal(progress.phase, 'connecting');
      assert.equal(progress.percent, null, 'indeterminate = percent:null');
    } finally {
      _repoProgressForTest.delete(repoId);
    }
  });

  // ── 7. Concurrent sync → 409 ─────────────────────────────────────────────

  it('POST .../sync returns 409 when sync is already in flight', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'concurrent-sync', url: 'https://github.com/example/concurrent', provider: 'github' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    // Mark repo as in-flight (simulates a slow running sync)
    _syncInFlightForTest.add(repoId);

    try {
      const syncR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${repoId}/sync`, {
        method: 'POST',
        cookie: adminCookie,
      });
      assert.equal(syncR.status, 409, `expected 409, got ${syncR.status}: ${JSON.stringify(syncR.body)}`);
      const body = syncR.body as Record<string, unknown>;
      assert.ok(typeof body.error === 'string', 'error field required');
      assert.ok((body.error as string).toLowerCase().includes('progress') || (body.error as string).toLowerCase().includes('sync'),
        `error message should mention sync: ${body.error}`);
    } finally {
      _syncInFlightForTest.delete(repoId);
    }
  });

  // ── 8. Existing list/get include progress field ───────────────────────────

  it('POST /repos returns progress field in response (null initially)', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'has-progress-field', url: 'https://github.com/example/prog', provider: 'github' },
      cookie: adminCookie,
    });
    assert.equal(r.status, 201);
    const repo = (r.body as Record<string, unknown>).repo as Record<string, unknown>;
    assert.ok('progress' in repo, 'progress field must be present in POST response');
  });

  it('GET /repos list includes progress field for each repo', async () => {
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const repos = (r.body as Record<string, unknown>).repos as Array<Record<string, unknown>>;
    for (const repo of repos) {
      assert.ok('progress' in repo, `repo ${repo.id} missing progress field`);
    }
  });

  it('GET /repos/:repoId includes progress field', async () => {
    const createR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos`, {
      method: 'POST',
      body: { name: 'single-progress', url: 'https://github.com/example/sp', provider: 'github' },
      cookie: adminCookie,
    });
    const repoId = ((createR.body as Record<string, unknown>).repo as Record<string, unknown>)?.id as string ?? '';

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/${repoId}`, { cookie: adminCookie });
    assert.equal(r.status, 200);
    const repo = (r.body as Record<string, unknown>).repo as Record<string, unknown>;
    assert.ok('progress' in repo, 'progress field must be present in GET response');
  });

  it('GET /repos/progress is not confused with GET /repos/:repoId', async () => {
    // "progress" should NOT be treated as a repoId
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/progress`, { cookie: adminCookie });
    assert.equal(r.status, 200, `should return 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    const body = r.body as Record<string, unknown>;
    assert.ok('repos' in body, 'should return { repos: [...] } not a single repo');
  });

  it('POST /repos/bulk includes progress field for added repos', async () => {
    // Create a shared connection
    const connR = await fetchJson(baseUrl, '/api/git-connections', {
      method: 'POST',
      body: { name: 'bulk-test-conn', provider: 'github', credentials: { token: 'gho_fake' }, scope: 'shared' },
      cookie: adminCookie,
    });
    const connId = ((connR.body as Record<string, unknown>).connection as Record<string, unknown>)?.id as string ?? '';
    assert.ok(connId, 'connection must be created');

    const bulkR = await fetchJson(baseUrl, `/api/projects/${projectId}/repos/bulk`, {
      method: 'POST',
      body: {
        connectionId: connId,
        repos: [{ url: 'https://github.com/org/bulk-progress-test.git', name: 'bulk-progress-test' }],
      },
      cookie: adminCookie,
    });
    assert.equal(bulkR.status, 200);
    const added = (bulkR.body as Record<string, unknown>).added as Array<Record<string, unknown>>;
    assert.equal(added.length, 1);
    assert.ok('progress' in added[0]!, 'bulk-added repo should have progress field');
  });
});
