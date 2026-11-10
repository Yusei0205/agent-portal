/**
 * Test cases from an API specification, inside the Tests module.
 *
 *   POST /api/projects/:pid/tests/:tpid/case-sets/from-api
 *   Body: {
 *     name?,
 *     source: { kind: 'sim', apiIds: string[] }                 APIs already in the simulation
 *           | { kind: 'xlsx', contentBase64, paths? }           a requirement workbook, used only for this
 *           | { kind: 'openapi', spec }                         an OpenAPI document, used only for this
 *           | { kind: 'postman', collection },                  a Postman collection, used only for this
 *     createScript?: boolean,                                   also write runnable api_request scripts
 *     baseUrl?: string,                                         shown in front of each path in the case sheet
 *   }
 *
 * The specification is optional input to test generation: a file given here is read for the cases and is not added to
 * the simulation. The cases are made by rules (see test-cases.ts), so the answer is immediate (201), unlike the AI
 * generation next to it.
 */

import { router, sendJson } from '../http.ts';
import type { PortalRequest, PortalResponse } from '../http.ts';
import { generateId, now } from '../util.ts';
import { auditRaw } from '../audit.ts';
import { testingRepo } from '../testing/data.ts';
import { requireTestProject, hasScope } from '../testing/helpers.ts';
import { validateSteps } from '../testing/types.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import { checkOpenApi } from './openapi.ts';
import { postmanToSpecs } from './postman.ts';
import { parseSheets, readWorkbook, toDraftSpec } from './excel-spec.ts';
import { generateApiCases } from './test-cases.ts';
import type { ApiCase } from './test-cases.ts';
import type { ApiSpec } from './types.ts';

const MAX_TEXT = 4000;
const MAX_CASES = 1000;

interface NamedSpec { name: string; spec: ApiSpec }

function stringMap(v: unknown): Record<string, string> | null {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) { if (typeof val !== 'string') return null; out[k] = val; }
  return out;
}

async function resolveSource(projectId: string, source: unknown): Promise<{ specs: NamedSpec[] } | { error: string }> {
  if (!source || typeof source !== 'object') return { error: 'source is required' };
  const s = source as Record<string, unknown>;

  if (s.kind === 'sim') {
    const ids = Array.isArray(s.apiIds) ? s.apiIds.map(String) : [];
    if (ids.length === 0) return { error: 'Choose at least one API' };
    const repo = getSimulationRepository();
    const specs: NamedSpec[] = [];
    for (const id of ids.slice(0, 50)) {
      const api = await repo.getApi(projectId, id);
      if (!api) return { error: 'One of the chosen APIs was not found' };
      // The approved version is what the simulation answers with; a draft is better than nothing for a first look.
      const ver = await repo.getVersion(api.id, api.approved_version > 0 ? api.approved_version : api.latest_version);
      if (ver) specs.push({ name: api.name, spec: ver.spec });
    }
    return { specs };
  }

  if (s.kind === 'xlsx') {
    if (typeof s.contentBase64 !== 'string' || !s.contentBase64) return { error: 'contentBase64 is required' };
    const paths = stringMap(s.paths);
    if (!paths) return { error: 'paths must be an object of sheet name to URL path' };
    let parsed;
    try { parsed = parseSheets(await readWorkbook(Buffer.from(s.contentBase64, 'base64'))); } catch { return { error: 'Could not read that file as an Excel workbook (.xlsx)' }; }
    if (parsed.apis.length === 0) return { error: 'No API sheets were found in that workbook' };
    return { specs: parsed.apis.map((a) => ({ name: a.sheet, spec: toDraftSpec(a, { path: paths[a.sheet] }) })) };
  }

  if (s.kind === 'openapi') {
    const checked = checkOpenApi(s.spec);
    if (!checked.spec) return { error: checked.errors.join('; ') };
    return { specs: [{ name: checked.spec.info.title, spec: checked.spec }] };
  }

  if (s.kind === 'postman') {
    const { drafts, errors } = postmanToSpecs(s.collection);
    if (drafts.length === 0) return { error: errors.join(' ') };
    return { specs: drafts.map((d) => ({ name: d.name, spec: d.spec })) };
  }

  return { error: 'source.kind must be "sim", "xlsx", "openapi" or "postman"' };
}

