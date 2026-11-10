/**
 * Tells a cloud agent which browser to use.
 *
 * A session that has the AgentCore Browser gets its tools (goto, snapshot, get_text, screenshot, click, type), and the
 * portal's live browser view shows what they do. The runner has no Chrome of its own, so an agent that reaches for
 * Playwright (or installs a browser) fails or shows nothing in the live view. This line, added to the prompt of every
 * run that has the browser, makes the cloud browser the default.
 */

export const BROWSER_GUIDANCE = [
  'Browser: this session has a cloud browser, available as the browser tools (goto, snapshot, get_text, screenshot, click, type).',
  'Use them whenever you need to open a web page, check a site or test a web UI.',
  'Do not use Playwright, Puppeteer or Selenium and do not install or launch a browser yourself: none is available here, and the portal\'s live view only shows the browser tools.',
].join(' ');

/** The prompt, with the browser guidance added when the run has the cloud browser. */
export function withBrowserGuidance(prompt: string, browserOn: boolean): string {
  if (!browserOn) return prompt;
  return `${prompt}\n\n${BROWSER_GUIDANCE}`;
}
