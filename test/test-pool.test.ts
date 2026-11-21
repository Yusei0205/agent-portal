import { it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error pure JavaScript CI helper has no declaration file
import { runTestPool } from '../scripts/test-pool.mjs';

it('runs duplicate files once, bounds concurrency and preserves failed results for every owning module', async () => {
  let active = 0, maximum = 0;
  const calls: string[] = [];
  const results = await runTestPool(['a', 'b', 'a', 'c', 'b'], async (file: string) => {
    calls.push(file); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return { ok: file !== 'b', failures: file === 'b' ? ['fixture failure'] : [] };
  }, 2);
  assert.equal(maximum, 2); assert.deepEqual(calls.sort(), ['a', 'b', 'c']);
  assert.equal(results.get('b').ok, false); assert.deepEqual(results.get('b').failures, ['fixture failure']);
  assert.equal(results.size, 3);
});

it('rejects invalid concurrency and worker crashes instead of reporting success', async () => {
  for (const value of [0, -1, 1.5, NaN, 17]) await assert.rejects(runTestPool(['a'], async () => true, value), /TEST_CONCURRENCY/);
  await assert.rejects(runTestPool(['a'], async () => { throw new Error('worker crashed'); }, 1), /worker crashed/);
  assert.equal((await runTestPool([], async () => { throw new Error('must not run'); }, 2)).size, 0);
});
