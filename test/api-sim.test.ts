import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { handleMockRequest, locateOperation } from '../server/api-sim/mock-engine.ts';
import { generateValue, validateValue } from '../server/api-sim/schema.ts';
import { buildTree, isApiSheet, parseApiSheet, parseSheets, readWorkbook, toDraftSpec } from '../server/api-sim/excel-spec.ts';
import type { ApiSpec, MockRule } from '../server/api-sim/types.ts';
import type { Grid } from '../server/api-sim/excel-spec.ts';

const HEAD = ['NO.', 'FIELD NAME', '(M)andatory or \n(O)ptional or\nConditional or \nEcho', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'REMARKS', 'SCREEN CODE', 'FLASH REMARKS'];

/** A sheet shaped like "UpdateProgressive" in the client sample: shifted header rows, nested lists, conditional fields. */
const UPDATE_SHEET: Grid = [
  [],
  ['1. Request'],
  [],
  ['API Name', 'UpdateFlash'],
  ['Method', 'POST'],
  ['Authentication', 'Yes'],
  ['NO.', 'FIELD NAME', '(M)andatory or (O)ptional or Conditional or Echo', 'Data Type', 'Data Length', 'FIELD NAME DESCRIPTION', 'Remarks'],
  ['1', 'Bearer', 'M', 'String', 'No limit', 'Bearer token returned from the Login request'],
  ['Header'],
  ['2', 'X-Source-Id', '', 'M', 'String', 'No limit'],
  [],
  ['Content-Type', 'application/json'],
  HEAD,
  ['1', 'applicationNumber', 'M', 'String', '20', 'Application Account Number'],
  ['2', 'action', 'M', 'String', '20', 'Action', 'Action code to be provided by FLASH'],
  ['3', 'comment', 'O', 'Object', '-', 'Comment object'],
  ['3.1', 'comments', 'CM', 'String', '2000', 'Comments', 'Mandatory when Action Code = 142'],
  ['4', 'collateralList', 'CM', 'String', '2000', 'Collateral list'],
  ['4.[n]', '- ', 'CM', '-', '-', '-'],
  ['4.[n].1', 'collateralUuid', 'CM', 'String', '50', 'Collateral UUID'],
  ['4.[n].2', 'collateralType', 'N', 'String', '20', 'Collateral Type', '', '', 'Valid Value:\nAS - Assignment of Rental\nSV - Staff Vehicle'],
  ['4.[n].3', 'fireInsuranceListing', 'CM', 'Object', '-', 'Fire insurance'],
  ['4.[n].3.[m]', '- ', 'CM', '-', '-', '-'],
  ['4.[n].3.[m].1', 'noOfStoreys', 'CM', 'Numeric', '3,0', 'No. of Storeys'],
  ['5', 'amount', 'O', 'Numeric', '10,2', 'Amount'],
  [],
  ['2.  Response'],
  ['API Name', 'UpdateFlash'],
  HEAD,
  ['1', 'id', 'M', 'String', '-', 'Unique request ID'],
  ['2', 'code', 'M', 'String', '10', 'Response code'],
  ['3', 'msgs', 'M', 'Array', '', 'Messages', 'Refer to [Message Code] Sheet'],
  ['3.[n].1', 'msgCode', 'M', 'String', '6', 'Message Code'],
  ['3.[n].2', 'msgDesc', 'M', 'String', '255', 'Message Description'],
];

