import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id TEXT PRIMARY KEY,
      quiz_id TEXT NOT NULL,
      score INTEGER,
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS qi ON quiz_attempts(quiz_id, completed_at);
  `);
  console.log('M10 subset OK');
} catch(e) {
  console.error('M10 failed:', e.message);
}
