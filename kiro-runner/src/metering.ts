/**
 * Kiro bills in credits, and kiro-cli reports them in its own `_kiro.dev/metadata` notification (not in the standard ACP
 * `usage_update`, which it never sends):
 *
 *   { sessionId, contextUsagePercentage, turnDurationMs,
 *     meteringUsage: [{ value: 0.018, unit: "credit", unitPlural: "credits" }, ...] }
 *
 * `meteringUsage` lists one entry per model call of the turn, so the turn's credits are their sum. Frames sent while the turn is going
 * carry only `contextUsagePercentage`. The latest frame that has entries is the turn's running total (the caller assigns it, it does
 * not add it to what an earlier frame said).
 *
 * The portal has the same function for the local (non-AgentCore) path in server/agent/kiro.ts (`meteredCredits`); keep them alike.
 */
export function creditsFromMetadata(params: unknown): number | null {
  const entries = (params as { meteringUsage?: unknown } | null | undefined)?.meteringUsage;
  if (!Array.isArray(entries)) return null;
  let total = 0;
  let any = false;
  for (const e of entries) {
    const o = e as { value?: unknown; unit?: unknown; unitPlural?: unknown } | null;
    if (!o || typeof o !== 'object') continue;
    // Only credits: another unit must not be added to them.
    const isCredit = o.unitPlural === 'credits' || o.unit === 'credit';
    const value = Number(o.value);
    if (!isCredit || !Number.isFinite(value) || value < 0) continue;
    total += value;
    any = true;
  }
  return any ? total : null;
}