export function registerApiTestRoutes(): void {
  router.post('/api/projects/:pid/tests/:tpid/case-sets/from-api', async (req: PortalRequest, res: PortalResponse): Promise<void> => {
    if (!hasScope(req, 'tests')) { sendJson(res, 403, { error: 'tests scope required' }); return; }
    const tp = await requireTestProject(req, res, req.params.pid, req.params.tpid, 'editor');
    if (!tp) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const createScript = body.createScript === true;
    if (createScript && !hasScope(req, 'write')) { sendJson(res, 403, { error: 'write scope required to create scripts' }); return; }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().slice(0, 2000) : '';
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) { sendJson(res, 400, { error: 'baseUrl must start with http:// or https://' }); return; }

    const resolved = await resolveSource(req.params.pid, body.source);
    if ('error' in resolved) { sendJson(res, 400, { error: resolved.error }); return; }

    // One generation per spec, then one numbering for the whole sheet.
    const all: ApiCase[] = [];
    const assumptions = new Set<string>();
    for (const { spec } of resolved.specs) {
      const g = generateApiCases(spec, { baseUrl: baseUrl || undefined });
      all.push(...g.cases);
      g.assumptions.forEach((a) => assumptions.add(a));
    }
    if (all.length === 0) { sendJson(res, 400, { error: 'That specification has no operations to test' }); return; }
    if (all.length > MAX_CASES) { sendJson(res, 400, { error: `That would make ${all.length} cases (limit ${MAX_CASES}). Choose fewer APIs.` }); return; }

    const categories = [...new Set(all.map((c) => c.category))];
    const perCategory = new Map<string, number>();
    const specNames = resolved.specs.map((s) => s.name);
    const rawName = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
    const name = rawName || `API cases: ${specNames.join(', ')}`.slice(0, 120);

    const csId = generateId();
    const ts = now();
    await testingRepo().createCaseSet({
      id: csId,
      test_project_id: tp.id,
      name,
      description: `Generated from the API specification: ${specNames.join(', ')}`.slice(0, 8000),
      status: 'done',
      progress: JSON.stringify({ phase: 'done', message: 'Generated from the API specification', percent: 100, categoriesTotal: categories.length, categoriesDone: categories.length, casesSoFar: all.length }),
      error: null,
      warnings: JSON.stringify([...assumptions]),
      created_by: req.user!.id,
      created_at: ts,
      started_at: ts,
      finished_at: ts,
      cancelled: 0,
      outline_categories: JSON.stringify(categories),
      attachment_ids: '[]',
    });

    let ord = 0;
    for (const c of all) {
      ord++;
      const n = (perCategory.get(c.category) ?? 0) + 1;
      perCategory.set(c.category, n);
      const testId = `TC-${categories.indexOf(c.category) + 1}.1.${n}`;
      await testingRepo().createCase({
        id: generateId(),
        case_set_id: csId,
        ord,
        test_id: testId,
        category: c.category.slice(0, 200),
        scenario: c.scenario.slice(0, MAX_TEXT),
        precondition: c.precondition.slice(0, MAX_TEXT),
        steps: c.steps.slice(0, MAX_TEXT),
        expected_result: c.expectedResult.slice(0, MAX_TEXT),
        status: '',
        remarks: c.remarks.slice(0, MAX_TEXT),
        request: JSON.stringify(c.request),
        response: c.response ? JSON.stringify(c.response) : null,
        created_at: ts,
        updated_at: ts,
      });
    }

    const scripts: Array<{ id: string; name: string; steps: number }> = [];
    if (createScript) {
      const groupId = generateId();
      await testingRepo().createTestGroup({
        id: groupId,
        test_project_id: tp.id,
        name: `API: ${specNames.join(', ')}`.slice(0, 200),
        sort_order: (await testingRepo().getMaxGroupSortOrder(tp.id)) + 1,
        created_at: ts,
        updated_at: ts,
      });
      let order = 0;
      for (const category of categories) {
        const steps = validateSteps(all.filter((c) => c.category === category && c.step).map((c) => c.step));
        if (steps.length === 0) continue;
        const id = generateId();
        await testingRepo().createTestScript({
          id,
          test_project_id: tp.id,
          test_group_id: groupId,
          name: category.slice(0, 200),
          sort_order: order++,
          steps: JSON.stringify(steps),
          created_by: req.user!.id,
          created_at: ts,
          updated_at: ts,
        });
        scripts.push({ id, name: category, steps: steps.length });
      }
    }

    auditRaw(req.user!.id, 'test_case_set.create_from_api', `test_case_set:${csId}`, { name, cases: all.length, scripts: scripts.length });
    sendJson(res, 201, {
      caseSet: { id: csId, name, caseCount: all.length },
      scripts,
      manualCases: all.filter((c) => !c.step).length,
      assumptions: [...assumptions],
    });
  });
}
