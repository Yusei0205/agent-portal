/**
 * Utilities for filling Jira ticket placeholders in loop-spec goal templates.
 *
 * Supported placeholders:
 *   {{ticket}}           — "KEY (url)" or "KEY"
 *   {{ticket.key}}       — e.g. "PAY-123"
 *   {{ticket.summary}}   — ticket summary / title
 *   {{ticket.title}}     — alias for ticket.summary
 *   {{ticket.url}}       — link to the ticket in Jira
 *   {{ticket.status}}    — status name
 *   {{ticket.description}} — description markdown (if loaded)
 *   {{date}}             — today as YYYY-MM-DD
 */

/** Extract a Jira key from free text or a Jira browse URL. */
export function ticketKeyFrom(text) {
  const m = String(text || '')
    .toUpperCase()
    .match(/(?:BROWSE\/|SELECTEDISSUE=|^|[^A-Z0-9])([A-Z][A-Z0-9_]+-\d+)(?![A-Z0-9])/);
  return m ? m[1] : '';
}

/**
 * Fill {{ticket.*}} (and {{date}}) placeholders from a Jira ticket object.
 *
 * @param {string} goal          — template string with {{…}} placeholders
 * @param {{ key: string, summary?: string, status?: string|{name:string}, url?: string, descriptionMarkdown?: string } | null} ticket
 * @param {string} [jiraSiteUrl] — base URL for building ticket links when ticket.url is absent
 * @returns {string}
 */
export function fillGoalVars(goal, ticket, jiraSiteUrl) {
  const vars = { date: new Date().toISOString().slice(0, 10) };
  if (ticket?.key) {
    const url =
      ticket.url ||
      (jiraSiteUrl
        ? `${String(jiraSiteUrl).replace(/\/$/, '')}/browse/${ticket.key}`
        : '');
    vars.ticket = url ? `${ticket.key} (${url})` : ticket.key;
    vars['ticket.key']         = ticket.key;
    vars['ticket.summary']     = ticket.summary || ticket.key;
    vars['ticket.title']       = ticket.summary || ticket.key;
    vars['ticket.url']         = url || ticket.key;
    vars['ticket.description'] = ticket.descriptionMarkdown || '';
    if (ticket.status) {
      vars['ticket.status'] =
        typeof ticket.status === 'string'
          ? ticket.status
          : ticket.status.name || '';
    }
  }
  return String(goal || '').replace(/\{\{([a-z_.]+)\}\}/g, (m, k) => vars[k] ?? m);
}
