/**
 * The chat box's terminal-style editing rules: @file mentions, Ctrl+R search, "\" + Enter, Ctrl+U.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import * as k from '../web/src/lib/composerKeys.js';

describe('findMention', () => {
  it('finds a mention at the start and after a space', () => {
    assert.deepEqual(k.findMention('@sr', 3), { start: 0, end: 3, query: 'sr' });
    assert.deepEqual(k.findMention('fix @src/a', 10), { start: 4, end: 10, query: 'src/a' });
    assert.deepEqual(k.findMention('look @', 6), { start: 5, end: 6, query: '' });
  });
  it('ignores e-mail addresses and finished mentions', () => {
    assert.equal(k.findMention('a@b.com', 7), null);
    assert.equal(k.findMention('@src/a.ts and', 13), null);
  });
  it('uses the text before the caret only', () => {
    assert.deepEqual(k.findMention('@src/app rest', 4), { start: 0, end: 4, query: 'src' });
  });
});

describe('mention listing', () => {
  it('splits a typed path into folder and filter', () => {
    assert.deepEqual(k.splitMentionPath('src/app/ma'), { dir: 'src/app', name: 'ma' });
    assert.deepEqual(k.splitMentionPath('./src/'), { dir: 'src', name: '' });
    assert.deepEqual(k.splitMentionPath('ma'), { dir: '', name: 'ma' });
  });
  it('lists prefix matches first, folders before files, hides dot files', () => {
    const entries = [
      { name: 'main.ts', type: 'file' }, { name: 'app', type: 'directory' }, { name: '.git', type: 'directory' },
      { name: 'domain.ts', type: 'file' }, { name: 'main', type: 'directory' },
    ];
    assert.deepEqual(k.filterEntries(entries, 'ma').map((e: { name: string }) => e.name), ['main', 'main.ts', 'domain.ts']);
    assert.deepEqual(k.filterEntries(entries, '').map((e: { name: string }) => e.name), ['app', 'main', 'domain.ts', 'main.ts']);
    assert.ok(k.filterEntries(entries, '.g').some((e: { name: string }) => e.name === '.git'));
  });
  it('a file ends the mention, a folder keeps it open', () => {
    const m = { start: 4, end: 7, query: 'src' };
    assert.deepEqual(k.applyMention('fix @sr more', { start: 4, end: 7, query: 'sr' }, 'src/a.ts', false), { value: 'fix @src/a.ts  more', caret: 14 });
    assert.deepEqual(k.applyMention('fix @sr', m, 'src', true), { value: 'fix @src/', caret: 9 });
  });
});

describe('searchHistory', () => {
  it('finds matches newest first and nothing for an empty query', () => {
    const list = ['fix login', 'add tests', 'fix logout'];
    assert.deepEqual(k.searchHistory(list, 'FIX'), ['fix logout', 'fix login']);
    assert.deepEqual(k.searchHistory(list, ''), []);
    assert.deepEqual(k.searchHistory(list, 'zzz'), []);
  });
});

describe('line editing', () => {
  it('turns a trailing backslash into a new line', () => {
    assert.deepEqual(k.backslashNewline('line one\\', 9), { value: 'line one\n', caret: 9 });
    assert.equal(k.backslashNewline('no slash', 8), null);
    assert.equal(k.backslashNewline('', 0), null);
  });
  it('Ctrl+U clears back to the start of the current line', () => {
    assert.deepEqual(k.clearToLineStart('one two', 7), { value: '', caret: 0 });
    assert.deepEqual(k.clearToLineStart('a\nbcd ef', 6), { value: 'a\nef', caret: 2 });
  });
});