describe('excel parser', () => {
  const api = parseApiSheet('UpdateProgressive', UPDATE_SHEET);
  const spec = toDraftSpec(api);
  const op = spec.paths['/updateProgressive']!.post!;
  const body = op.requestBody!.content['application/json'].schema;

  test('recognises an API sheet and reads the label rows', () => {
    assert.equal(isApiSheet(UPDATE_SHEET), true);
    assert.equal(isApiSheet([['Cover page'], ['v1.9']]), false);
    assert.equal(api.apiName, 'UpdateFlash');
    assert.equal(api.method, 'POST');
    assert.equal(api.hasBearer, true);
  });

  test('reads a shifted header row and turns Bearer into security', () => {
    const h = op.parameters!.find((p) => p.name === 'X-Source-Id')!;
    assert.equal(h.in, 'header');
    assert.equal(h.required, true);
    assert.ok(op.security);
    assert.equal(spec.components?.securitySchemes && 'bearerAuth' in spec.components.securitySchemes, true);
    assert.equal(op.parameters!.some((p) => p.name.toLowerCase() === 'bearer'), false);
  });

  test('builds nested objects and lists from the NO. column', () => {
    const list = body.properties!.collateralList;
    assert.equal(list.type, 'array');
    assert.equal(list.items!.type, 'object');
    const fire = list.items!.properties!.fireInsuranceListing;
    assert.equal(fire.type, 'array');
    assert.equal(fire.items!.properties!.noOfStoreys.type, 'integer');
    assert.equal(body.properties!.comment.type, 'object');
    assert.ok(body.properties!.comment.properties!.comments);
    assert.equal(body.properties!.amount.type, 'number');
  });

  test('required comes from M only; conditional fields are optional with x-conditional', () => {
    assert.deepEqual(body.required, ['applicationNumber', 'action']);
    assert.match(body.properties!.comment.properties!.comments['x-conditional']!, /Action Code = 142/);
  });

  test('extracts enum values from remarks and flags them', () => {
    const t = body.properties!.collateralList.items!.properties!.collateralType;
    assert.deepEqual(t.enum, ['AS', 'SV']);
    assert.ok(op['x-flags']!.some((f) => f.code === 'ENUM_EXTRACTED'));
  });

  test('flags a missing path, a type mismatch and conditional rules', () => {
    const codes = op['x-flags']!.map((f) => f.code);
    assert.ok(codes.includes('MISSING_PATH'));
    assert.ok(codes.includes('TYPE_MISMATCH'));
    assert.ok(codes.includes('CONDITIONAL_RULE'));
  });

  test('a supplied path removes the missing-path flag', () => {
    const s = toDraftSpec(api, { path: '/flash/update' });
    assert.ok(s.paths['/flash/update']);
    assert.equal(s.paths['/flash/update']!.post!['x-flags']!.some((f) => f.code === 'MISSING_PATH'), false);
  });

  test('response tree and maxLength are read', () => {
    const res = op.responses['200'].content!['application/json'].schema;
    assert.equal(res.properties!.msgs.type, 'array');
    assert.equal(res.properties!.msgs.items!.properties!.msgDesc.maxLength, 255);
    assert.equal(body.properties!.applicationNumber.maxLength, 20);
  });

  test('two sheets with the same API name are flagged as possible duplicates', () => {
    const r = parseSheets([
      { name: 'UpdateFlash', grid: UPDATE_SHEET },
      { name: 'UpdateProgressive', grid: UPDATE_SHEET },
      { name: 'Cover Page', grid: [['x']] },
    ]);
    assert.equal(r.apis.length, 2);
    assert.deepEqual(r.skipped, ['Cover Page']);
    assert.ok(r.flags.some((f) => f.code === 'DUPLICATE_API_NAME'));
  });

  test('a response that says "Refer to <sheet> worksheet response" is copied from that sheet and flagged', () => {
    const refSheet: Grid = UPDATE_SHEET.slice(0, UPDATE_SHEET.findIndex((r) => /response/i.test(r[0] ?? '')) + 1)
      .concat([['API Name', 'UpdateFlash'], HEAD, ['Refer to Update Flash (all metadata) worksheet response']]);
    const r = parseSheets([
      { name: 'Update Flash (all metadata)', grid: UPDATE_SHEET },
      { name: 'Short', grid: refSheet },
    ]);
    const short = r.apis.find((a) => a.sheet === 'Short')!;
    assert.equal(short.responseRef, 'Update Flash (all metadata)');
    assert.equal(short.response.length, 3);
    assert.ok(short.flags.some((f) => f.code === 'RESPONSE_SHARED'), 'RESPONSE_SHARED flag missing');
    assert.equal(short.flags.some((f) => f.code === 'NO_RESPONSE'), false);
    const lone = parseSheets([{ name: 'Short', grid: refSheet }]).apis[0];
    assert.ok(lone.flags.some((f) => f.code === 'RESPONSE_REFERENCE_UNRESOLVED'), 'unresolved flag missing');
  });

  test('an orphan child row is kept at the top level and flagged', () => {
    const flags: never[] | import('../server/api-sim/types.ts').Flag[] = [];
    const tree = buildTree([{ no: '5.2', name: 'x', mandatory: 'M', dataType: 'String', length: '', description: '', remarks: '', children: [], listMarker: false }], flags, 'request');
    assert.equal(tree.length, 1);
    assert.equal(flags[0]?.code, 'ORPHAN_FIELD');
  });
});

