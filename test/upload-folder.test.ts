/** Folder uploads in the session explorer: which files are sent, to which folder, and what is left out. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { dirOf, planFolderUpload, skippedNote, runLimited, MAX_FOLDER_FILES } from '../web/src/lib/upload-folder.js';

const f = (name: string, size = 10) => ({ name, size });

describe('upload-folder', () => {
  it('dirOf gives the folder part of a relative path', () => {
    assert.equal(dirOf('proj/src/a.ts'), 'proj/src');
    assert.equal(dirOf('a.ts'), '');
    assert.equal(dirOf('/proj/a.ts'), 'proj');
    assert.equal(dirOf('proj\\win\\b.txt'), 'proj/win');
  });

  it('keeps each file in its folder and skips dependency, version-control and system files', () => {
    const plan = planFolderUpload([
      { file: f('a.ts'), relPath: 'proj/src/a.ts' },
      { file: f('README.md'), relPath: 'proj/README.md' },
      { file: f('index.js'), relPath: 'proj/node_modules/x/index.js' },
      { file: f('HEAD'), relPath: 'proj/.git/HEAD' },
      { file: f('.DS_Store'), relPath: 'proj/.DS_Store' },
      { file: null, relPath: 'proj/node_modules/' },
    ]);
    assert.deepEqual(plan.items.map((i: { file: { name: string }; dir: string }) => [i.file.name, i.dir]), [['a.ts', 'proj/src'], ['README.md', 'proj']]);
    assert.equal(plan.skipped, 4);
    assert.match(skippedNote(plan), /4 files in dependency, version-control or system folders/);
  });

  it('leaves out files over 50 MB and anything past the first 1,000 files, and says so', () => {
    const many = Array.from({ length: MAX_FOLDER_FILES + 5 }, (_, i) => ({ file: f(`f${i}.txt`), relPath: `big/f${i}.txt` }));
    many.push({ file: f('huge.bin', 51 * 1024 * 1024), relPath: 'big/huge.bin' });
    const plan = planFolderUpload(many);
    assert.equal(plan.items.length, MAX_FOLDER_FILES);
    assert.equal(plan.overLimit, 5);
    assert.deepEqual(plan.tooBig, ['big/huge.bin']);
    const note = skippedNote(plan);
    assert.match(note, /1 over 50 MB \(big\/huge\.bin\)/);
    assert.match(note, /5 past the first 1000 files/);
    assert.equal(skippedNote(planFolderUpload([{ file: f('a'), relPath: 'a' }])), '');
  });

  it('runLimited runs every task with at most N at once and collects errors', async () => {
    let running = 0; let peak = 0; const seen: number[] = []; const counts: number[] = [];
    const errors = await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n: number) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--; seen.push(n);
      if (n === 4) throw new Error('four failed');
    }, (d: number) => counts.push(d));
    assert.equal(peak, 3);
    assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(errors, ['four failed']);
    assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(await runLimited([], 3, async () => {}), []);
  });
});
