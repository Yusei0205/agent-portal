/**
 * Parse AWS credentials pasted from the IAM Identity Center "Get credentials" dialog.
 *
 * Supports all four formats:
 *   - macOS/Linux:      export AWS_ACCESS_KEY_ID="..."   (quotes optional)
 *   - Windows CMD:      SET AWS_ACCESS_KEY_ID=...        (case-insensitive SET)
 *   - PowerShell:       $Env:AWS_ACCESS_KEY_ID="..."     ($Env case-insensitive)
 *   - Credentials file: [profile]\naws_access_key_id = ...
 *
 * Values may contain `+`, `/`, `=` (e.g. base64-encoded session tokens). Leading /
 * trailing whitespace and CRLF line endings are normalised before parsing.
 * This module never logs or re-emits pasted content.
 *
 * @module awsCredParser
 */

/**
 * Parse an AWS credentials block in any of the four IAM Identity Center formats.
 *
 * @param {string} text  Raw pasted text (may contain CRLF or bare CR).
 * @returns {{ accessKeyId?: string, secretAccessKey?: string, sessionToken?: string, profileName?: string } | null}
 *   Returns null when no recognisable credential keys are found.
 */
export function parseAwsCredentials(text) {
  if (!text || typeof text !== 'string') return null;

  // Normalise line endings.
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let accessKeyId     = undefined;
  let secretAccessKey = undefined;
  let sessionToken    = undefined;
  let profileName     = undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // [profile_name] section header — credentials file format.
    const profileMatch = /^\[([^\]]+)\]$/.exec(line);
    if (profileMatch) {
      profileName = profileMatch[1].trim();
      continue;
    }

    const kv = _extractKeyValue(line);
    if (!kv) continue;

    const upperKey = kv.key.toUpperCase();
    if      (upperKey === 'AWS_ACCESS_KEY_ID')    accessKeyId     = kv.value;
    else if (upperKey === 'AWS_SECRET_ACCESS_KEY') secretAccessKey = kv.value;
    else if (upperKey === 'AWS_SESSION_TOKEN')      sessionToken    = kv.value;
  }

  if (accessKeyId === undefined && secretAccessKey === undefined && sessionToken === undefined) {
    return null;
  }

  return {
    ...(accessKeyId     !== undefined ? { accessKeyId }     : {}),
    ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
    ...(sessionToken    !== undefined ? { sessionToken }    : {}),
    ...(profileName     !== undefined ? { profileName }     : {}),
  };
}

/**
 * Extract a key-value pair from a single credential line.
 *
 * Priority order prevents ambiguous matches:
 *   1. macOS/Linux  `export KEY=value`
 *   2. PowerShell   `$Env:KEY=value`   ($Env is case-insensitive per PS convention)
 *   3. Windows CMD  `SET KEY=value`    (case-insensitive SET keyword)
 *   4. Credentials file  `key = value` or `key=value`
 *
 * Exported with `_` prefix for unit testing; not part of the public API.
 *
 * @param {string} line  Already-trimmed non-empty line.
 * @returns {{ key: string, value: string } | null}
 */
export function _extractKeyValue(line) {
  let m;

  // 1. macOS / Linux: export KEY="value" or export KEY=value
  m = /^export\s+([A-Za-z_]\w*)\s*=\s*(.*)/i.exec(line);
  if (m) return { key: m[1], value: _stripQuotes(m[2]) };

  // 2. PowerShell: $Env:KEY="value"  ($Env, $env, $ENV — all valid)
  m = /^\$[Ee][Nn][Vv]:([A-Za-z_]\w*)\s*=\s*(.*)/.exec(line);
  if (m) return { key: m[1], value: _stripQuotes(m[2]) };

  // 3. Windows CMD: SET KEY=value  (SET, set, Set — case-insensitive)
  m = /^[Ss][Ee][Tt]\s+([A-Za-z_]\w*)\s*=\s*(.*)/.exec(line);
  if (m) return { key: m[1], value: _stripQuotes(m[2]) };

  // 4. Credentials file: aws_access_key_id = value  (spaces around = optional)
  m = /^([A-Za-z_]\w*)\s*=\s*(.*)/.exec(line);
  if (m) return { key: m[1], value: _stripQuotes(m[2]) };

  return null;
}

/**
 * Remove a single surrounding pair of matching double or single quotes, then trim.
 *
 * Examples:
 *   `"abc=="` → `abc==`   (base64 padding preserved)
 *   `abc==`   → `abc==`   (no quotes → unchanged)
 *   `'abc'`   → `abc`
 *
 * Exported for unit testing; not part of the public API.
 *
 * @param {string} raw
 * @returns {string}
 */
export function _stripQuotes(raw) {
  const s = raw.trim();
  if (s.length >= 2) {
    const f = s[0];
    const l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}