describe('schema', () => {
  const schema = toDraftSpec(parseApiSheet('UpdateProgressive', UPDATE_SHEET)).paths['/updateProgressive']!.post!.requestBody!.content['application/json'].schema;

  test('accepts a valid body and warns (not errors) on a missing conditional field', () => {
    const r = validateValue({ applicationNumber: 'A1', action: '141' }, schema);
    assert.equal(r.errors.length, 0);
    // collateralList is conditional and absent: a warning, never an error
    assert.deepEqual(r.warnings.map((x) => x.at), ['$.collateralList']);
    const w = validateValue({ applicationNumber: 'A1', action: '141', comment: {} }, schema);
    assert.equal(w.errors.length, 0);
    assert.ok(w.warnings.some((f) => f.code === 'CONDITIONAL_RULE' && f.at?.endsWith('comments')));
  });

  test('reports missing required fields, wrong types, enum and length violations', () => {
    const r = validateValue({ action: 5, collateralList: [{ collateralType: 'ZZ' }], applicationNumber: 'x'.repeat(21) }, schema);
    const paths = r.errors.map((e) => e.path);
    assert.ok(paths.includes('$.action'));
    assert.ok(paths.includes('$.applicationNumber'));
    assert.ok(paths.includes('$.collateralList[0].collateralType'));
  });

  test('generated values validate against their own schema', () => {
    const v = generateValue(schema);
    assert.equal(validateValue(v, schema).errors.length, 0);
  });
});

