import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPassages, rankPassages, excerptAround, queryTerms, buildAskUser, citedNumbers } from '../server/knowledge-answer.ts';

const md = [
  '# Handbook', '', 'Welcome to the team.', '',
  '## Expense claims', '', 'Submit claims within 30 days using the finance portal. Receipts are required for amounts above 50 dollars.', '',
  '## Leave', '', 'Annual leave is requested from your manager at least two weeks ahead.',
].join('\n');

describe('knowledge passages', () => {
  test('passages keep the heading they sit under', () => {
    const p = splitPassages('d1', 'Handbook.md', md);
    assert.ok(p.some((x) => x.heading === 'Expense claims' && x.text.includes('finance portal')));
  });
  test('the passage that uses the question words ranks first', () => {
    const top = rankPassages(splitPassages('d1', 'Handbook.md', md), 'How do I submit expense claims?', 3);
    assert.equal(top[0].heading, 'Expense claims');
  });
  test('a passage with none of the words is left out', () => {
    assert.deepEqual(rankPassages(splitPassages('d1', 'H', md), 'quantum blockchain', 3), []);
  });
  test('question words drop filler and punctuation', () => {
    assert.deepEqual(queryTerms('What is the leave policy?'), ['leave', 'policy']);
  });
  test('the excerpt starts near the matching word', () => {
    const long = `${'filler words here '.repeat(30)}the receipts rule is strict ${'more text '.repeat(30)}`;
    assert.ok(excerptAround(long, 'receipts rule').includes('receipts rule'));
  });
  test('the prompt numbers the passages and the answer\'s citations are read back', () => {
    const passages = splitPassages('d1', 'Handbook.md', md).slice(0, 2);
    const u = buildAskUser('q?', passages);
    assert.ok(u.includes('[1] Handbook.md') && u.includes('[2]'));
    assert.deepEqual(citedNumbers('Claims are due in 30 days [2]. See also [1][2] and [9].', 2), [2, 1]);
  });
});

import { kbMetadata, projectFilter } from '../server/knowledge-kb.ts';
describe('Knowledge Base project label', () => {
  test('each copy is labelled with its project, and the search asks for that label only', () => {
    assert.deepEqual(JSON.parse(kbMetadata('p-1')), { metadataAttributes: { projectId: 'p-1' } });
    assert.deepEqual(projectFilter('p-1'), { equals: { key: 'projectId', value: 'p-1' } });
  });
});
