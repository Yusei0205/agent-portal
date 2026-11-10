/**
 * Turning rules the client's document states in words into checks, with AI, and confirming them.
 *
 *   POST /api/projects/:id/sim/apis/:aid/versions/:v/ai-rules      {credentialId?, model?}
 *        Asks the chosen model, once per operation that has such rules, and saves the usable answers as SUGGESTED
 *        rules on a NEW draft version (the version it started from is left alone).
 *   PUT  /api/projects/:id/sim/apis/:aid/versions/:v/rules/:rid    {status: 'confirmed' | 'suggested' | 'removed'}
 *        A person's decision, on a draft version. Only confirmed rules are applied by the simulation and used to write
 *        test cases.
 *
 * The model's answer is never trusted: see sanitizeAiRules. What it cannot be sure of it leaves out, and the response
 * lists what was dropped and why.
 */

import { router, sendJson } from '../http.ts';
import { generateId, now } from '../util.ts';
import { auditRaw } from '../audit.ts';
import { callTextModel } from '../testing/model-provider.ts';
import { extractJsonArray } from '../testing/generate.ts';
import { getSimulationRepository } from '../repositories/simulation.ts';
import { requireProjectAccess, bad } from './access.ts';
import { attachRules, describeRule, listFields, sanitizeAiRules } from './rules.ts';
import type { ApiSpec, BusinessRule, Flag } from './types.ts';

const MAX_OPERATIONS = 10;
const MAX_FIELDS = 400;

const SYSTEM_PROMPT = [
  'You turn business rules that an API specification states in words into structured checks.',
  'Reply with JSON only: a list of rules, no other text.',
  'Each rule is {"description": string, "when": [{"field": string, "op": string, "value": string or list}], "requires": [string]}.',
  'Meaning: when ALL tests in "when" hold, every field in "requires" must be present and not empty.',
  'Copy field names exactly from the list of fields you are given (they are dotted paths). Never invent a field.',
  'op is one of: equals, not_equals, in, present, absent. "in" takes a list of values; "present" and "absent" take no value.',
  'Only write a rule when the text clearly says when a field is mandatory. If it is vague, or depends on something that is not a field of this request, leave it out.',
].join('\n');

function userPrompt(operationId: string, fields: ReturnType<typeof listFields>): string {
  return JSON.stringify({
    operation: operationId,
    fields: fields.slice(0, MAX_FIELDS).map((f) => ({ path: f.path, type: f.type, ...(f.allowed.length ? { allowedValues: f.allowed.slice(0, 20) } : {}) })),
    rulesInWords: fields.filter((f) => f.conditional).map((f) => ({ field: f.path, text: f.conditional.slice(0, 600) })),
  });
}

export function registerAiRuleRoutes(): void {
  const base = '/api/projects/:id/sim';

  router.post(`${base}/apis/:aid/versions/:v/ai-rules`, async (req, res): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const repo = getSimulationRepository();
    const api = await repo.getApi(req.params.id, req.params.aid);
    const ver = api ? await repo.getVersion(api.id, Number(req.params.v)) : null;
    if (!api || !ver) { bad(res, 'Version not found', 404); return; }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const ai = {
      credentialId: typeof body.credentialId === 'string' && body.credentialId ? body.credentialId : null,
      model: typeof body.model === 'string' && body.model ? body.model.slice(0, 200) : null,
    };

    const spec = structuredClone(ver.spec) as ApiSpec;
    const rejected: string[] = [];
    let accepted = 0;
    let tried = 0;

    for (const item of Object.values(spec.paths)) {
      for (const op of Object.values(item)) {
        if (!op) continue;
        const schema = op.requestBody?.content['application/json']?.schema;
        const fields = listFields(schema);
        if (!fields.some((f) => f.conditional)) continue;
        if (tried >= MAX_OPERATIONS) { rejected.push(`${op.operationId}: skipped (at most ${MAX_OPERATIONS} operations per request).`); continue; }
        tried++;
        let raw: unknown;
        try {
          const text = await callTextModel(SYSTEM_PROMPT, userPrompt(op.operationId, fields), { maxTokens: 4096, createdBy: req.user!.id, ...ai });
          raw = extractJsonArray(text);
        } catch (e) {
          rejected.push(`${op.operationId}: the model could not be used (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}).`);
          continue;
        }
        const checked = sanitizeAiRules(raw, schema, () => `r-${generateId().slice(0, 8)}`);
        rejected.push(...checked.rejected.map((r) => `${op.operationId}: ${r}`));
        if (checked.rules.length > 0) { attachRules(op, checked.rules); accepted += checked.rules.length; }
      }
    }

    if (tried === 0) { bad(res, 'This version has no rules stated in words to turn into checks.'); return; }
    if (accepted === 0) { sendJson(res, 200, { version: null, accepted: 0, rejected, operationsTried: tried }); return; }

    const next = api.latest_version + 1;
    await repo.addVersion({ api_id: api.id, version: next, status: 'draft', label: `AI checks on v${ver.version}`, spec, created_by: req.user!.id, created_at: now() });
    await repo.updateApi(req.params.id, api.id, { latest_version: next });
    auditRaw(req.user!.id, 'sim_api.ai_rules', `sim_api:${api.id}`, { from: ver.version, to: next, accepted, model: ai.model ?? 'default' });
    sendJson(res, 201, { version: next, accepted, rejected, operationsTried: tried });
  });

  router.put(`${base}/apis/:aid/versions/:v/rules/:rid`, async (req, res): Promise<void> => {
    if (!await requireProjectAccess(req, res, req.params.id)) return;
    const repo = getSimulationRepository();
    const api = await repo.getApi(req.params.id, req.params.aid);
    const ver = api ? await repo.getVersion(api.id, Number(req.params.v)) : null;
    if (!api || !ver) { bad(res, 'Version not found', 404); return; }
    if (ver.status !== 'draft') { bad(res, 'Only a draft version can be changed. Import or generate a new version instead.', 409); return; }
    const status = (req.body as Record<string, unknown>)?.status;
    if (status !== 'confirmed' && status !== 'suggested' && status !== 'removed') { bad(res, 'status must be "confirmed", "suggested" or "removed"'); return; }

    const spec = structuredClone(ver.spec) as ApiSpec;
    let found: BusinessRule | null = null;
    for (const item of Object.values(spec.paths)) {
      for (const op of Object.values(item)) {
        const rule = op?.['x-rules']?.find((r) => r.id === req.params.rid);
        if (!op || !rule) continue;
        found = rule;
        const flagText = `AI suggested a check: ${describeRule(rule)}`;
        // The AI note goes once the decision is made; a rule put back to "suggested" gets it again.
        const flags: Flag[] = (op['x-flags'] ?? []).filter((f) => !(f.code === 'AI_RULE' && f.message.startsWith(flagText)));
        if (status === 'removed') op['x-rules'] = op['x-rules']!.filter((r) => r.id !== rule.id);
        else {
          rule.status = status;
          if (status === 'suggested') flags.push({ code: 'AI_RULE', severity: 'warning', message: `${flagText}. It is not applied until you confirm it.` });
        }
        if (op['x-rules']?.length === 0) delete op['x-rules'];
        if (flags.length > 0) op['x-flags'] = flags; else delete op['x-flags'];
      }
    }
    if (!found) { bad(res, 'Rule not found', 404); return; }
    await repo.updateVersion(api.id, ver.version, { spec });
    sendJson(res, 200, { spec });
  });
}
