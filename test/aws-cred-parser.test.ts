/**
 * Unit tests for web/src/lib/awsCredParser.js
 *
 * Run a single file with:
 *   npm run test:file -- test/aws-cred-parser.test.ts
 *
 * Run the full suite with:
 *   npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAwsCredentials, _extractKeyValue, _stripQuotes } from '../web/src/lib/awsCredParser.js';

// ── Fixture values ─────────────────────────────────────────────────────────────

/** Permanent-style AKIA key ID */
const KEY_ID  = 'AKIAIOSFODNN7EXAMPLE';
/** Temporary ASIA key ID */
const ASIA_ID = 'ASIAIOSFODNN7EXAMPLE';
/** Secret with `/` and `+` (valid base64 alphabet) */
const SECRET  = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
/** Session token with all three special base64 chars: `+` `/` `=` */
const TOKEN   = 'AQIDAHi+base64/chars=witPadding==';

// ── macOS / Linux — export format ────────────────────────────────────────────

describe('parseAwsCredentials — macOS/Linux export format', () => {
  it('parses all three keys with double quotes', () => {
    const text = [
      `export AWS_ACCESS_KEY_ID="${KEY_ID}"`,
      `export AWS_SECRET_ACCESS_KEY="${SECRET}"`,
      `export AWS_SESSION_TOKEN="${TOKEN}"`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r, 'result must not be null');
    assert.equal(r?.accessKeyId,     KEY_ID);
    assert.equal(r?.secretAccessKey, SECRET);
    assert.equal(r?.sessionToken,    TOKEN);
  });

  it('parses values without any quotes', () => {
    const text = [
      `export AWS_ACCESS_KEY_ID=${KEY_ID}`,
      `export AWS_SECRET_ACCESS_KEY=${SECRET}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId,     KEY_ID);
    assert.equal(r?.secretAccessKey, SECRET);
    assert.equal(r?.sessionToken, undefined);
  });

  it('handles CRLF line endings', () => {
    const text =
      `export AWS_ACCESS_KEY_ID="${KEY_ID}"\r\n` +
      `export AWS_SECRET_ACCESS_KEY="${SECRET}"\r\n` +
      `export AWS_SESSION_TOKEN="${TOKEN}"`;

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId,  KEY_ID);
    assert.equal(r?.sessionToken, TOKEN);
  });

  it('handles bare CR line endings', () => {
    const text = `export AWS_ACCESS_KEY_ID="${KEY_ID}"\rexport AWS_SECRET_ACCESS_KEY="${SECRET}"`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId, KEY_ID);
  });

  it('preserves / characters in the secret access key', () => {
    const text = `export AWS_SECRET_ACCESS_KEY="${SECRET}"`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.secretAccessKey, SECRET);
    assert.ok(r?.secretAccessKey.includes('/'), 'slash must be preserved');
  });

  it('preserves + / = characters in values (explicit test with all three)', () => {
    const val = 'abc+def/ghi=XYZ==';
    const text = `export AWS_SECRET_ACCESS_KEY="${val}"`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.secretAccessKey, val);
    assert.ok(r?.secretAccessKey.includes('+'));
    assert.ok(r?.secretAccessKey.includes('/'));
    assert.ok(r?.secretAccessKey.includes('='));
  });

  it('preserves base64 padding = signs in session token', () => {
    const tok = 'AQIDA+abc/def=gh==';
    const text = `export AWS_SESSION_TOKEN="${tok}"`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.sessionToken, tok);
    assert.ok(r?.sessionToken.endsWith('=='));
  });

  it('ignores leading and trailing whitespace around the block', () => {
    const text = `\n  \nexport AWS_ACCESS_KEY_ID="${KEY_ID}"\n  \n`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId, KEY_ID);
  });
});

// ── Windows CMD — SET format ──────────────────────────────────────────────────

describe('parseAwsCredentials — Windows CMD SET format', () => {
  it('parses SET format (all uppercase)', () => {
    const text = [
      `SET AWS_ACCESS_KEY_ID=${KEY_ID}`,
      `SET AWS_SECRET_ACCESS_KEY=${SECRET}`,
      `SET AWS_SESSION_TOKEN=${TOKEN}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId,     KEY_ID);
    assert.equal(r?.secretAccessKey, SECRET);
    assert.equal(r?.sessionToken,    TOKEN);
  });

  it('parses lowercase "set" keyword', () => {
    const text = `set AWS_ACCESS_KEY_ID=${KEY_ID}`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId, KEY_ID);
  });

  it('parses mixed-case "Set" keyword', () => {
    const text = `Set AWS_SECRET_ACCESS_KEY=${SECRET}`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.secretAccessKey, SECRET);
  });

  it('preserves = padding inside a session token value', () => {
    const tok = 'ABCDabcd1234+/==';
    const text = `SET AWS_SESSION_TOKEN=${tok}`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.sessionToken, tok);
  });
});

