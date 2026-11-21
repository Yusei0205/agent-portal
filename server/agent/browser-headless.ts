/**
 * browser-headless.ts — Playwright MCP rewrite utilities.
 *
 * The user's ~/.kiro/settings/mcp.json (or ~/.claude/settings.json) may contain
 * a Playwright MCP server that opens a visible Chrome window.  These utilities
 * rewrite matching entries in the per-run materialised copy:
 *
 *   rewritePlaywrightMcpHeadless  — add --headless (fallback when no live browser)
 *   rewritePlaywrightMcpCdp       — use --cdp-endpoint (live portal browser)
 *   hasPlaywrightMcpEntry         — detect whether a Playwright entry is present
 *
 * The user's source config is never modified — only the per-run copy.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

// ── Detection ─────────────────────────────────────────────────────────────────

/** True when the entry's command/args reference the @playwright/mcp package. */
function isPlaywrightEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const args = Array.isArray(e.args) ? (e.args as unknown[]).map(String) : [];
  const cmd = String(e.command ?? '');
  return (
    args.some((a) => a.includes('@playwright/mcp')) ||
    cmd.includes('@playwright/mcp')
  );
}

// ── Rewriter ─────────────────────────────────────────────────────────────────

/**
 * Rewrite any Playwright MCP server entries in `mcpJsonPath` to run headless
 * with screenshots directed to `<workDir>/.browser/`.
 *
 * Idempotent — already-headless entries are left unchanged.
 * Non-fatal — any read/parse/write error is silently ignored so the run
 * can proceed even if the rewrite fails.
 *
 * @param mcpJsonPath  Absolute path to the mcp.json to patch (materialised copy).
 * @param workDir      The run's working directory; browser output goes here.
 */
export async function rewritePlaywrightMcpHeadless(
  mcpJsonPath: string,
  workDir: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await fsp.readFile(mcpJsonPath, 'utf8');
  } catch {
    return; // file not present — nothing to do
  }

  let cfg: { mcpServers?: Record<string, unknown> };
  try {
    cfg = JSON.parse(raw) as typeof cfg;
  } catch {
    return; // invalid JSON — don't corrupt it
  }

  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') return;

  const servers = cfg.mcpServers;
  let modified = false;

  for (const [name, entry] of Object.entries(servers)) {
    if (!isPlaywrightEntry(entry)) continue;
    const e = entry as Record<string, unknown>;
    const args = Array.isArray(e.args) ? (e.args as unknown[]).map(String) : [];

    if (args.includes('--headless')) continue; // already headless — skip

    const browserDir = path.join(workDir, '.browser');

    // Append headless flags; preserve all existing args
    const newArgs = [
      ...args,
      '--headless',
      '--output-dir', browserDir,
    ];
    // Isolated profile so concurrent sessions don't share browser state
    if (!newArgs.some((a) => a === '--isolated' || a.startsWith('--isolated-'))) {
      newArgs.push('--isolated');
    }

    servers[name] = { ...e, args: newArgs };
    modified = true;
  }

  if (!modified) return;

  try {
    await fsp.mkdir(path.join(workDir, '.browser'), { recursive: true });
    await fsp.writeFile(mcpJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

// ── CDP endpoint rewrite ──────────────────────────────────────────────────────

/**
 * Return true if `mcpJsonPath` contains at least one Playwright MCP entry.
 * Non-fatal: returns false on any read/parse error.
 */
export async function hasPlaywrightMcpEntry(mcpJsonPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fsp.readFile(mcpJsonPath, 'utf8');
  } catch {
    return false;
  }
  let cfg: { mcpServers?: Record<string, unknown> };
  try {
    cfg = JSON.parse(raw) as typeof cfg;
  } catch {
    return false;
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') return false;
  return Object.values(cfg.mcpServers).some(isPlaywrightEntry);
}

/**
 * Rewrite any Playwright MCP server entries in `mcpJsonPath` to connect to the
 * portal-managed live browser via `--cdp-endpoint <cdpEndpoint>`.
 *
 * Removes any existing `--headless` / `--isolated` flags (not needed when
 * connecting to an existing browser) and ensures `--output-dir` is set so
 * screenshots are saved inside the session work dir.
 *
 * Returns true if at least one entry was rewritten, false if none matched.
 * Non-fatal — any read/parse/write error causes a false return so the caller
 * can fall back to the headless rewrite.
 */
export async function rewritePlaywrightMcpCdp(
  mcpJsonPath: string,
  workDir: string,
  cdpEndpoint: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fsp.readFile(mcpJsonPath, 'utf8');
  } catch {
    return false;
  }

  let cfg: { mcpServers?: Record<string, unknown> };
  try {
    cfg = JSON.parse(raw) as typeof cfg;
  } catch {
    return false;
  }

  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') return false;

  const servers = cfg.mcpServers;
  let modified = false;
  let alreadyLive = false;

  for (const [name, entry] of Object.entries(servers)) {
    if (!isPlaywrightEntry(entry)) continue;
    const e = entry as Record<string, unknown>;
    const args = Array.isArray(e.args) ? (e.args as unknown[]).map(String) : [];

    // Already using a CDP endpoint for this session — nothing to change, but it counts as done.
    if (args.includes('--cdp-endpoint') && args.includes(cdpEndpoint)) { alreadyLive = true; continue; }

    const browserDir = path.join(workDir, '.browser');

    // Remove headless/isolated flags (not needed when connecting to existing browser),
    // and remove any existing --cdp-endpoint / its value.
    const stripped: string[] = [];
    let skipNext = false;
    for (const a of args) {
      if (skipNext) { skipNext = false; continue; }
      if (a === '--headless' || a === '--isolated') continue;
      if (a === '--cdp-endpoint') { skipNext = true; continue; }
      stripped.push(a);
    }

    // Append CDP endpoint and output-dir (replace existing --output-dir value)
    const withoutOutput: string[] = [];
    let skipOutput = false;
    for (const a of stripped) {
      if (skipOutput) { skipOutput = false; continue; }
      if (a === '--output-dir') { skipOutput = true; continue; }
      withoutOutput.push(a);
    }

    const newArgs = [
      ...withoutOutput,
      '--cdp-endpoint', cdpEndpoint,
      '--output-dir', browserDir,
    ];

    servers[name] = { ...e, args: newArgs };
    modified = true;
  }

  if (!modified) return alreadyLive;

  try {
    await fsp.mkdir(path.join(workDir, '.browser'), { recursive: true });
    await fsp.writeFile(mcpJsonPath, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}
