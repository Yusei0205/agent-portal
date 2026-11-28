import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { editDiffLines } from '../web/src/lib/edit-diff.js';

describe('editDiffLines', () => {
  it('shows only the lines that changed', () => {
    assert.deepEqual(editDiffLines({ old_string: 'a\nb\nc', new_string: 'a\nB\nc' }), [
      { kind: 'del', text: 'b' }, { kind: 'add', text: 'B' },
    ]);
  });
  it('shows a pure insertion and a pure deletion', () => {
    assert.deepEqual(editDiffLines({ old_string: 'a', new_string: 'a\nb' }), [{ kind: 'add', text: 'b' }]);
    assert.deepEqual(editDiffLines({ old_string: 'a\nb', new_string: 'a' }), [{ kind: 'del', text: 'b' }]);
  });
  it('handles MultiEdit and a JSON string input', () => {
    const r = editDiffLines(JSON.stringify({ edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] }));
    assert.deepEqual(r.map((l: { kind: string }) => l.kind), ['del', 'add', 'gap', 'del', 'add']);
  });
  it('is null for anything that is not an edit', () => {
    assert.equal(editDiffLines({ command: 'ls' }), null);
    assert.equal(editDiffLines('plain text'), null);
    assert.equal(editDiffLines(null), null);
  });
  it('caps a very long change', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n');
    const r = editDiffLines({ old_string: big, new_string: '' });
    assert.equal(r.length, 401);
    assert.equal(r[400].kind, 'gap');
  });
});
