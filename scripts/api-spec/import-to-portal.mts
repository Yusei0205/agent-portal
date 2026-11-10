/**
 * Sends an OpenAPI JSON file to the portal's API simulation as draft APIs. Nothing is approved: a person reviews the
 * drafts in the portal (Tests > API simulation), enters any missing URL paths, and approves them.
 *
 *   node --import tsx scripts/api-spec/import-to-portal.mts <spec.json> --project <id> --group "<name>" [--label v1.9] [--dry-run]
 *
 * Environment: PORTAL_URL (default http://127.0.0.1:8787) and PORTAL_TOKEN (an API token, "ap_..."; not needed for --dry-run).
 * This changes a shared system, so run it only when the person asked for the import.
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const project = flag('--project');
const group = flag('--group') ?? '';
const label = flag('--label') ?? '';
const dry = args.includes('--dry-run');

if (!file || !project) {
  console.error('Usage: node --import tsx scripts/api-spec/import-to-portal.mts <spec.json> --project <id> --group "<name>" [--label v1.9] [--dry-run]');
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as { info?: { title?: string }; paths?: Record<string, unknown> };
const base = (process.env.PORTAL_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
console.log(`${dry ? 'Would send' : 'Sending'} "${spec.info?.title ?? file}" (${Object.keys(spec.paths ?? {}).length} paths) to ${base}, project ${project}, group "${group || '(none)'}"${label ? `, version label "${label}"` : ''}`);
if (dry) process.exit(0);

const token = process.env.PORTAL_TOKEN;
if (!token) { console.error('Set PORTAL_TOKEN to an API token (API access in the portal).'); process.exit(2); }

const res = await fetch(`${base}/api/projects/${encodeURIComponent(project)}/sim/import`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-requested-with': 'agent-portal' },
  body: JSON.stringify({ kind: 'openapi', spec, group, label }),
});
const body = (await res.json().catch(() => ({}))) as { error?: string; created?: Array<{ id: string; name: string; version: number; isNew: boolean }> };
if (!res.ok) { console.error(`The portal said ${res.status}: ${body.error ?? 'no reason given'}`); process.exit(1); }
for (const c of body.created ?? []) console.log(`  ${c.isNew ? 'new API' : `new version v${c.version} of`} ${c.name} (${c.id})`);
console.log('Imported as drafts. Review them in the portal under Tests > API simulation.');
