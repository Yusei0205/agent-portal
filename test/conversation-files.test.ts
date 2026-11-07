import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error jsdom has no bundled declarations
import { JSDOM } from 'jsdom';
// @ts-expect-error plain JS
import { conversationFileLink, linkConversationFiles, resolveConversationPath } from '../web/src/lib/conversationFiles.js';

test('review source links stay in the session, with their line number', () => {
  assert.deepEqual(conversationFileLink('/server/feedback.ts:376'), { path: 'server/feedback.ts', line: 376 });
  assert.deepEqual(conversationFileLink('repos/app/server/review.ts#L91'), { path: 'repos/app/server/review.ts', line: 91 });
  for (const href of ['https://github.com/example/file.ts', '//example.com/file.ts', '#section', '/api/file/download', '../secret.txt', 'javascript:alert(1)']) assert.equal(conversationFileLink(href), null);
});

test('artifact markdown anchors become preview buttons without losing their label', () => {
  const files = [{ id: 'report', name: 'report.pdf', path: 'output/report.pdf' }];
  const dom = new JSDOM('<div><a href="/mnt/data/output/report.pdf">Read report</a><a href="/server/feedback.ts:376">API finding</a><a href="https://github.com/pull/78">PR</a></div>');
  const root = dom.window.document.querySelector('div')!;
  linkConversationFiles(root, []);
  assert.equal(root.querySelectorAll('[data-workspace-file-path]').length, 2, 'file metadata can arrive after the message');
  linkConversationFiles(root, files);
  assert.equal(root.querySelector('[data-output-file-id="report"]')?.textContent, 'Read report');
  assert.equal(root.querySelector('[data-workspace-file-path="server/feedback.ts"]')?.getAttribute('data-file-line'), '376');
  assert.equal(root.querySelectorAll('a').length, 1);
  linkConversationFiles(root, files);
  assert.equal(root.querySelectorAll('button').length, 2);
});

test('repository-relative links use read-only APIs and reject ambiguous paths', async () => {
  const calls: string[] = [];
  let ambiguous = false;
  const api = { get: async (url: string) => {
    calls.push(url);
    if (url.includes('/tree?')) return { entries: [{ name: 'api', type: 'directory' }, { name: 'web', type: 'directory' }] };
    const path = new URL(url, 'http://portal').searchParams.get('path');
    if (path === 'repos/api/server/feedback.ts' || (ambiguous && path === 'repos/web/server/feedback.ts')) return { type: 'text', content: 'source' };
    throw Object.assign(new Error('missing'), { status: 404 });
  } };
  assert.equal(await resolveConversationPath(api, 'session', 'server/feedback.ts'), 'repos/api/server/feedback.ts');
  assert.ok(calls.every(url => url.startsWith('/api/workflows/session/ide/')));
  ambiguous = true;
  await assert.rejects(resolveConversationPath(api, 'session', 'server/feedback.ts'), /several repositories/);
});
