/**
 * server/agent/browser-guidance.ts — a run that has the cloud browser is told to use it instead of Playwright.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_GUIDANCE, withBrowserGuidance } from '../server/agent/browser-guidance.ts';

describe('browser guidance', () => {
  it('adds the guidance after the prompt when the run has the cloud browser', () => {
    const out = withBrowserGuidance('Check the login page', true);
    assert.ok(out.startsWith('Check the login page\n\n'), 'the task comes first');
    assert.ok(out.endsWith(BROWSER_GUIDANCE));
  });

  it('leaves the prompt alone when there is no cloud browser', () => {
    assert.equal(withBrowserGuidance('Check the login page', false), 'Check the login page');
  });

  it('names the browser tools and rules out Playwright', () => {
    for (const tool of ['goto', 'snapshot', 'get_text', 'screenshot', 'click', 'type']) assert.ok(BROWSER_GUIDANCE.includes(tool), tool);
    assert.match(BROWSER_GUIDANCE, /Do not use Playwright/);
  });
});