describe('mock engine', () => {
  const api = parseApiSheet('UpdateProgressive', UPDATE_SHEET);
  const spec: ApiSpec = toDraftSpec(api, { path: '/flash/applications/{id}/update' });
  const good = { applicationNumber: 'A1', action: '141' };
  const headers = { Authorization: 'Bearer t', 'X-Source-Id': 'GENAI' };
  const req = (over: Record<string, unknown> = {}) => ({ method: 'POST', path: '/flash/applications/42/update', headers, body: good, ...over });

  test('locates templated paths and prefers literal ones', () => {
    assert.ok(locateOperation(spec, 'post', '/flash/applications/42/update'));
    assert.equal(locateOperation(spec, 'get', '/flash/applications/42/update'), null);
    const both: ApiSpec = { ...spec, paths: { '/a/{id}': { get: { operationId: 'byId', responses: {} } }, '/a/me': { get: { operationId: 'me', responses: {} } } } };
    assert.equal(locateOperation(both, 'get', '/a/me')!.operation.operationId, 'me');
    assert.equal(locateOperation(both, 'get', '/a/7')!.operation.operationId, 'byId');
  });

  test('BLOCKS an unknown route instead of guessing or forwarding', () => {
    const r = handleMockRequest(spec, [], req({ path: '/nope' }));
    assert.equal(r.status, 501);
    assert.equal(r.source, 'blocked');
    assert.equal((r.body as { error: string }).error, 'NO_MOCK_RULE');
  });

  test('BLOCKS when the matching rule needs review after a spec change', () => {
    const rule: MockRule = { id: 'r1', operationId: 'updateProgressive', name: 'happy', response: { status: 200, body: {} }, needsReview: true };
    const r = handleMockRequest(spec, [rule], req());
    assert.equal(r.status, 501);
    assert.equal((r.body as { error: string }).error, 'MOCK_RULE_NEEDS_REVIEW');
  });

  test('requireExplicitRule blocks an operation that has no rule', () => {
    assert.equal(handleMockRequest(spec, [], req(), { requireExplicitRule: true }).status, 501);
    assert.equal(handleMockRequest(spec, [], req()).status, 200);
  });

  test('401 without Authorization, 400 for a bad body or missing header', () => {
    assert.equal(handleMockRequest(spec, [], req({ headers: { 'X-Source-Id': 'g' } })).status, 401);
    const bad = handleMockRequest(spec, [], req({ body: { action: 1 } }));
    assert.equal(bad.status, 400);
    assert.equal(bad.source, 'invalid');
    assert.equal(handleMockRequest(spec, [], req({ headers: { Authorization: 'Bearer t' } })).status, 400);
  });

  test('generated answer comes from the response schema', () => {
    const r = handleMockRequest(spec, [], req());
    assert.equal(r.source, 'generated');
    assert.equal(r.headers['x-mock-source'], 'generated');
    assert.ok(Array.isArray((r.body as { msgs: unknown[] }).msgs));
  });

  test('a rule can be selected by body value; the first matching rule wins', () => {
    const rules: MockRule[] = [
      { id: 'rej', operationId: 'updateProgressive', name: 'reject 142', when: { body: { action: '142' } }, response: { status: 422, body: { code: '99' } } },
      { id: 'ok', operationId: 'updateProgressive', name: 'ok', response: { status: 200, body: { code: '00' } } },
    ];
    assert.equal(handleMockRequest(spec, rules, req({ body: { ...good, action: '142' } })).status, 422);
    const ok = handleMockRequest(spec, rules, req());
    assert.equal(ok.ruleId, 'ok');
    assert.deepEqual(ok.body, { code: '00' });
  });

  test('scripted failures: timeout, rate limit, server error, malformed body', () => {
    const f = (failure: MockRule['failure']) => handleMockRequest(spec, [{ id: 'f', operationId: 'updateProgressive', name: 'f', failure }], req());
    assert.equal(f('timeout').status, 504);
    assert.ok(f('timeout').delayMs >= 1000);
    assert.equal(f('rate_limited').status, 429);
    assert.equal(f('server_error').status, 500);
    assert.equal(typeof f('malformed').body, 'string');
  });

  test('conditional rules come back as warnings on an otherwise good call', () => {
    const r = handleMockRequest(spec, [], req({ body: { ...good, comment: {} } }));
    assert.equal(r.status, 200);
    assert.ok(r.warnings.some((w) => w.code === 'CONDITIONAL_RULE'));
  });
});

const SAMPLE = 'C:/Users/tanch/Downloads/WS_GENAI_FLASH_ISD3_RestAPI_v1.9.xlsx';
describe('real client workbook', { skip: !existsSync(SAMPLE) && 'sample workbook not on this machine' }, () => {
  test('finds the API sheets and builds a valid-looking draft for each', async () => {
    const parsed = parseSheets(await readWorkbook(SAMPLE));
    const names = parsed.apis.map((a) => a.sheet);
    for (const n of ['Login', 'UpdateProgressive', 'InitiateProgressive', 'ReassignUsers']) assert.ok(names.includes(n), `missing ${n}`);
    assert.ok(parsed.apis.length >= 8, `only ${parsed.apis.length} API sheets found`);
    assert.ok(parsed.skipped.includes('Cover Page'));
    for (const a of parsed.apis) {
      const spec = toDraftSpec(a);
      const op = Object.values(Object.values(spec.paths)[0]!)[0]!;
      assert.ok(Object.keys(op.responses['200'].content!['application/json'].schema.properties ?? {}).length > 0, `${a.sheet}: empty response`);
      assert.ok(op['x-flags']!.some((f) => f.code === 'MISSING_PATH'));
    }
    const login = parsed.apis.find((a) => a.sheet === 'Login')!;
    assert.equal(login.method, 'POST');
    assert.equal(login.hasBearer, false);
    assert.ok(parsed.flags.some((f) => f.code === 'DUPLICATE_API_NAME'));
  });
});
