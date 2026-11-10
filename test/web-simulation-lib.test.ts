import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the browser
import { sampleFromSchema, flattenSchema, operationsOf, simulatedUrl, parseJsonField, ruleCondition, ruleOutcome, newRuleId } from '../web/src/lib/simulation.js';

const schema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', maxLength: 8 },
    kind: { type: 'string', enum: ['AS', 'SV'], 'x-enum-descriptions': { AS: 'Assignment' } },
    when: { type: 'string', format: 'date' },
    note: { type: 'string', 'x-conditional': 'Mandatory when kind = SV' },
    items: { type: 'array', items: { type: 'object', properties: { qty: { type: 'integer' } } } },
  },
};

describe('web simulation helpers', () => {
  test('sampleFromSchema respects enums, formats, lengths and nesting', () => {
    const v = sampleFromSchema(schema) as Record<string, unknown>;
    assert.equal(v.kind, 'AS');
    assert.equal(v.when, '2026-01-01');
    assert.equal((v.id as string).length <= 8, true);
    assert.deepEqual(v.items, [{ qty: 1 }]);
  });

  test('flattenSchema lists fields with depth, needed, conditional and allowed values', () => {
    const rows = flattenSchema(schema);
    const by = Object.fromEntries(rows.map((r: { name: string }) => [r.name, r]));
    assert.equal(by.id.required, true);
    assert.equal(by.note.conditional, 'Mandatory when kind = SV');
    assert.deepEqual(by.kind.allowed, ['AS', 'SV']);
    assert.equal(by.items.type, 'list of object');
    assert.equal(by.qty.depth, 1);
  });

  test('operationsOf reads method, path, security and the two schemas', () => {
    const ops = operationsOf({ paths: { '/a': { post: { operationId: 'a', security: [{ b: [] }], parameters: [{ name: 'X', in: 'header', required: true }], requestBody: { content: { 'application/json': { schema } } }, responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } } } } } });
    assert.equal(ops[0].method, 'POST');
    assert.equal(ops[0].secured, true);
    assert.equal(ops[0].headers[0].name, 'X');
    assert.equal(ops[0].requestSchema, schema);
    assert.equal(ops[0].responseSchema.type, 'object');
  });

  test('url, json parsing, rule summaries and ids', () => {
    assert.equal(simulatedUrl('http://h', 'p 1', 'a', '/x/{id}'), 'http://h/api/sim/p%201/a/call/x/{id}');
    assert.deepEqual(parseJsonField('', 'Body'), { value: undefined });
    assert.deepEqual(parseJsonField('{"a":1}', 'Body'), { value: { a: 1 } });
    assert.match(parseJsonField('{', 'Body').error, /Body is not valid JSON/);
    assert.equal(ruleCondition({ when: { body: { action: '142' } } }), 'When action = 142');
    assert.equal(ruleCondition({}), 'Any request');
    assert.equal(ruleOutcome({ response: { status: 422 } }), 'Reply 422');
    assert.equal(ruleOutcome({ failure: 'timeout' }), 'Timeout (504)');
    assert.match(newRuleId('Reject 142!'), /^reject-142-[a-z0-9]{1,4}$/);
  });
});
