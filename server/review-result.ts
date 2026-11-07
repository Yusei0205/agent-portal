import type { Finding } from './review.ts';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

/** Preserve complete reports. Reject malformed entries rather than silently dropping findings. */
export function normalizeReviewFindings(raw: unknown[]): Array<Partial<Finding>> {
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Invalid finding ${index + 1}`);
    const f = item as Record<string, unknown>;
    const body = f.body ?? f.description ?? f.message;
    const file = f.file ?? f.file_path ?? f.path ?? '';
    const severity = f.severity == null ? 'medium' : String(f.severity).toLowerCase().trim();
    const line = f.line ?? f.line_number;
    if (typeof body !== 'string' || !body.trim() || typeof file !== 'string'
      || !SEVERITIES.includes(severity)
      || (line != null && (!Number.isInteger(Number(line)) || Number(line) <= 0))
      || (f.suggestion != null && typeof f.suggestion !== 'string')) throw new Error(`Invalid finding ${index + 1}`);
    return {
      file_path: file.trim().replace(/^[ab]\//, ''),
      line_number: line == null ? null : Number(line),
      severity: severity as Finding['severity'],
      title: String(f.title ?? f.message ?? f.category ?? 'Finding').slice(0, 200),
      body: body + (f.suggestion ? `\n\nSuggested fix:\n${f.suggestion}` : ''),
      confidence: f.confidence != null && Number.isFinite(Number(f.confidence)) ? Math.min(1, Math.max(0, Number(f.confidence))) : null,
    };
  });
}
