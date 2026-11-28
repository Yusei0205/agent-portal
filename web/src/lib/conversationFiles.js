/** Local links belong to the session workspace, never the static website bucket. */
export function conversationFileLink(href, files = []) {
  if (!href || href.startsWith('#') || /^(?:https?:|mailto:|tel:|\/\/)/i.test(href)) return null;
  let value;
  try { value = decodeURIComponent(href); } catch { return null; }
  value = value.replace(/^sandbox:/i, '').replace(/\\/g, '/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:\//i.test(value)) return null;
  const location = value.match(/(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)(?:-L?\d+)?$/);
  if (location) value = value.slice(0, location.index);
  const line = location ? Number(location[1] || location[2]) : null;
  if (value.startsWith('/api/') || value.includes('?')) return null;
  const clean = value.replace(/^\.\//, '').replace(/^\/+/, '');
  if (!clean || clean.split('/').includes('..')) return null;
  const exactMatches = files.filter(f => f.path === clean || f.path.endsWith('/' + clean));
  const exact = exactMatches.length === 1 ? exactMatches[0] : null;
  const suffix = files.filter(f => clean.endsWith('/' + f.path));
  const file = exact ?? (exactMatches.length === 0 && suffix.length === 1 ? suffix[0] : null);
  // An ambiguous basename must not open a different deliverable.
  if (file) return { file, path: file.path, line };
  const repoIndex = clean.indexOf('repos/');
  const path = repoIndex >= 0 ? clean.slice(repoIndex) : clean;
  if (!/\.[a-z0-9]+$/i.test(path)) return null;
  return { path, line };
}

export function linkConversationFiles(container, files) {
  for (const anchor of container.querySelectorAll('a[href], button[data-conversation-href]')) {
    const href = anchor.getAttribute('href') ?? anchor.dataset.conversationHref;
    const link = conversationFileLink(href, files);
    if (!link) continue;
    const button = container.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'output-file-link';
    button.dataset.conversationHref = href;
    button.textContent = anchor.textContent;
    if (link.file) button.dataset.outputFileId = link.file.id;
    else button.dataset.workspaceFilePath = link.path;
    if (link.line) button.dataset.fileLine = String(link.line);
    button.title = `Open ${link.path}${link.line ? ':' + link.line : ''}`;
    anchor.replaceWith(button);
  }
}

/** Resolve repository-relative review links through authenticated, read-only IDE APIs. */
export async function resolveConversationPath(api, workflowId, path) {
  const base = `/api/workflows/${encodeURIComponent(workflowId)}/ide`;
  const read = candidate => api.get(`${base}/file?scope=work&path=${encodeURIComponent(candidate)}`);
  try { await read(path); return path; } catch (error) { if (error.status !== 404) throw error; }
  if (path.startsWith('repos/')) throw new Error('This file is no longer available in the session working copy.');
  const tree = await api.get(`${base}/tree?scope=work&path=repos`);
  const matches = [];
  for (const entry of tree.entries ?? []) {
    if (entry.type !== 'directory') continue;
    const candidate = `repos/${entry.name}/${path}`;
    try { await read(candidate); matches.push(candidate); } catch (error) { if (error.status !== 404) throw error; }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error('This path exists in several repositories. Choose the repository in Explorer.');
  throw new Error('This file is no longer available in the session working copy.');
}
