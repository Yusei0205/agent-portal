/**
 * Secrets that one agent run was handed (for example a test account's password) and must never be stored or shown.
 *
 * A session's prompt keeps only a placeholder; the real value is put in when the run starts and registered here, and
 * every event of that run is passed through `maskRunSecrets` before it is saved or streamed, so a password an agent
 * types or repeats shows as the mask in the transcript.
 */

const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022';
const MIN_LENGTH = 3;
const byRun = new Map<string, string[]>();

/** Placeholder written into a stored prompt: {{password:<testProjectId>:<url-encoded login name>}} */
export const PASSWORD_PLACEHOLDER = /\{\{password:([^:}]+):([^}]+)\}\}/g;

export function passwordPlaceholder(testProjectId: string, loginName: string): string {
  return `{{password:${testProjectId}:${encodeURIComponent(loginName)}}}`;
}

export function setRunSecrets(runId: string, values: string[]): void {
  const list = [...new Set(values.filter((v) => v.length >= MIN_LENGTH))].sort((a, b) => b.length - a.length);
  if (!list.length) return;
  if (byRun.size > 200) byRun.delete(byRun.keys().next().value as string);
  byRun.set(runId, list);
}

export function clearRunSecrets(runId: string): void {
  byRun.delete(runId);
}

/** Replace every registered secret of the run in a string (also JSON-escaped forms, since events are JSON). */
export function maskRunSecrets(runId: string, text: string): string {
  const list = byRun.get(runId);
  if (!list || !text) return text;
  let out = text;
  for (const v of list) {
    out = out.split(v).join(MASK);
    const esc = JSON.stringify(v).slice(1, -1);
    if (esc !== v) out = out.split(esc).join(MASK);
  }
  return out;
}
