import { DatabaseSync } from 'node:sqlite';

// Test each migration individually to find which specific SQL fails
const M10 = `
  CREATE TABLE IF NOT EXISTS budget_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    project_id TEXT,
    workflow_id TEXT,
    run_id TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    provider TEXT,
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS budget_usage_project ON budget_usage(project_id, created_at);
  CREATE INDEX IF NOT EXISTS budget_usage_user ON budget_usage(user_id, created_at);

  CREATE TABLE IF NOT EXISTS learn_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    audience TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    published INTEGER NOT NULL DEFAULT 0,
    stale INTEGER NOT NULL DEFAULT 0,
    workflow_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS learn_docs_project ON learn_docs(project_id, created_at);

  CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    learn_doc_id TEXT,
    title TEXT NOT NULL,
    questions_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS quizzes_project ON quizzes(project_id, created_at);
  CREATE INDEX IF NOT EXISTS quizzes_doc ON quizzes(learn_doc_id);

  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id TEXT PRIMARY KEY,
    quiz_id TEXT NOT NULL,
    user_id TEXT,
    answers_json TEXT NOT NULL DEFAULT '[]',
    results_json TEXT NOT NULL DEFAULT '[]',
    score INTEGER,
    total INTEGER,
    completed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS quiz_attempts_quiz ON quiz_attempts(quiz_id, completed_at);
  CREATE INDEX IF NOT EXISTS quiz_attempts_user ON quiz_attempts(user_id, completed_at);

  CREATE TABLE IF NOT EXISTS doc_reads (
    learn_doc_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (learn_doc_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS paths (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'everyone',
    description TEXT,
    steps TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS paths_project ON paths(project_id);
`;

console.log('Test 1: M10 subset (no FK) in single exec...');
try {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(M10);
  db.close();
  console.log('PASS');
} catch(e) {
  const err = e as Error;
  console.error('FAIL:', err.message);
}

console.log('Test 2: M10 statements individually...');
const stmts = M10.split(';').map(s => s.trim()).filter(s => s.length > 0);
const db2 = new DatabaseSync(':memory:');
db2.exec('PRAGMA foreign_keys = ON;');
for (const stmt of stmts) {
  try {
    db2.exec(stmt + ';');
  } catch(e) {
    const err = e as Error;
    console.error('FAIL at stmt:', stmt.slice(0, 60), '...');
    console.error('Error:', err.message);
  }
}
db2.close();
console.log('Done');
