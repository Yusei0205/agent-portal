/**
 * Where a session's files go in the project Vault: "Sessions/<title> (<first 8 of the id>)". The files the agent wrote go in that
 * folder, and the files the person uploaded in the chat go in its "User uploads" folder.
 */

export const USER_UPLOADS_FOLDER = 'User uploads';

export function sessionVaultFolder(wf: { id: string; title?: string | null; goal?: string | null }): string {
  const raw = String(wf.title || wf.goal || '').trim();
  const sanitised = raw
    .replace(/[^\w\s.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `Sessions/${sanitised || 'Session'} (${wf.id.slice(0, 8)})`;
}
