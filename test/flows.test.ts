/**
 * Flow recipes: parsing and checking a recipe file, and the state machine that moves a running flow on
 * (sequence, parallel steps, run-until loops, failure, stop).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipeText, validateRecipe, looksLikeFlow, renderPrompt, ancestors } from '../server/flows/recipe.ts';
import {
  newFlowState, readySteps, stepPrompt, markStarted, applyStepResult, applyStop, flowSummary, publicFlow,
} from '../server/flows/state.ts';

const YAML = `
name: feature-pipeline
description: Design, build and review
steps:
  - id: design
    prompt: "Design: {{input}}"
  - id: build
    prompt: "Build from:\\n{{steps.design.result}}"
  - id: tests
    needs: [design]
    prompt: "Test {{steps.design.result}}"
  - id: review
    needs: [build, tests]
    prompt: "Review. End with APPROVED."
    until: APPROVED
    maxRuns: 3
`;

const recipe = () => validateRecipe(parseRecipeText(YAML, 'x.yaml'), 'x');
const at = '2026-01-01T00:00:00Z';

describe('recipe parsing', () => {
  it('reads YAML and fills in defaults', () => {
    const r = recipe();
    assert.equal(r.name, 'feature-pipeline');
    assert.deepEqual(r.steps.map((s) => s.id), ['design', 'build', 'tests', 'review']);
    assert.deepEqual(r.steps[0].needs, []);
    assert.deepEqual(r.steps[1].needs, ['design']); // default: the step before
    assert.deepEqual(r.steps[3].needs, ['build', 'tests']);
    assert.equal(r.steps[3].maxRuns, 3);
    assert.equal(r.steps[0].maxRuns, 1);
  });

  it('reads JSON and takes the name from the file when the recipe has none', () => {
    const r = validateRecipe(parseRecipeText('{"steps":[{"prompt":"hi"}]}', 'quick.json'), 'quick');
    assert.equal(r.name, 'quick');
    assert.equal(r.steps[0].id, 'step1');
  });

  it('tells a portal recipe from a Kiro-native one', () => {
    assert.equal(looksLikeFlow(parseRecipeText(YAML, 'x.yaml')), true);
    assert.equal(looksLikeFlow({ steps: [{ agent: 'a', task: 'b' }] }), false);
    assert.equal(looksLikeFlow({ nodes: [] }), false);
  });

  it('rejects text that is not YAML or JSON with a short message', () => {
    assert.throws(() => parseRecipeText('{bad', 'x.json'), /Not valid JSON/);
    assert.throws(() => parseRecipeText('a: [1', 'x.yaml'), /Not valid YAML/);
  });

  it('rejects a duplicate id, an unknown or cyclic dependency, and a self dependency', () => {
    const mk = (steps: unknown[]) => () => validateRecipe({ name: 'r', steps }, 'r');
    assert.throws(mk([{ id: 'a', prompt: 'x' }, { id: 'a', prompt: 'y' }]), /Two steps have the id/);
    assert.throws(mk([{ id: 'a', prompt: 'x', needs: ['zzz'] }]), /not a step/);
    assert.throws(mk([{ id: 'a', prompt: 'x', needs: ['a'] }]), /itself/);
    assert.throws(mk([{ id: 'a', prompt: 'x', needs: ['b'] }, { id: 'b', prompt: 'y', needs: ['a'] }]), /cycle/);
    assert.throws(mk([{ id: 'a', prompt: '' }]), /needs a prompt/);
    assert.throws(mk([{ id: '1bad', prompt: 'x' }]), /must start with a letter/);
  });

  it('rejects a prompt that uses the answer of a step it does not wait for', () => {
    const steps = [{ id: 'a', prompt: 'x' }, { id: 'b', needs: [], prompt: 'uses {{steps.a.result}}' }];
    assert.throws(() => validateRecipe({ name: 'r', steps }, 'r'), /must wait for it/);
    assert.throws(() => validateRecipe({ name: 'r', steps: [{ id: 'a', prompt: '{{steps.nope.result}}' }] }, 'r'), /no step "nope"/);
  });

  it('limits the number of steps and maxRuns', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, prompt: 'x' }));
    assert.throws(() => validateRecipe({ name: 'r', steps: many }, 'r'), /at most 20/);
    assert.throws(() => validateRecipe({ name: 'r', steps: [{ prompt: 'x', until: 'OK', maxRuns: 99 }] }, 'r'), /maxRuns/);
  });

  it('works out what a step transitively waits for', () => {
    assert.deepEqual([...ancestors(recipe().steps, 'review')].sort(), ['build', 'design', 'tests']);
  });

  it('fills in templates', () => {
    assert.equal(renderPrompt('a {{input}} b {{ steps.x.result }} c {{steps.y.result}}', 'IN', { x: 'RX' }), 'a IN b RX c ');
  });
});

describe('flow state', () => {
  it('starts with the steps that wait for nothing', () => {
    const st = newFlowState('f1', recipe(), 'add login', 'u1', at);
    assert.deepEqual(readySteps(st).map((s) => s.id), ['design']);
  });

  it('runs steps with the same needs side by side and joins them', () => {
    const st = newFlowState('f1', recipe(), 'x', 'u1', at);
    markStarted(st, 'design', 'c1', at);
    assert.deepEqual(readySteps(st), []); // nothing else until design is done
    applyStepResult(st, 'design', true, 'THE DESIGN', at);
    assert.deepEqual(readySteps(st).map((s) => s.id), ['build', 'tests']);
    markStarted(st, 'build', 'c2', at);
    markStarted(st, 'tests', 'c3', at);
    applyStepResult(st, 'build', true, 'built', at);
    assert.deepEqual(readySteps(st), []); // review waits for tests too
    applyStepResult(st, 'tests', true, 'tested', at);
    assert.deepEqual(readySteps(st).map((s) => s.id), ['review']);
  });

  it('gives a step the answers it uses, and the input', () => {
    const st = newFlowState('f1', recipe(), 'add login', 'u1', at);
    assert.match(stepPrompt(st, st.recipe.steps[0]), /Design: add login/);
    markStarted(st, 'design', 'c1', at);
    applyStepResult(st, 'design', true, 'THE DESIGN', at);
    assert.match(stepPrompt(st, st.recipe.steps[1]), /Build from:\nTHE DESIGN/);
  });

  it('repeats a step until its answer has the text, then moves on', () => {
    const r = validateRecipe({ name: 'r', steps: [{ id: 'review', prompt: 'review', until: 'approved', maxRuns: 3 }] }, 'r');
    const st = newFlowState('f', r, '', 'u', at);
    markStarted(st, 'review', 'c1', at);
    applyStepResult(st, 'review', true, 'CHANGES NEEDED', at);
    assert.equal(st.steps.review.status, 'pending');
    assert.equal(st.status, 'running');
    markStarted(st, 'review', 'c2', at);
    assert.match(stepPrompt(st, r.steps[0]), /run 2 of at most 3[\s\S]*CHANGES NEEDED/);
    applyStepResult(st, 'review', true, 'Looks good. APPROVED', at); // case-insensitive
    assert.equal(st.steps.review.status, 'done');
    assert.equal(st.status, 'done');
  });

  it('stops repeating at maxRuns and counts that as done', () => {
    const r = validateRecipe({ name: 'r', steps: [{ id: 'a', prompt: 'p', until: 'OK', maxRuns: 2 }] }, 'r');
    const st = newFlowState('f', r, '', 'u', at);
    markStarted(st, 'a', 'c1', at); applyStepResult(st, 'a', true, 'no', at);
    markStarted(st, 'a', 'c2', at); applyStepResult(st, 'a', true, 'still no', at);
    assert.equal(st.steps.a.status, 'done');
    assert.equal(st.steps.a.runs, 2);
    assert.equal(st.status, 'done');
  });

  it('fails the flow when a step fails, skips what has not started, and returns the steps still running', () => {
    const st = newFlowState('f1', recipe(), 'x', 'u1', at);
    markStarted(st, 'design', 'c1', at);
    applyStepResult(st, 'design', true, 'd', at);
    markStarted(st, 'build', 'c2', at);
    markStarted(st, 'tests', 'c3', at);
    const toStop = applyStepResult(st, 'build', false, 'compile error', at);
    assert.deepEqual(toStop, ['tests']);
    assert.equal(st.status, 'running'); // until tests ends
    assert.equal(st.steps.review.status, 'skipped');
    assert.match(st.note, /Step "build" failed: compile error/);
    applyStepResult(st, 'tests', false, 'cancelled', at);
    assert.equal(st.status, 'failed');
    assert.ok(st.finishedAt);
  });

  it('ignores a result for a step that is not running (a second run of the same session)', () => {
    const st = newFlowState('f1', recipe(), 'x', 'u1', at);
    markStarted(st, 'design', 'c1', at);
    applyStepResult(st, 'design', true, 'first', at);
    applyStepResult(st, 'design', true, 'later chat', at);
    assert.equal(st.steps.design.result, 'first');
  });

  it('stops: skips what has not started and returns the running steps', () => {
    const st = newFlowState('f1', recipe(), 'x', 'u1', at);
    markStarted(st, 'design', 'c1', at);
    assert.deepEqual(applyStop(st, at), ['design']);
    assert.equal(st.status, 'stopped');
    assert.ok(Object.values(st.steps).every((s) => s.status === 'skipped'));
    assert.deepEqual(readySteps(st), []);
    assert.deepEqual(applyStop(st, at), []); // already stopped
  });

  it('summarises and hides step answers from the page view except a short preview', () => {
    const st = newFlowState('f1', recipe(), 'x', 'u1', at);
    markStarted(st, 'design', 'c1', at);
    applyStepResult(st, 'design', true, 'x'.repeat(2000), at);
    assert.match(flowSummary(st), /Flow feature-pipeline is running\.\n  ✓ design/);
    const view = publicFlow(st) as { steps: Array<{ id: string; resultPreview: string }> };
    assert.equal(view.steps[0].resultPreview.length, 300);
    assert.ok(!JSON.stringify(view).includes('x'.repeat(400)));
  });
});
