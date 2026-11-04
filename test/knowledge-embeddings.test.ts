import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, setConfig } from '../server/config.ts';
import { setEmbedOverride, indexDocument, searchEmbeddings, countIndexed, forgetEmbeddings, vecPath } from '../server/knowledge-embeddings.ts';

// A stand-in for the embedding model: texts about the same idea get the same direction.
const CONCEPTS = [['leave', 'vacation', 'holiday', 'time off', 'pto'], ['expense', 'claim', 'receipt', 'reimburse'], ['password', 'login', 'sign in']];
const fake = async (texts: string[]): Promise<number[][]> => texts.map((t) => {
  const low = t.toLowerCase();
  const v = CONCEPTS.map((words) => (words.some((w) => low.includes(w)) ? 1 : 0));
  v.push(0.01); // never an all-zero vector
  return v;
});

const md = [
  '# Handbook', '', '## Annual leave', '', 'Staff may take vacation after probation. Request it from your manager two weeks ahead.', '',
  '## Expenses', '', 'Submit a claim with receipts to be reimbursed within 30 days.', '',
  '## Accounts', '', 'Reset your password from the sign in page.',
].join('\n');

describe('meaning-based index', () => {
  let tmp = '';
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-emb-'));
    process.env.DATA_DIR = tmp;
    setConfig(await loadConfig());
    setEmbedOverride(fake);
  });
  after(() => { setEmbedOverride(null); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('a question finds the passage that means the same, without sharing its words', async () => {
    const n = await indexDocument('proj', 'd1', 'Handbook.md', md);
    assert.ok(n >= 3);
    const top = await searchEmbeddings('proj', [{ docId: 'd1', name: 'Handbook.md' }], 'How much time off do I get?', 3);
    assert.equal(top[0].heading, 'Annual leave');
    const top2 = await searchEmbeddings('proj', [{ docId: 'd1', name: 'Handbook.md' }], 'reimburse my costs', 3);
    assert.equal(top2[0].heading, 'Expenses');
  });

  test('indexed documents are counted, and removing one is forgotten', async () => {
    assert.equal(await countIndexed('proj', ['d1', 'nope']), 1);
    await forgetEmbeddings('proj', 'd1');
    assert.equal(fs.existsSync(vecPath('proj', 'd1')), false);
    assert.equal(await countIndexed('proj', ['d1']), 0);
  });

  test('a document that is not indexed is skipped, not an error', async () => {
    assert.deepEqual(await searchEmbeddings('proj', [{ docId: 'ghost', name: 'x' }], 'anything', 3), []);
  });
});
