import { extractJson } from './util.ts';
import type { Finding, Severity } from './agent/heuristics.ts';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Reject incomplete reports instead of turning parsing failures into clean reviews. */
export function parseReviewResult(text: string, files: Set<string>): { summary: string; findings: Finding[] } {
  const parsed = extractJson<{ summary?: unknown; findings?: unknown }>(text);
  if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.findings)) {
    throw new Error('The reviewer returned an invalid report. Open the reviewer run for its full output and start a new review.');
  }
  const findings = parsed.findings.map((raw: unknown, index: number): Finding => {
    const f = raw as Record<string, unknown> | null;
    const file = typeof f?.file === 'string' ? f.file.replace(/^[ab]\//, '') : '';
    if (!f || !files.has(file) || !SEVERITIES.includes(f.severity as Severity) ||
        typeof f.message !== 'string' || !f.message.trim() ||
        typeof f.category !== 'string' || !f.category.trim() ||
        (f.suggestion != null && typeof f.suggestion !== 'string') ||
        (f.line != null && (!Number.isInteger(f.line) || Number(f.line) <= 0))) {
      throw new Error(`The reviewer returned an invalid finding (${index + 1}). Open the reviewer run for its full output and start a new review.`);
    }
    return { file, line: f.line == null ? null : Number(f.line), severity: f.severity as Severity,
      category: f.category, message: f.message, suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined };
  });
  return { summary: parsed.summary, findings };
}
