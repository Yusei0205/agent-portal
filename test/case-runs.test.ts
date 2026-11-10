import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { maskRunSecrets, setRunSecrets, passwordPlaceholder } from '../server/agent/run-secrets.ts';
import { normaliseStatus, parseCsv, parseAgentResults, csvField, tally, buildRunPrompt, buildResultsCsv, selectCases } from '../server/testing/case-runs.ts';

describe('agent test runs: reading the agent\'s results.csv', () => {
  test('statuses are mapped onto the sheet\'s four values', () => {
    assert.equal(normaliseStatus('PASS'), 'Pass');
    assert.equal(normaliseStatus('passed'), 'Pass');
    assert.equal(normaliseStatus('Failed - wrong total'), 'Fail');
    assert.equal(normaliseStatus('blocked'), 'Blocked');
    assert.equal(normaliseStatus('Skipped'), 'Blocked');
    assert.equal(normaliseStatus('maybe?'), 'Not Run');
    assert.equal(normaliseStatus(''), 'Not Run');
  });

  test('quoted fields keep commas, quotes and line breaks', () => {
    const rows = parseCsv('Test ID,Status,Remarks\r\nTC-1,Pass,"Saw ""Welcome"", then the list"\r\nTC-2,Fail,"two\nlines"\r\n');
    assert.deepEqual(rows[1], ['TC-1', 'Pass', 'Saw "Welcome", then the list']);
    assert.deepEqual(rows[2], ['TC-2', 'Fail', 'two\nlines']);
  });

  test('columns are found by name in any order, and a missing Test ID or Status gives nothing', () => {
    const r = parseAgentResults('Evidence,Status,Remarks,Test ID\n/home,Pass,ok,TC-1\n/x,blocked,no login,TC-2\n');
    assert.deepEqual(r.map((x) => [x.testId, x.status]), [['TC-1', 'Pass'], ['TC-2', 'Blocked']]);
    assert.equal(r[0].evidence, '/home');
    assert.deepEqual(parseAgentResults('Name,Outcome\nTC-1,Pass\n'), []);
  });

  test('totals count pass, fail, blocked and the rest', () => {
    assert.deepEqual(tally(['Pass', 'Pass', 'Fail', 'Blocked', 'Not Run', '']), { total: 6, pass: 2, fail: 1, blocked: 1, notRun: 2 });
  });
});

describe('agent test runs: sign-in accounts', () => {
  const tp = { app_url: 'https://app.test', api_base_url: null, rules_for_ai: '' };
  const cases = [{ test_id: 'TC-1', category: '', scenario: 's', precondition: '', steps: 'x', expected_result: 'y' }] as never[];
  test('chosen logins are in the prompt; none means no section', () => {
    const withLogin = buildRunPrompt(tp, cases, '', [{ name: 'admin', username: 'qa@x.com', password: 'pw1', hasTotp: true }]);
    assert.match(withLogin, /admin: username qa@x\.com, password pw1/);
    assert.match(withLogin, /two-step code/);
    assert.doesNotMatch(buildRunPrompt(tp, cases, ''), /Test accounts/);
  });
});

describe('run secrets', () => {
  test('a registered password is masked, also inside JSON', () => {
    setRunSecrets('r1', ['p@ss"word1']);
    const masked = maskRunSecrets('r1', JSON.stringify({ text: 'type p@ss"word1 into the field' }));
    assert.doesNotMatch(masked, /word1/);
    assert.equal(maskRunSecrets('other', 'p@ss"word1'), 'p@ss"word1');
  });
  test('placeholder round-trips a name with odd characters', () => {
    assert.match(passwordPlaceholder('tp1', 'Admin: login'), /^\{\{password:tp1:Admin%3A%20login\}\}$/);
  });
});

describe('agent test runs: which cases', () => {
  const all = [
    { id: 1, status: '', category: 'Login' }, { id: 2, status: 'Pass', category: 'Login' },
    { id: 3, status: 'Fail', category: 'Cart' }, { id: 4, status: 'Not Run', category: 'Cart' }, { id: 5, status: 'Blocked', category: 'Cart' },
  ];
  test('all, without Pass, not run yet, and one category', () => {
    assert.deepEqual(selectCases(all, 'all', '').map((c) => c.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(selectCases(all, 'notPassed', '').map((c) => c.id), [1, 3, 4, 5]);
    assert.deepEqual(selectCases(all, 'notRun', '').map((c) => c.id), [1, 4]);
    assert.deepEqual(selectCases(all, 'notPassed', 'Cart').map((c) => c.id), [3, 4, 5]);
  });
});

describe('agent test runs: what goes out', () => {
  const cases = [{ id: 'a', test_id: 'TC-1', category: 'Login', scenario: 'Valid login', precondition: 'A test user exists', steps: '1. Open /login\n2. Sign in', expected_result: 'Dashboard shows', status: '', remarks: '', ord: 1 }];

  test('the prompt carries the app, the cases and the exact CSV format', () => {
    const p = buildRunPrompt({ app_url: 'https://app.example', api_base_url: null, rules_for_ai: 'Use the staging data only.' }, cases, 'Login as qa@example.com');
    assert.match(p, /https:\/\/app\.example/);
    assert.match(p, /\[TC-1\] Login: Valid login/);
    assert.match(p, /Test ID,Status,Remarks,Evidence/);
    assert.match(p, /Use the staging data only\./);
    assert.match(p, /Login as qa@example\.com/);
  });

  test('a spreadsheet cannot run what the agent wrote: a leading = + - @ is defused', () => {
    assert.equal(csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvField('+1'), "'+1");
    assert.equal(csvField('plain'), 'plain');
    assert.equal(csvField('a,b'), '"a,b"');
  });

  test('the results CSV has a header, a byte-order mark for Excel, and one row per case', () => {
    const csv = buildResultsCsv('cr_1', '2026-11-05T00:00:00Z', [{ test_id: 'TC-1', category: 'Login', scenario: 'Valid login', expected_result: 'Dashboard', status: 'Pass', remarks: 'ok' }]);
    assert.ok(csv.startsWith('﻿Run ID,Date,Test ID'));
    assert.equal(csv.trim().split('\r\n').length, 2);
    assert.match(csv, /cr_1,2026-11-05T00:00:00Z,TC-1,Login,Valid login,Dashboard,Pass,ok/);
  });
});
