/**
 * Unit tests for web/src/lib/outputFileUtils.js
 *
 * Run with:
 *   npm run test:affected -- --module sessions --backend-only
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error — plain JS module without type declarations
import { formatBytes, getFileTypeMeta, isImageFile, groupOutputsByRunId } from '../web/src/lib/outputFileUtils.js';

// ══════════════════════════════════════════════════════════════════════════════
// formatBytes
// ══════════════════════════════════════════════════════════════════════════════

describe('formatBytes', () => {
  it('returns "0 B" for 0', () => assert.equal(formatBytes(0), '0 B'));
  it('returns "0 B" for null', () => assert.equal(formatBytes(null), '0 B'));
  it('returns "0 B" for undefined', () => assert.equal(formatBytes(undefined), '0 B'));

  it('formats bytes under 1 KB as bytes', () => {
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1023), '1023 B');
  });

  it('formats KB correctly', () => {
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
  });

  it('formats MB correctly', () => {
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 MB');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// getFileTypeMeta
// ══════════════════════════════════════════════════════════════════════════════

describe('getFileTypeMeta — images', () => {
  it('returns Image for image/png', () => {
    const m = getFileTypeMeta('image/png', 'photo.png');
    assert.equal(m.label, 'Image');
    assert.equal(m.icon, 'eye');
  });

  it('returns Image for any image/* mime type', () => {
    assert.equal(getFileTypeMeta('image/jpeg', 'pic.jpg').label, 'Image');
    assert.equal(getFileTypeMeta('image/gif', 'anim.gif').label, 'Image');
    assert.equal(getFileTypeMeta('image/svg+xml', 'icon.svg').label, 'Image');
    assert.equal(getFileTypeMeta('image/webp', 'x.webp').label, 'Image');
  });
});

describe('getFileTypeMeta — PDFs', () => {
  it('returns PDF for application/pdf', () => {
    assert.equal(getFileTypeMeta('application/pdf', 'doc.pdf').label, 'PDF');
  });

  it('returns PDF by .pdf extension when mime is null', () => {
    assert.equal(getFileTypeMeta(null, 'report.pdf').label, 'PDF');
  });
});

describe('getFileTypeMeta — office / text types', () => {
  it('returns PPTX by extension', () => {
    assert.equal(getFileTypeMeta(null, 'deck.pptx').label, 'PPTX');
  });

  it('returns DOCX by extension', () => {
    assert.equal(getFileTypeMeta(null, 'document.docx').label, 'DOCX');
  });

  it('returns MD by extension', () => {
    assert.equal(getFileTypeMeta(null, 'README.md').label, 'MD');
  });

  it('returns Text by text/* mime', () => {
    assert.equal(getFileTypeMeta('text/plain', 'notes.txt').label, 'Text');
    assert.equal(getFileTypeMeta('text/html', 'page.html').label, 'Text');
  });

  it('returns ZIP by extension', () => {
    assert.equal(getFileTypeMeta(null, 'archive.zip').label, 'ZIP');
  });

  it('returns ZIP by mime', () => {
    assert.equal(getFileTypeMeta('application/zip', 'data.zip').label, 'ZIP');
  });

  it('returns JSON by extension', () => {
    assert.equal(getFileTypeMeta(null, 'data.json').label, 'JSON');
  });

  it('falls back to uppercased extension for unknown types', () => {
    assert.equal(getFileTypeMeta(null, 'data.xyz').label, 'XYZ');
  });

  it('falls back to "File" when there is no extension and no mime', () => {
    assert.equal(getFileTypeMeta(null, 'Makefile').label, 'File');
    assert.equal(getFileTypeMeta(null, '').label, 'File');
    assert.equal(getFileTypeMeta(null, null).label, 'File');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// isImageFile
// ══════════════════════════════════════════════════════════════════════════════

describe('isImageFile', () => {
  it('returns true for image/* mime types', () => {
    assert.equal(isImageFile({ mime_type: 'image/png' }), true);
    assert.equal(isImageFile({ mime_type: 'image/jpeg' }), true);
    assert.equal(isImageFile({ mime_type: 'image/svg+xml' }), true);
  });

  it('returns false for non-image mimes', () => {
    assert.equal(isImageFile({ mime_type: 'application/pdf' }), false);
    assert.equal(isImageFile({ mime_type: 'text/plain' }), false);
    assert.equal(isImageFile({ mime_type: 'application/zip' }), false);
  });

  it('returns false for null / missing values', () => {
    assert.equal(isImageFile(null), false);
    assert.equal(isImageFile(undefined), false);
    assert.equal(isImageFile({}), false);
    assert.equal(isImageFile({ mime_type: null }), false);
    assert.equal(isImageFile({ mime_type: '' }), false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// groupOutputsByRunId
// ══════════════════════════════════════════════════════════════════════════════

describe('groupOutputsByRunId', () => {
  const files = [
    { id: 'a', run_id: 'run-1' },
    { id: 'b', run_id: 'run-1' },
    { id: 'c', run_id: 'run-2' },
    { id: 'd', run_id: null },
    { id: 'e' }, // no run_id property at all
  ];

  it('groups files by run_id', () => {
    const map = groupOutputsByRunId(files);
    assert.equal(map.get('run-1')?.length, 2);
    assert.equal(map.get('run-2')?.length, 1);
  });

  it('places files with null/missing run_id under the null key', () => {
    const map = groupOutputsByRunId(files);
    assert.equal(map.get(null)?.length, 2);
  });

  it('preserves file identity in grouped arrays', () => {
    const map = groupOutputsByRunId(files);
    const run1Files = map.get('run-1') ?? [];
    assert.deepEqual(run1Files.map((f) => f.id), ['a', 'b']);
  });

  it('returns empty map for empty array', () => {
    assert.equal(groupOutputsByRunId([]).size, 0);
  });

  it('returns empty map for null', () => {
    assert.equal(groupOutputsByRunId(null).size, 0);
  });

  it('returns empty map for undefined', () => {
    assert.equal(groupOutputsByRunId(undefined).size, 0);
  });

  it('handles a single file correctly', () => {
    const map = groupOutputsByRunId([{ id: 'x', run_id: 'r' }]);
    assert.equal(map.size, 1);
    assert.equal(map.get('r')?.[0]?.id, 'x');
  });
});