// ── PowerShell — $Env: format ─────────────────────────────────────────────────

describe('parseAwsCredentials — PowerShell $Env: format', () => {
  it('parses $Env: with double quotes', () => {
    const text = [
      `$Env:AWS_ACCESS_KEY_ID="${KEY_ID}"`,
      `$Env:AWS_SECRET_ACCESS_KEY="${SECRET}"`,
      `$Env:AWS_SESSION_TOKEN="${TOKEN}"`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId,     KEY_ID);
    assert.equal(r?.secretAccessKey, SECRET);
    assert.equal(r?.sessionToken,    TOKEN);
  });

  it('parses $Env: without quotes', () => {
    const text = `$Env:AWS_ACCESS_KEY_ID=${KEY_ID}`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId, KEY_ID);
  });

  it('parses lowercase $env: prefix', () => {
    const text = `$env:AWS_ACCESS_KEY_ID="${KEY_ID}"`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId, KEY_ID);
  });

  it('parses uppercase $ENV: prefix', () => {
    const text = `$ENV:AWS_SECRET_ACCESS_KEY="${SECRET}"`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.secretAccessKey, SECRET);
  });
});

// ── Credentials file format ───────────────────────────────────────────────────

describe('parseAwsCredentials — credentials file format', () => {
  it('parses file format with spaces around =', () => {
    const text = [
      '[default]',
      `aws_access_key_id = ${KEY_ID}`,
      `aws_secret_access_key = ${SECRET}`,
      `aws_session_token = ${TOKEN}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId,     KEY_ID);
    assert.equal(r?.secretAccessKey, SECRET);
    assert.equal(r?.sessionToken,    TOKEN);
  });

  it('parses file format without spaces around =', () => {
    const text = [
      '[myprofile]',
      `aws_access_key_id=${KEY_ID}`,
      `aws_secret_access_key=${SECRET}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId,     KEY_ID);
    assert.equal(r?.secretAccessKey, SECRET);
  });

  it('extracts profile name from a [accountId_RoleName] header', () => {
    const text = [
      '[123456789012_ReadOnlyAccess]',
      `aws_access_key_id = ${ASIA_ID}`,
      `aws_secret_access_key = ${SECRET}`,
      `aws_session_token = ${TOKEN}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.profileName, '123456789012_ReadOnlyAccess');
    assert.equal(r?.accessKeyId, ASIA_ID);
  });

  it('does not include profileName when no section header is present', () => {
    const text = [
      `aws_access_key_id = ${KEY_ID}`,
      `aws_secret_access_key = ${SECRET}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.profileName, undefined);
  });

  it('uses the first section header when multiple are present', () => {
    const text = [
      '[first-profile]',
      `aws_access_key_id = ${KEY_ID}`,
      '[second-profile]',
      `aws_secret_access_key = ${SECRET}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    // profileName is overwritten by each header; last header wins
    assert.equal(r?.profileName, 'second-profile');
  });

  it('preserves base64 = padding in session token value', () => {
    const tok = 'ABCDabcd+/==';
    const text = [
      '[default]',
      `aws_session_token = ${tok}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.sessionToken, tok);
  });
});

// ── Edge cases & garbage input ────────────────────────────────────────────────

