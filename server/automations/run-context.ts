import { badRequest } from '../util.ts';
import { saveChatAttachments, type ChatAttachment } from '../session-attachments.ts';
import { attachmentLimits } from '../agent/input-file-urls.ts';
import { INPUT_FILE_LIMITS } from '../agent/runner-files.ts';
import { jiraTicket } from './engine.ts';

export interface AutomationRunContext {
  attachments: Array<ChatAttachment & { source: 'upload' | 'jira' }>;
  jira?: { key: string; text: string };
  warnings: string[];
}

/** URLs identify an issue only; content is always fetched through this project's configured Jira connection. */
export function parseRunJiraIssue(value: string): string {
  let key = value.trim();
  if (!key) return '';
  if (/^https?:\/\//i.test(key)) {
    let url: URL;
    try { url = new URL(key); } catch { throw badRequest('Enter a Jira issue key or issue URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw badRequest('Use a HTTPS Jira issue URL or an issue key');
    key = url.pathname.match(/^\/browse\/([A-Za-z][A-Za-z0-9_]{1,19}-\d{1,9})\/?$/)?.[1] || '';
  }
  key = key.toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/.test(key)) throw badRequest('Enter one Jira issue key (for example ABC-123) or its /browse/ URL');
  return key;
}

/** Snapshot accepted files before dispatch; they survive upload cleanup and are staged on every agent step. */
export async function prepareAutomationContext(projectId: string, sessionId: string, attachmentIds: unknown, jiraIssue: string): Promise<AutomationRunContext> {
  const key = parseRunJiraIssue(jiraIssue);
  const uploaded = await saveChatAttachments(projectId, sessionId, attachmentIds);
  const context: AutomationRunContext = { attachments: uploaded.map((file) => ({ ...file, source: 'upload' })), warnings: [] };
  if (!key) return context;
  const ticket = await jiraTicket(projectId, sessionId, key);
  if (!ticket.loaded) throw badRequest(`Jira context could not be loaded. ${ticket.text}`);
  context.jira = { key, text: ticket.text };
  const limits = attachmentLimits();
  let bytes = uploaded.reduce((sum, file) => sum + file.size, 0);
  for (const file of ticket.attachments) {
    if (context.attachments.length >= INPUT_FILE_LIMITS.files || bytes + file.size > limits.totalBytes) {
      context.warnings.push(`Jira attachment ${JSON.stringify(file.name)} was not included because the combined run file limit was reached.`);
    } else { context.attachments.push({ ...file, source: 'jira' }); bytes += file.size; }
  }
  return context;
}
