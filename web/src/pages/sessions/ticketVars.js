
/** Start a session, a single run or a documentation run. */
/** A Jira key (RLP-2884) from what was typed: the key itself or any link to the ticket. */
export function ticketKeyFrom(text) {
  const m = String(text || '').toUpperCase().match(/(?:BROWSE\/|SELECTEDISSUE=|^|[^A-Z0-9])([A-Z][A-Z0-9_]+-\d+)(?![A-Z0-9])/);
  return m ? m[1] : '';
}

/** Fill a loop spec's {{ticket}} (and older {{ticket.*}}) and {{date}} placeholders from the chosen Jira ticket. */
export function fillGoalVars(goal, ticket, jiraSite) {
  const vars = { date: new Date().toISOString().slice(0, 10) };
  if (ticket?.key) {
    const url = ticket.url || (jiraSite ? `${String(jiraSite).replace(/\/$/, '')}/browse/${ticket.key}` : '');
    vars.ticket = url ? `${ticket.key} (${url})` : ticket.key;
    vars['ticket.key'] = ticket.key;
    vars['ticket.summary'] = ticket.summary || ticket.key;
    vars['ticket.url'] = url || ticket.key;
    if (ticket.status) vars['ticket.status'] = typeof ticket.status === 'string' ? ticket.status : ticket.status.name || '';
  }
  return String(goal || '').replace(/\{\{([a-z_.]+)\}\}/g, (m, k) => vars[k] ?? m);
}
