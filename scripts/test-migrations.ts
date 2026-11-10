import { openDb, closeDb } from '../server/db.ts';

try {
  console.log('Opening in-memory DB...');
  openDb(':memory:');
  console.log('SUCCESS: All migrations applied');
  closeDb();
} catch(e) {
  const err = e as Error;
  console.error('FAILED:', err.message);
}
