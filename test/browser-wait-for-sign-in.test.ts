/**
 * wait_for_sign_in: the agent waits while a person signs in through Live View. The person is noticed in two ways: they pause the agent
 * (its commands are refused) and hand control back, or they sign in without pausing it (the password field goes away).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { browserToolSpecs, waitTuning, type AgentCoreBrowser } from '../agent-runner/src/browser-tools.ts';

type Seen = { pw: boolean; url: string };

/** A browser whose page answers from a script: each evaluate() returns the next step, or throws for 'refused'. */
function fakeBrowser(steps: Array<Seen | 'refused'>, events: string[]) {
  let i = 0;
  let reattached = 0;
  const page = {
    url: () => 'https://app.example.com/login',
    title: async () => 'Home',
    isClosed: () => false,
    evaluate: async (expression: string) => {
      // The check after a hand-back asks only "is a password field showing?"; the polling asks for the field and the address.
      if (!String(expression).includes('location.href')) { const last = steps[Math.min(i, steps.length) - 1]; return typeof last === 'object' ? last.pw : false; }
      const step = steps[Math.min(i++, steps.length - 1)];
      if (step === 'refused') throw new Error('automation stream is disabled');
      return step;
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  };
  const browser = {
    getPage: async () => page,
    currentPage: () => page,
    reattach: async () => { reattached++; return page; },
    publishFrame: async () => undefined,
    onWaiting: (w: { state: string; message: string }) => { events.push(`${w.state}:${w.message}`); },
  } as unknown as AgentCoreBrowser;
  return { browser, reattaches: () => reattached };
}

const LOGIN: Seen = { pw: true, url: 'https://app.example.com/login' };
const HOME: Seen = { pw: false, url: 'https://app.example.com/home' };
const tool = (b: AgentCoreBrowser) => browserToolSpecs(b, { manualSignIn: true }).find((t) => t.name === 'wait_for_sign_in')!;
const saved = { ...waitTuning };
afterEach(() => Object.assign(waitTuning, saved));

describe('wait_for_sign_in', () => {
  it('is offered only when the person signs in themselves', () => {
    const { browser } = fakeBrowser([LOGIN], []);
    assert.equal(browserToolSpecs(browser, {}).some((t) => t.name === 'wait_for_sign_in'), false);
    assert.equal(tool(browser).readOnly, false);
  });

  it('returns when the person has paused the agent and handed control back', async () => {
    Object.assign(waitTuning, { pollMs: 5, answerMs: 50, reattachMs: 0, settleMs: 0 });
    const events: string[] = [];
    const { browser, reattaches } = fakeBrowser([LOGIN, 'refused', 'refused', HOME], events);
    const r = await tool(browser).handler({ message: 'Sign in as an administrator' });
    assert.notEqual(r.isError, true);
    assert.match(String(r.content[0].type === 'text' && r.content[0].text), /finished signing in/);
    assert.deepEqual(events, ['waiting:Sign in as an administrator', 'done:Signed in.']);
    assert.ok(reattaches() >= 1, 'it reconnects to the same browser session after the pause');
  });

  it('says so when control comes back but the sign-in page is still showing', async () => {
    Object.assign(waitTuning, { pollMs: 5, answerMs: 50, reattachMs: 0, settleMs: 0 });
    const events: string[] = [];
    const { browser } = fakeBrowser([LOGIN, 'refused', LOGIN], events);
    const r = await tool(browser).handler({});
    assert.notEqual(r.isError, true);
    assert.match(String(r.content[0].type === 'text' && r.content[0].text), /sign-in page is still showing/);
    assert.equal(events.at(-1), 'done:Control handed back.');
  });

  it('notices a person who signs in without pausing the agent', async () => {
    Object.assign(waitTuning, { pollMs: 5, answerMs: 50, settleMs: 0 });
    const events: string[] = [];
    const { browser } = fakeBrowser([LOGIN, LOGIN, HOME, HOME], events);
    const r = await tool(browser).handler({});
    assert.notEqual(r.isError, true);
    assert.equal(events[0].startsWith('waiting:'), true);
    assert.equal(events.at(-1), 'done:Signed in.');
  });

  it('keeps waiting while the sign-in page is still showing, and gives up at the deadline', async () => {
    Object.assign(waitTuning, { pollMs: 5, answerMs: 50, settleMs: 0, timeScale: 0.00005 });
    const events: string[] = [];
    const { browser } = fakeBrowser([LOGIN], events);
    const r = await tool(browser).handler({ minutes: 1 });
    assert.equal(r.isError, true);
    assert.match(String(r.content[0].type === 'text' && r.content[0].text), /did not sign in/);
    assert.match(events.at(-1) ?? '', /^done:Timed out/);
  });
});
