import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain JS module shared with the web app
import { deriveStages, isVerifyCall } from '../web/src/lib/execution-stages.js';

const call = (name: string, preview = '', file = '', at = 1, status = 'done') => ({ name, preview, file, at, status });
const states = (r: any) => r.stages.map((s: any) => s.state).join(',');

describe('execution stages', () => {
  it('shows every stage pending when nothing has run', () => {
    const r = deriveStages({ calls: [], files: [] }, { status: '' });
    assert.equal(states(r), 'pending,pending,pending,pending');
    assert.equal(r.current, -1);
  });

  it('is planning while the agent only reads', () => {
    const r = deriveStages({ calls: [call('Read', 'a.ts')], files: [] }, { status: 'running' });
    assert.equal(states(r), 'active,pending,pending,pending');
  });

  it('is planning in plan mode even after reading many files', () => {
    const r = deriveStages({ calls: [call('Read'), call('Edit', '', 'a.ts')], files: [{}] }, { status: 'running', planMode: true });
    assert.equal(r.current, 0);
  });

  it('moves to working once a file is written', () => {
    const r = deriveStages({ calls: [call('Read'), call('Edit', '', 'a.ts', 2)], files: [{}] }, { status: 'running' });
    assert.equal(states(r), 'done,active,pending,pending');
  });

  it('ignores a failed edit', () => {
    const r = deriveStages({ calls: [call('Edit', '', 'a.ts', 2, 'failed')], files: [] }, { status: 'running' });
    assert.equal(r.current, 0);
  });

  it('moves to checking only when verification follows the most recent edit', () => {
    const before = deriveStages({ calls: [call('Bash', 'npm test', '', 1), call('Edit', '', 'a.ts', 2)], files: [{}] }, { status: 'running' });
    assert.equal(before.current, 1);
    const after = deriveStages({ calls: [call('Edit', '', 'a.ts', 2), call('Bash', 'npx tsc --noEmit', '', 3)], files: [{}] }, { status: 'running' });
    assert.equal(states(after), 'done,done,active,pending');
    assert.equal(deriveStages({calls:[call('Edit','','a.ts',1),call('Bash','npm test','',2),call('Edit','','a.ts',3)],files:[{}]},{status:'running'}).current,1);
  });

  it('counts browser and connected-service research as work even with no changed files', () => {
    const c = {calls:[call('Running: @browser/screenshot'),call('Running: @google/search')],files:[]};
    assert.equal(deriveStages(c,{status:'running'}).current,1);
    assert.match(deriveStages(c,{status:'paused'}).reason,/Session paused.*does not require a file change/);
    assert.equal(deriveStages(c,{status:'running',planMode:true}).current,0);
    assert.match(deriveStages(c,{status:'running',planMode:true}).reason,/Plan mode is on/);
  });

  it('recognises read-only verification without demanding an edit', () => {
    assert.equal(deriveStages({calls:[call('functions.exec_command','npm test')],files:[]},{status:'running'}).current,2);
    assert.equal(deriveStages({calls:[call('Bash','which git')],files:[]},{status:'running'}).current,0);
  });

  it('is all done when the session is done, failed on the current stage when it failed, stopped when stopped', () => {
    const c = { calls: [call('Edit', '', 'a.ts')], files: [{}] };
    assert.equal(states(deriveStages(c, { status: 'done' })), 'done,done,done,done');
    assert.equal(deriveStages(c, { status: 'done' }).progress, 1);
    assert.equal(states(deriveStages(c, { status: 'failed' })), 'done,failed,pending,pending');
    assert.equal(states(deriveStages(c, { status: 'stopped' })), 'done,stopped,pending,pending');
  });

  it('recognises commands that check the work', () => {
    assert.equal(isVerifyCall(call('Bash', 'pytest -q')), true);
    assert.equal(isVerifyCall(call('Bash', 'ls -la')), false);
    assert.equal(isVerifyCall(call('Read', 'npm test')), false);
  });
});
