import { scrubSecrets } from '../pull-requests.ts';

/** Redact credentials from CI output and keep the last `maxChars` characters (the tail holds the failure). */
export function scrubEvidence(text: string, maxChars = 8000): string {
  const clean = scrubSecrets(text).replace(
    /\b([A-Za-z0-9_]*(?:_SECRET|_TOKEN))(\s*[=:]\s*)["']?[0-9a-fA-F]{40,}["']?/g,
    '$1$2***',
  );
  const chars = Array.from(clean);
  return chars.length <= maxChars ? clean : chars.slice(chars.length - maxChars).join('');
}
