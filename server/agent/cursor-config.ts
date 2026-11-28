/**
 * A person's Cursor setup (Configuration > Cursor): rule files only.
 *
 * Stored under the "cursor" config folder as rules/<name>.mdc|md. Applied to a run by writing them into the run's
 * workspace as .cursor/rules/portal-user-<name>, which the CLI loads (verified: an alwaysApply rule in
 * <cwd>/.cursor/rules is honoured headlessly). Nothing that runs commands or widens permissions is accepted: no
 * mcp.json, cli.json / cli-config.json (permissions), hooks, or commands. Pure module (node:fs/path only): it also
 * runs inside the AgentCore runner image.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface CursorConfigFile { path: string; content: string }

export const CURSOR_CONFIG_PATH = /^rules\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\.(mdc|md)$/;
const MAX_FILE_BYTES = 200_000;
const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 2_000_000;

export function validateCursorFile(file: CursorConfigFile): void {
  if (!CURSOR_CONFIG_PATH.test(file.path) || file.path.includes('..')) {
    throw new Error('Unsupported Cursor setup file. Use rules/<name>.mdc or rules/<name>.md; MCP servers, permissions, hooks and commands cannot be set here.');
  }
  if (Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw new Error('A Cursor rule file may be at most 200 KB.');
}

export function parseCursorFiles(raw: unknown): CursorConfigFile[] {
  if (!Array.isArray(raw) || raw.length > MAX_FILES) throw new Error('Invalid Cursor setup bundle');
  let bytes = 0;
  const seen = new Set<string>();
  return raw.map((file) => {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Invalid Cursor setup file');
    const value = { path: file.path, content: file.content };
    validateCursorFile(value);
    bytes += Buffer.byteLength(value.content);
    if (bytes > MAX_TOTAL_BYTES || seen.has(value.path.toLowerCase())) throw new Error('Oversized or duplicate Cursor setup');
    seen.add(value.path.toLowerCase());
    return value;
  });
}

/** Writes the rules into <workDir>/.cursor/rules. Refuses a link in the way. Returns how many were written. */
export function applyCursorRules(workDir: string, files: CursorConfigFile[]): number {
  const dir = path.join(workDir, '.cursor', 'rules');
  // Each level is checked before anything is created inside it, so a link cannot send the write elsewhere.
  for (const level of [path.join(workDir, '.cursor'), dir]) {
    if (fs.existsSync(level) && fs.lstatSync(level).isSymbolicLink()) throw new Error('Cannot apply Cursor rules: a link is in the way');
    fs.mkdirSync(level, { recursive: true });
  }
  // Rules from an earlier run are replaced, not accumulated.
  for (const name of fs.readdirSync(dir)) if (name.startsWith('portal-user-')) fs.rmSync(path.join(dir, name), { force: true });
  let written = 0;
  for (const file of parseCursorFiles(files)) {
    const target = path.join(dir, 'portal-user-' + path.basename(file.path));
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Cannot apply Cursor rules: a link is in the way');
    fs.writeFileSync(target, file.content, { mode: 0o600 });
    written++;
  }
  return written;
}
