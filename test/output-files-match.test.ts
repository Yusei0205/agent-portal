/**
 * Unit tests for web/src/lib/outputFileMatch.js
 *
 * Run with:
 *   npm run test:affected -- --module sessions --backend-only
 * or individually:
 *   npm run test:file -- test/output-files-match.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain JS module without type declarations
import { matchOutputFile, getAllSubpaths, findOutputFileMentions } from '../web/src/lib/outputFileMatch.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FILES = [
  { id: 'f1', name: 'arch.png',    path: 'repos/rhb/docs/architecture/arch.png' },
  { id: 'f2', name: 'README.md',   path: 'repos/rhb/docs/README.md' },
  { id: 'f3', name: 'report.pdf',  path: 'sessions/my-run/output/report.pdf' },
  { id: 'f4', name: 'notes.txt',   path: 'notes.txt' },
];

// ══════════════════════════════════════════════════════════════════════════════
// matchOutputFile
// ══════════════════════════════════════════════════════════════════════════════

describe('matchOutputFile — null/empty inputs', () => {
  it('returns null for empty mentionedPath', () => {
    assert.equal(matchOutputFile('', FILES), null);
  });

  it('returns null for null mentionedPath', () => {
    assert.equal(matchOutputFile(null, FILES), null);
  });

  it('returns null for empty outputFiles array', () => {
    assert.equal(matchOutputFile('arch.png', []), null);
  });

  it('returns null for null outputFiles', () => {
    assert.equal(matchOutputFile('arch.png', null), null);
  });
});

describe('matchOutputFile — exact match', () => {
  it('matches the full path exactly', () => {
    const result = matchOutputFile('repos/rhb/docs/architecture/arch.png', FILES);
    assert.equal(result?.id, 'f1');
  });

  it('matches a root-level file by full path', () => {
    const result = matchOutputFile('notes.txt', FILES);
    assert.equal(result?.id, 'f4');
  });

  it('returns null when no exact match and no suffix match', () => {
    assert.equal(matchOutputFile('totally/different/path.png', FILES), null);
  });
});

describe('matchOutputFile — suffix match', () => {
  it('matches one component stripped from the left', () => {
    // "rhb/docs/architecture/arch.png" is a suffix of "repos/rhb/docs/architecture/arch.png"
    const result = matchOutputFile('rhb/docs/architecture/arch.png', FILES);
    assert.equal(result?.id, 'f1');
  });

  it('matches two components stripped from the left', () => {
    const result = matchOutputFile('docs/architecture/arch.png', FILES);
    assert.equal(result?.id, 'f1');
  });

  it('matches just the filename (no slash in mentionedPath)', () => {
    // output ends with '/arch.png' so mentionedPath='arch.png' is a suffix match
    const result = matchOutputFile('arch.png', FILES);
    assert.equal(result?.id, 'f1');
  });

  it('strips a leading slash before matching', () => {
    const result = matchOutputFile('/repos/rhb/docs/architecture/arch.png', FILES);
    assert.equal(result?.id, 'f1');
  });

  it('returns the first file when two files could match the suffix', () => {
    const withAmbiguous = [
      { id: 'x1', name: 'a.png', path: 'proj/a.png' },
      { id: 'x2', name: 'a.png', path: 'other/a.png' },
    ];
    const result = matchOutputFile('a.png', withAmbiguous);
    assert.equal(result?.id, 'x1');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getAllSubpaths
// ══════════════════════════════════════════════════════════════════════════════

describe('getAllSubpaths', () => {
  it('returns all suffixes in order', () => {
    const result = getAllSubpaths('a/b/c.png');
    assert.deepEqual(result, ['a/b/c.png', 'b/c.png', 'c.png']);
  });

  it('returns a single-element array for a root file', () => {
    assert.deepEqual(getAllSubpaths('notes.txt'), ['notes.txt']);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(getAllSubpaths(''), []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// findOutputFileMentions
// ══════════════════════════════════════════════════════════════════════════════

describe('findOutputFileMentions — empty / no match', () => {
  it('returns empty array for empty text', () => {
    assert.deepEqual(findOutputFileMentions('', FILES), []);
  });

  it('returns empty array when nothing matches', () => {
    assert.deepEqual(findOutputFileMentions('nothing relevant here', FILES), []);
  });
});

describe('findOutputFileMentions — full path mention', () => {
  it('finds a full path in plain text', () => {
    const text = 'I saved the diagram to repos/rhb/docs/architecture/arch.png for you.';
    const results = findOutputFileMentions(text, FILES);
    assert.equal(results.length, 1);
    assert.equal(results[0].file.id, 'f1');
    const matched = text.slice(results[0].start, results[0].end);
    assert.equal(matched, 'repos/rhb/docs/architecture/arch.png');
  });
});

describe('findOutputFileMentions — repo-relative mention', () => {
  it('finds a repo-relative suffix path', () => {
    const text = 'See docs/architecture/arch.png for the diagram.';
    const results = findOutputFileMentions(text, FILES);
    assert.equal(results.length, 1);
    assert.equal(results[0].file.id, 'f1');
  });

  it('finds just the filename when it appears in text', () => {
    const text = 'The output file arch.png has been created.';
    const results = findOutputFileMentions(text, FILES);
    assert.equal(results.length, 1);
    assert.equal(results[0].file.id, 'f1');
  });
});

describe('findOutputFileMentions — multiple files', () => {
  it('finds two files mentioned in the same text', () => {
    const text = 'Generated arch.png and report.pdf as requested.';
    const results = findOutputFileMentions(text, FILES);
    const ids = results.map((r) => r.file.id).sort();
    assert.deepEqual(ids, ['f1', 'f3']);
  });

  it('finds non-overlapping occurrences of the same file', () => {
    const text = 'Check arch.png and also arch.png again.';
    const results = findOutputFileMentions(text, FILES);
    // Both mentions should be found
    assert.equal(results.length, 2);
    results.forEach((r) => assert.equal(r.file.id, 'f1'));
  });
});

describe('findOutputFileMentions — longer match wins at same position', () => {
  it('prefers the longer (more specific) match when two overlap at same start', () => {
    const files = [
      { id: 'short', name: 'c.png',   path: 'c.png' },
      { id: 'long',  name: 'c.png',   path: 'a/b/c.png' },
    ];
    const text = 'See a/b/c.png for details.';
    const results = findOutputFileMentions(text, files);
    assert.equal(results.length, 1);
    assert.equal(results[0].file.id, 'long');
  });
});

describe('findOutputFileMentions — start/end positions', () => {
  it('reports correct start and end indices', () => {
    const text = 'File: arch.png done.';
    // 'arch.png' starts at index 6, ends at 14
    const results = findOutputFileMentions(text, FILES);
    // The long subpath also matches; dedup keeps the longest, but 'arch.png' starts later
    // in the search; the longer path 'repos/rhb/docs/architecture/arch.png' won't match
    // because it's not in the text. So 'arch.png' wins.
    const match = results.find((r) => r.file.id === 'f1');
    assert.ok(match, 'f1 should match');
    assert.equal(text.slice(match.start, match.end), 'arch.png');
  });
});
