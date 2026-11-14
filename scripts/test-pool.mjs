/** Run each test file once, preserving process isolation and bounded concurrency. */
export async function runTestPool(files, runFile, concurrency = 1) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error('TEST_CONCURRENCY must be an integer between 1 and 16');
  }
  const unique = [...new Set(files)];
  const results = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (next < unique.length) {
      const file = unique[next++];
      results.set(file, await runFile(file));
    }
  }));
  return results;
}
