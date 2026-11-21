/**
 * Checks an OpenAPI JSON file the way the portal's API simulation will read it, and says what a person should still look at.
 *
 *   node --import tsx scripts/api-spec/validate-spec.mts <spec.json> [--cases]
 *
 * Exit code 1 when the portal would refuse the file or the spec is not internally consistent; 0 otherwise (warnings are
 * printed but do not fail). With --cases it also generates the test cases the portal would make from the spec and runs
 * each one through the mock engine: a case that does not get the status it expects points at a spec that contradicts itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const load = <T,>(rel: string): Promise<T> => import(pathToFileURL(path.join(root, rel)).href) as Promise<T>;

interface Flag { code: string; severity: string; message: string }
interface Op { operationId: string; requestBody?: unknown; responses: Record<string, unknown>; security?: unknown[]; 'x-flags'?: Flag[]; 'x-rules'?: unknown[] }
interface Spec { info: { title: string }; paths: Record<string, Record<string, Op>> }

const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) { console.error('Usage: node --import tsx scripts/api-spec/validate-spec.mts <spec.json> [--cases]'); process.exit(2); }

let raw: unknown;
try { raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); } catch (e) { console.error(`Cannot read ${file} as JSON: ${(e as Error).message}`); process.exit(1); }

const { checkOpenApi } = await load<{ checkOpenApi: (v: unknown) => { spec?: Spec; errors: string[] } }>('server/api-sim/openapi.ts');
const checked = checkOpenApi(raw);
if (!checked.spec) {
  console.error('The portal would refuse this file:');
  for (const e of checked.errors) console.error(`  - ${e}`);
  process.exit(1);
}
const spec = checked.spec;

let errors = 0;
let warnings = 0;
const problem = (level: 'error' | 'warn', msg: string): void => { if (level === 'error') errors++; else warnings++; console.log(`  ${level === 'error' ? 'ERROR' : 'warn '} ${msg}`); };

console.log(`${spec.info.title}`);
for (const [p, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const flags = op['x-flags'] ?? [];
    console.log(`\n${method.toUpperCase()} ${p}  (${op.operationId})`);
    if (!Object.keys(op.responses).some((c) => /^2\d\d$/.test(c))) problem('error', 'no 2xx response: the simulation has nothing to answer with');
    if (method === 'get' && op.requestBody) problem('warn', 'a GET with a request body: put the fields in query parameters');
    if (/^\/[a-z][A-Za-z0-9]*$/.test(p) && flags.some((f) => f.code === 'MISSING_PATH')) problem('warn', 'URL path is a placeholder: the document did not give one');
    if (!op.requestBody && ['post', 'put', 'patch'].includes(method)) problem('warn', `${method.toUpperCase()} with no request body described`);
    const bySeverity = flags.reduce<Record<string, number>>((m, f) => ({ ...m, [f.severity]: (m[f.severity] ?? 0) + 1 }), {});
    console.log(`  responses: ${Object.keys(op.responses).join(', ')} | login needed: ${op.security?.length ? 'yes' : 'no'} | notes: ${bySeverity.warning ?? 0} warnings, ${bySeverity.info ?? 0} info`);
    for (const f of flags.filter((x) => x.severity === 'warning')) console.log(`    ! ${f.code}: ${f.message}`);
  }
}

if (process.argv.includes('--cases')) {
  const { generateApiCases } = await load<{ generateApiCases: (s: unknown) => { cases: Array<{ kind: string; scenario: string; step: { method: string; path: string; headers: Record<string, string>; body?: unknown; expectedStatus: number } | null }>; assumptions: string[] } }>('server/api-sim/test-cases.ts');
  const { handleMockRequest } = await load<{ handleMockRequest: (s: unknown, rules: unknown[], req: unknown) => { status: number } }>('server/api-sim/mock-engine.ts');
  const { cases } = generateApiCases(spec);
  const kinds = cases.reduce<Record<string, number>>((m, c) => ({ ...m, [c.kind]: (m[c.kind] ?? 0) + 1 }), {});
  console.log(`\nTest cases the portal would generate: ${cases.length} (${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ')})`);
  let wrong = 0;
  for (const c of cases.filter((x) => x.step)) {
    const s = c.step!;
    const u = new URL(s.path, 'http://placeholder.invalid');
    const r = handleMockRequest(spec, [], { method: s.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: s.headers, body: s.body });
    if (r.status !== s.expectedStatus) { wrong++; problem('error', `${c.scenario}: expected ${s.expectedStatus}, the simulation answers ${r.status}`); }
  }
  if (wrong === 0) console.log('  every runnable case gets the status it expects from the simulation');
}

console.log(`\n${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
process.exit(errors > 0 ? 1 : 0);
