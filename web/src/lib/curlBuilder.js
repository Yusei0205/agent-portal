/**
 * curlBuilder.js — builds a cURL command from a request object.
 * Pure utility; no React imports. Suitable for unit-testing in Node.js.
 */

/**
 * Shell-quotes a string for POSIX shells using single-quote escaping.
 * Single quotes inside the value are handled by closing the single-quoted
 * segment, emitting the character as a double-quoted literal, then
 * re-opening the single-quoted segment:
 *   foo'bar  →  'foo'"'"'bar'
 *
 * @param {string} s
 * @returns {string}
 */
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Builds a cURL command from a request object. The output is compatible with
 * Postman's "Import > Raw text" import (which accepts raw cURL text).
 *
 * Format:
 *   curl -X <METHOD> \
 *     -H '<Name: value>' \        (one flag per header)
 *     --data-raw '<body>' \       (non-GET/HEAD with a body only)
 *     '<url>'
 *
 * @param {{ method?: string, url: string, headers?: Record<string,string>|null, body?: string|object|null }|null} req
 * @returns {string}  empty string when req is null or has no url
 */
export function buildCurl(req) {
  if (!req || !req.url) return '';

  const method = (req.method || 'GET').toUpperCase();
  const lines = [`curl -X ${method}`];

  if (req.headers && typeof req.headers === 'object') {
    for (const [name, value] of Object.entries(req.headers)) {
      lines.push(`  -H ${shellQuote(`${name}: ${String(value)}`)}`);
    }
  }

  // Omit body for GET and HEAD — it would be ignored by most servers.
  if (req.body != null && method !== 'GET' && method !== 'HEAD') {
    const bodyStr =
      typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    lines.push(`  --data-raw ${shellQuote(bodyStr)}`);
  }

  // When there are no headers or body, put the URL on the same line for a clean single-line output.
  // When there are extra flags, put the URL on its own indented continuation line.
  const quotedUrl = shellQuote(req.url);
  if (lines.length === 1) {
    return `${lines[0]} ${quotedUrl}`;
  }
  lines.push(`  ${quotedUrl}`);
  return lines.join(' \\\n');
}

/**
 * Returns a pretty-printed JSON string from a request or response body.
 * - Object → serialised with 2-space indent.
 * - JSON string → parsed and re-serialised with indent.
 * - Non-JSON string → returned as-is.
 * - Missing / null body → returns null.
 *
 * @param {{ body?: string|object|null }|null} item
 * @returns {string|null}
 */
export function prettyBody(item) {
  if (!item || item.body == null) return null;
  if (typeof item.body === 'object') return JSON.stringify(item.body, null, 2);
  try {
    return JSON.stringify(JSON.parse(item.body), null, 2);
  } catch {
    return item.body;
  }
}
