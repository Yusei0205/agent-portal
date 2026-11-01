/**
 * cURL command formatter for API test cases.
 *
 * Produces valid cURL that Postman can import via Import > Raw text.
 * Uses POSIX single-quote escaping so all characters are safe on Unix/macOS/Linux.
 * Windows users can paste into Git Bash or WSL.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RequestObj {
  method?: string | null;
  url: string;
  headers?: Record<string, string> | null;
  body?: string | object | null;
}

export interface ResponseObj {
  status?: number | null;
  headers?: Record<string, string> | null;
  body?: string | object | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wrap a string in single quotes and escape any embedded single quotes
 * using the POSIX trick:  '  →  '\''
 * This produces valid shell single-quoting for use in cURL commands.
 */
export function shellEscapeSingle(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Format a request object as a multi-line cURL command.
 *
 * Rules:
 *  - -X is omitted for GET (default).
 *  - Each -H header is on its own continuation line.
 *  - Body is passed with --data-raw to prevent @-file interpretation.
 *  - All string values are POSIX single-quote-escaped.
 */
export function formatAsCurl(req: RequestObj): string {
  const method = (req.method ?? 'GET').toUpperCase().trim();
  const url = req.url;
  const headers = req.headers ?? {};
  const body = req.body;

  const parts: string[] = ['curl'];

  if (method !== 'GET') {
    parts.push(`-X ${shellEscapeSingle(method)}`);
  }

  for (const [name, value] of Object.entries(headers)) {
    if (typeof name === 'string' && typeof value === 'string') {
      parts.push(`-H ${shellEscapeSingle(`${name}: ${value}`)}`);
    }
  }

  if (body !== null && body !== undefined) {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    parts.push(`--data-raw ${shellEscapeSingle(bodyStr)}`);
  }

  parts.push(shellEscapeSingle(url));

  return parts.join(' \\\n  ');
}

/**
 * Format a response object as a human-readable string suitable for the Excel
 * Response column:  "HTTP <status>\n<pretty-printed body>"
 */
export function formatResponseText(res: ResponseObj | null): string {
  if (!res) return '';
  const lines: string[] = [];
  if (res.status != null) lines.push(`HTTP ${res.status}`);
  if (res.body !== null && res.body !== undefined) {
    lines.push(
      typeof res.body === 'string'
        ? res.body
        : JSON.stringify(res.body, null, 2),
    );
  }
  return lines.join('\n');
}
