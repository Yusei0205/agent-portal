/**
 * Reads the AWS keys out of whatever the AWS access portal copied ("Command line or programmatic access"):
 * `export AWS_ACCESS_KEY_ID="…"` lines (macOS / Linux), `set` or `$Env:` lines (Windows), or the
 * `[profile]` / `aws_access_key_id = …` block for ~/.aws/credentials. Returns only the fields it found.
 */
const FIELDS = [
  ['accessKeyId', 'aws_access_key_id'],
  ['secretAccessKey', 'aws_secret_access_key'],
  ['sessionToken', 'aws_session_token'],
  ['region', '(?:aws_(?:default_)?)?region'],
];

export function parseAwsPaste(text) {
  const out = {};
  const src = String(text || '');
  for (const [field, name] of FIELDS) {
    const m = new RegExp(`(?:^|[\\s$])(?:env:)?${name}\\s*=\\s*["']?([^"'\\s]+)`, 'im').exec(src);
    if (m) out[field] = m[1];
  }
  return out;
}
