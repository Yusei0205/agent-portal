import { describe, test, before } from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig, setConfig } from '../server/config.ts';
import {
  issueGmailToken, verifyGmailToken, headerValue, messageText, attachmentNames, cleanAddresses, buildRawMessage, GMAIL_SCOPES,
} from '../server/gmail.ts';
import { issueWorkspaceToken } from '../server/google-workspace.ts';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

describe('Gmail run token', () => {
  before(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-test-'));
    setConfig(await loadConfig());
  });

  test('a token names the person, expires, and is not interchangeable with the Drive token', () => {
    const t = issueGmailToken('user-1', 1000);
    assert.ok(t.startsWith('gm_'));
    assert.equal(verifyGmailToken(t, 1000 + 100), 'user-1');
    assert.equal(verifyGmailToken(t, 1000 + 8 * 3600 + 1), null);
    assert.equal(verifyGmailToken(`gm_${issueWorkspaceToken('user-1').slice(3)}`), null, 'a Drive token re-labelled is refused');
    assert.equal(verifyGmailToken('gm_nonsense'), null);
  });

  test('asks for mail reading and drafting, not full mail access', () => {
    assert.ok(GMAIL_SCOPES.includes('https://www.googleapis.com/auth/gmail.readonly'));
    assert.ok(!GMAIL_SCOPES.includes('https://mail.google.com/'));
  });
});

describe('Gmail message helpers', () => {
  test('headerValue is case-insensitive', () => {
    assert.equal(headerValue([{ name: 'SUBJECT', value: 'Hi' }], 'subject'), 'Hi');
    assert.equal(headerValue(undefined, 'x'), '');
  });

  test('messageText prefers the plain part and falls back to HTML as text', () => {
    const both = { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
      { mimeType: 'text/plain', body: { data: b64('plain') } },
    ] };
    assert.equal(messageText(both), 'plain');
    const htmlOnly = { mimeType: 'text/html', body: { data: b64('<style>x{}</style><p>Hello&nbsp;<b>you</b></p><p>Bye</p>') } };
    assert.equal(messageText(htmlOnly), 'Hello you\nBye');
  });

  test('attachments are listed by name and their data is not read as text', () => {
    const p = { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', body: { data: b64('body') } },
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64('secret') } },
    ] };
    assert.deepEqual(attachmentNames(p), ['notes.txt']);
    assert.equal(messageText(p), 'body');
  });
});

describe('Gmail outgoing mail', () => {
  const rawOf = (m: Parameters<typeof buildRawMessage>[0]): string => Buffer.from(buildRawMessage(m), 'base64url').toString('utf8');

  test('builds headers and a base64 body', () => {
    const raw = rawOf({ to: 'a@x.com', cc: 'B <b@x.com>', subject: 'Hello', body: 'Line one' });
    assert.match(raw, /^To: a@x\.com\r\nCc: B <b@x\.com>\r\nSubject: Hello\r\n/);
    assert.match(raw, /\r\n\r\nTGluZSBvbmU=$/);
  });

  test('a non-ASCII subject is encoded', () => {
    assert.match(rawOf({ to: 'a@x.com', subject: 'Café', body: 'x' }), /Subject: =\?UTF-8\?B\?/);
  });

  test('a line break in any header is refused (no header injection)', () => {
    assert.throws(() => buildRawMessage({ to: 'a@x.com\r\nBcc: evil@x.com', subject: 's', body: 'b' }), /one line/);
    assert.throws(() => buildRawMessage({ to: 'a@x.com', subject: 's\r\nBcc: evil@x.com', body: 'b' }), /one line/);
    assert.throws(() => buildRawMessage({ to: 'a@x.com', subject: 's', body: 'b', inReplyTo: '<1>\nBcc: e@x.com' }), /one line/);
  });

  test('recipients must be addresses', () => {
    assert.throws(() => cleanAddresses('not an address', 'to'), /not an email address/);
    assert.equal(cleanAddresses('a@x.com, "B" <b@x.com>', 'to'), 'a@x.com, "B" <b@x.com>');
    assert.throws(() => buildRawMessage({ to: '', subject: 's', body: 'b' }), /required/);
  });
});

describe('Gmail entities', () => {
  test('decodeEntities turns snippets and HTML text into characters', async () => {
    const { decodeEntities } = await import('../server/gmail.ts');
    assert.equal(decodeEntities('today&#39;s top &amp; best &quot;deals&quot; &lt;3 &#x1F600;'), 'today\'s top & best "deals" <3 😀');
    assert.equal(decodeEntities('&amp;lt;'), '&lt;', 'not decoded twice');
  });
});