describe('parseAwsCredentials — edge cases', () => {
  it('returns null for an empty string', () => {
    assert.equal(parseAwsCredentials(''), null);
  });

  it('returns null for whitespace-only string', () => {
    assert.equal(parseAwsCredentials('   \n\t\n   '), null);
  });

  it('returns null for null input', () => {
    // @ts-expect-error — testing JS runtime coercion behaviour
    assert.equal(parseAwsCredentials(null), null);
  });

  it('returns null for undefined input', () => {
    // @ts-expect-error
    assert.equal(parseAwsCredentials(undefined), null);
  });

  it('returns null for plain prose (garbage input)', () => {
    assert.equal(parseAwsCredentials('Lorem ipsum dolor sit amet.'), null);
  });

  it('returns null for JSON-like garbage', () => {
    assert.equal(parseAwsCredentials('{"key": "value", "foo": "bar"}'), null);
  });

  it('returns null for only comment lines', () => {
    assert.equal(parseAwsCredentials('# This is a comment\n# Another comment\n'), null);
  });

  it('ignores comment lines (# prefix) and still parses real keys', () => {
    const text = [
      '# Generated by AWS IAM Identity Center',
      `export AWS_ACCESS_KEY_ID="${KEY_ID}"`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId, KEY_ID);
  });

  it('returns partial result when only the access key ID is present', () => {
    const text = `export AWS_ACCESS_KEY_ID="${KEY_ID}"`;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId,     KEY_ID);
    assert.equal(r?.secretAccessKey, undefined);
    assert.equal(r?.sessionToken,    undefined);
  });

  it('handles lines with leading/trailing whitespace', () => {
    const text = `   export AWS_ACCESS_KEY_ID="${KEY_ID}"   `;
    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId, KEY_ID);
  });

  it('mixed formats in same block still extracts all values', () => {
    // Unusual but valid: user pasted a mix (e.g. edited file)
    const text = [
      `export AWS_ACCESS_KEY_ID="${KEY_ID}"`,
      `aws_secret_access_key = ${SECRET}`,
      `SET AWS_SESSION_TOKEN=${TOKEN}`,
    ].join('\n');

    const r = parseAwsCredentials(text);
    assert.ok(r);
    assert.equal(r?.accessKeyId,     KEY_ID);
    assert.equal(r?.secretAccessKey, SECRET);
    assert.equal(r?.sessionToken,    TOKEN);
  });
});

// ── Internal helpers ──────────────────────────────────────────────────────────

describe('_stripQuotes', () => {
  it('strips matching double quotes', () => {
    assert.equal(_stripQuotes('"hello"'), 'hello');
  });

  it('strips matching single quotes', () => {
    assert.equal(_stripQuotes("'hello'"), 'hello');
  });

  it('preserves = padding inside quoted value', () => {
    assert.equal(_stripQuotes('"abc=="'), 'abc==');
  });

  it('does not strip mismatched quotes', () => {
    assert.equal(_stripQuotes('"hello\''), '"hello\'');
  });

  it('returns unquoted value unchanged', () => {
    assert.equal(_stripQuotes('AKIAIOSFODNN7EXAMPLE'), 'AKIAIOSFODNN7EXAMPLE');
  });

  it('trims surrounding whitespace even without quotes', () => {
    assert.equal(_stripQuotes('  hello  '), 'hello');
  });
});

describe('_extractKeyValue', () => {
  it('extracts from export format', () => {
    const kv = _extractKeyValue(`export AWS_ACCESS_KEY_ID="${KEY_ID}"`);
    assert.ok(kv);
    assert.equal(kv?.key,   'AWS_ACCESS_KEY_ID');
    assert.equal(kv?.value, KEY_ID);
  });

  it('extracts from PowerShell $Env: format', () => {
    const kv = _extractKeyValue(`$Env:AWS_SECRET_ACCESS_KEY="${SECRET}"`);
    assert.ok(kv);
    assert.equal(kv?.key,   'AWS_SECRET_ACCESS_KEY');
    assert.equal(kv?.value, SECRET);
  });

  it('extracts from Windows CMD SET format', () => {
    const kv = _extractKeyValue(`SET AWS_SESSION_TOKEN=${TOKEN}`);
    assert.ok(kv);
    assert.equal(kv?.key,   'AWS_SESSION_TOKEN');
    assert.equal(kv?.value, TOKEN);
  });

  it('extracts from credentials file format', () => {
    const kv = _extractKeyValue(`aws_session_token = ${TOKEN}`);
    assert.ok(kv);
    assert.equal(kv?.key,   'aws_session_token');
    assert.equal(kv?.value, TOKEN);
  });

  it('returns null for unrecognisable line', () => {
    assert.equal(_extractKeyValue('Lorem ipsum'), null);
  });

  it('returns null for a section header line', () => {
    // Section headers are handled before _extractKeyValue is called
    // but an isolated bracket line should not match any key pattern
    assert.equal(_extractKeyValue('[default]'), null);
  });
});
