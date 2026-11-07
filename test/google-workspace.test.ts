import { describe, test, before } from 'node:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig, setConfig } from '../server/config.ts';
import { issueWorkspaceToken, verifyWorkspaceToken, docText, slidesText, driveQueryLiteral, WORKSPACE_SCOPES } from '../server/google-workspace.ts';

describe('Google Workspace run token', () => {
  before(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
    setConfig(await loadConfig());
  });

  test('a token names the person and verifies', () => {
    const t = issueWorkspaceToken('user-1');
    assert.ok(t.startsWith('gw_'));
    assert.equal(verifyWorkspaceToken(t), 'user-1');
  });

  test('it expires after the working day', () => {
    const t = issueWorkspaceToken('user-1', 1000);
    assert.equal(verifyWorkspaceToken(t, 1000 + 8 * 3600 - 1), 'user-1');
    assert.equal(verifyWorkspaceToken(t, 1000 + 8 * 3600 + 1), null);
  });

  test('a changed payload or signature is refused', () => {
    const t = issueWorkspaceToken('user-1');
    const [payload, mac] = t.slice(3).split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'admin', e: 9999999999 })).toString('base64url');
    assert.equal(verifyWorkspaceToken(`gw_${forged}.${mac}`), null);
    assert.equal(verifyWorkspaceToken(`gw_${payload}.${mac}x`), null);
    assert.equal(verifyWorkspaceToken('gw_nonsense'), null);
    assert.equal(verifyWorkspaceToken('ap_something'), null);
  });
});

describe('Google Workspace text helpers', () => {
  test('docText joins paragraphs and table cells', () => {
    const doc = {
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: 'Hello ' } }, { textRun: { content: 'world\n' } }] } },
          { table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'cell\n' } }] } }] }] }] } },
        ],
      },
    };
    assert.equal(docText(doc), 'Hello world\ncell\n');
  });

  test('slidesText numbers the slides and skips empty shapes', () => {
    const text = slidesText({
      slides: [
        { pageElements: [{ shape: { text: { textElements: [{ textRun: { content: 'Title\n' } }] } } }, { shape: {} }] },
        { pageElements: [] },
      ],
    });
    assert.equal(text, '--- Slide 1 ---\nTitle\n--- Slide 2 ---');
  });

  test('a search word cannot break out of the Drive query', () => {
    assert.equal(driveQueryLiteral("it's"), "it\\'s");
    assert.equal(driveQueryLiteral("a' or name contains 'b"), "a\\' or name contains \\'b");
  });

  test('the connection asks for Drive, Docs, Sheets and Slides', () => {
    for (const s of ['drive', 'documents', 'spreadsheets', 'presentations']) {
      assert.ok(WORKSPACE_SCOPES.some((x) => x.endsWith(`/auth/${s}`)), s);
    }
  });
});
