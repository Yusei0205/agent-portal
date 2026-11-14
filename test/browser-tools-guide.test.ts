/**
 * The browser tools a user guide run gets: capture and sign_in are offered only when the runner passes what they need, and a
 * sign_in description names roles but never a username or password.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { browserToolSpecs, type AgentCoreBrowser, type GuideKit } from '../agent-runner/src/browser-tools.ts';

const browser = {
  getPage: async () => ({ waitForLoadState: async () => undefined, waitForTimeout: async () => undefined, screenshot: async () => Buffer.alloc(20_000), url: () => 'https://app.example.com/' }),
  publishFrame: async () => undefined,
} as unknown as AgentCoreBrowser;

const kit: GuideKit = {
  capture: async (_page, workDir, args) => (args.file === 'screenshots/ok.png' ? { ok: true, png: Buffer.from([1, 2, 3]) } : { ok: false, error: `bad file in ${workDir}` }),
  summary: () => 'Saved screenshots/ok.png',
  signIn: async (_page, state, args) => ({ ok: state.accounts.length > 0 && (args as { role?: string }).role === 'Admin', message: 'Submitted the sign-in form for the "Admin" account.' }),
};

const names = (o?: Parameters<typeof browserToolSpecs>[1]) => browserToolSpecs(browser, o).map((t) => t.name);

describe('browser tools for a user guide', () => {
  it('offers capture and sign_in only when the run gives what they need', () => {
    const base = ['goto', 'snapshot', 'get_text', 'screenshot', 'click', 'type'];
    assert.deepEqual(names(), base);
    assert.deepEqual(names({ workDir: '/work' }), base, 'no kit: nothing to capture with');
    assert.deepEqual(names({ workDir: '/work', kit }), [...base, 'capture']);
    assert.deepEqual(names({ workDir: '/work', kit, accounts: [{ role: 'Admin', username: 'a@t.example', password: 'S3cret!' }] }), [...base, 'capture', 'sign_in']);
    assert.deepEqual(names({ kit, accounts: [{ role: 'Admin', username: 'a', password: 'p' }] }), [...base, 'sign_in']);
  });

  it('describes sign_in with the roles, never the username or password', () => {
    const specs = browserToolSpecs(browser, { workDir: '/work', kit, accounts: [{ role: 'Admin', username: 'admin@t.example', password: 'S3cret-Admin!' }, { role: 'Clerk', username: 'clerk@t.example', password: 'Clerk-Pw' }] });
    const tool = specs.find((t) => t.name === 'sign_in')!;
    assert.match(tool.description, /Admin, Clerk/);
    assert.doesNotMatch(JSON.stringify({ d: tool.description, s: Object.keys(tool.shape) }), /S3cret|Clerk-Pw|admin@t|clerk@t/);
    assert.equal(tool.readOnly, false);
    assert.equal(specs.find((t) => t.name === 'capture')!.readOnly, false);
  });

  it('capture returns the summary and the picture, and a refusal as an error', async () => {
    const capture = browserToolSpecs(browser, { workDir: '/work', kit }).find((t) => t.name === 'capture')!;
    const ok = await capture.handler({ file: 'screenshots/ok.png' }) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    assert.deepEqual(ok.content.map((c) => c.type), ['text', 'image']);
    assert.equal(ok.content[0].text, 'Saved screenshots/ok.png');
    const bad = await capture.handler({ file: '../x.png' }) as { content: Array<{ text?: string }>; isError?: boolean };
    assert.equal(bad.isError, true);
    assert.match(String(bad.content[0].text), /bad file in \/work/);
  });

  it('sign_in passes the role on, and reports a refusal as an error', async () => {
    const accounts = [{ role: 'Admin', username: 'a', password: 'p' }];
    const signIn = browserToolSpecs(browser, { kit, accounts, hosts: ['example.com'] }).find((t) => t.name === 'sign_in')!;
    const ok = await signIn.handler({ role: 'Admin' }) as { content: Array<{ text?: string }>; isError?: boolean };
    assert.notEqual(ok.isError, true);
    assert.match(String(ok.content[0].text), /Submitted the sign-in form/);
    const refused = await signIn.handler({ role: 'Nobody' }) as { isError?: boolean };
    assert.equal(refused.isError, true);
  });
});
