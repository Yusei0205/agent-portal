import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchFamily, normalizeError, computeFingerprint } from '../server/autofix/fingerprint.ts';
import { scrubEvidence } from '../server/autofix/scrub.ts';

test('branchFamily', () => {
  assert.equal(branchFamily('main'), 'main');
  assert.equal(branchFamily('feature/login'), 'feature');
  assert.equal(branchFamily('autofix/tests-ab12cd34'), 'autofix');
});

test('the same error with different timestamps, absolute paths, hex ids and line numbers has the same fingerprint', () => {
  const a = '2026-11-17T10:20:30.123Z 10:20:31 Error at /home/alice/work/app/src/x.ts:42:7 id=0xdeadbeef req 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b  failed';
  const b = '2026-12-01T01:02:03Z 01:02:04 Error at /srv/build/app/src/x.ts:99:1 id=0xcafebabe req 1111111111111111111111111111111111111111 failed';
  const i = { repo: 'r1', branch: 'main', kind: 'tests', error: a };
  assert.equal(computeFingerprint(i), computeFingerprint({ ...i, error: b }));
  assert.match(computeFingerprint(i), /^[0-9a-f]{16}$/);
  assert.ok(normalizeError(a).length > 0);
});

test('different kinds or repos give different fingerprints', () => {
  const i = { repo: 'r1', branch: 'main', kind: 'tests', error: 'boom' };
  assert.notEqual(computeFingerprint(i), computeFingerprint({ ...i, kind: 'lint' }));
  assert.notEqual(computeFingerprint(i), computeFingerprint({ ...i, repo: 'r2' }));
});

test('scrubEvidence removes a ghp_ token, an AWS key id (AKIA...), an Authorization: Bearer value and a 40-hex secret assigned to a key named *_SECRET or *_TOKEN', () => {
  const hex = '0123456789abcdef0123456789abcdef01234567';
  const gh = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const out = scrubEvidence(`token ${gh}\nkey AKIAIOSFODNN7EXAMPLE\nAuthorization: Bearer abcdefghijklmnop1234567890\nWEBHOOK_SECRET=${hex}\nAPI_TOKEN: ${hex}\nok line`);
  assert.ok(!out.includes(gh));
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!out.includes('abcdefghijklmnop1234567890'));
  assert.ok(!out.includes(hex));
  assert.ok(out.includes('ok line'));
});

test('scrubEvidence keeps the last maxChars characters', () => {
  const out = scrubEvidence('a'.repeat(100) + 'TAIL', 10);
  assert.equal(out, 'aaaaaaTAIL');
  assert.equal(scrubEvidence('x'.repeat(9000)).length, 8000);
});

test('existing fingerprints are unchanged (pinned outputs for CI and session findings, with no subject)', () => {
  assert.equal(computeFingerprint({ repo: 'acme/shop', branch: 'main', kind: 'tests', error: 'tests failure' }), 'efb1b89e2246b747');
  assert.equal(computeFingerprint({ repo: 'acme/shop', branch: 'feature/login', kind: 'lint', error: 'Error at /srv/app/src/x.ts:42:7 boom' }), '0ad892ae022361f2');
  assert.equal(computeFingerprint({ repo: 'session:p1', branch: 'sessions', kind: 'session', error: 'max_turns ACP error: kiro-cli process exited' }), '885ca538f261d051');
});

test('a subject is hashed exactly, outside the error normalisation', () => {
  const i = { repo: 'acme/shop', branch: 'main', kind: 'review', error: 'Missing input validation' };
  assert.notEqual(computeFingerprint({ ...i, subject: 'server/api/users.ts' }), computeFingerprint({ ...i, subject: 'server/admin/users.ts' }));
  assert.equal(computeFingerprint({ ...i, subject: 'server/api/users.ts' }), computeFingerprint({ ...i, subject: 'server/api/users.ts' }));
  assert.notEqual(computeFingerprint({ ...i, subject: '' }), computeFingerprint(i), 'an empty subject is still a subject');
});
