/**
 * Links that come from outside the page (a Jira or pull request address, a sign-in link) are only followed when they
 * are web addresses. A javascript: or data: address would run script or show content from whoever supplied it.
 *
 * @param {unknown} url
 * @returns {string | undefined} the address when it is http(s), a site path or an in-page anchor; otherwise undefined
 */
export function safeUrl(url) {
  if (typeof url !== 'string') return undefined;
  const v = url.trim();
  if (!v) return undefined;
  if (v.startsWith('#') || (v.startsWith('/') && !v.startsWith('//'))) return v;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : undefined;
  } catch {
    return undefined;
  }
}
