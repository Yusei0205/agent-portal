/**
 * Tells a cloud agent which browser to use.
 *
 * A session that has the AgentCore Browser gets its tools (goto, snapshot, get_text, screenshot, click, type), and the
 * portal's live browser view shows what they do. The runner has no Chrome of its own, so an agent that reaches for
 * Playwright (or installs a browser) fails or shows nothing in the live view. This line, added to the prompt of every
 * run that has the browser, makes the cloud browser the default.
 */

export const BROWSER_GUIDANCE = [
  'Browser: this session has a cloud browser, available as the browser tools (goto, snapshot, get_text, screenshot, click, type, wait_for_sign_in).',
  'Use them to work in a specific site: open a page, check a site, sign in, click through a web app or test a web UI. Do not use the browser to search the web (Google and other search engines block automated browsers): use your web search tool, as the Portal tools note says.',
  'If a page needs the person to sign in (a password, a one-time code, an approval) and you have no account for it, call wait_for_sign_in with a short message saying what to do, instead of ending your turn: ending it would leave the person to sign in and then tell you before you could carry on. They see the browser in the portal, sign in themselves and hand it back; never ask for or type their password. When it returns, check the page and carry on.',
  'To capture evidence (screenshots with numbered boxes) or to work in a named AWS account or environment, follow the agentcore-browser skill.',
  'Do not use Playwright, Puppeteer or Selenium and do not install or launch a browser yourself: none is available here, and the portal\'s live view only shows the browser tools.',
].join(' ');

/** The prompt, with the browser guidance added when the run has the cloud browser. */
export function withBrowserGuidance(prompt: string, browserOn: boolean, inlineSkill?: string): string {
  if (!browserOn) return prompt;
  // A session without a skills folder (Claude in the cloud) gets the browser skill as text; Kiro has it as a skill file.
  return `${prompt}\n\n${BROWSER_GUIDANCE}${inlineSkill ? `\n\nSkill "agentcore-browser":\n${inlineSkill}` : ''}`;
}
