// Browser walkthrough of every page in demo mode. Run with: npm run test:ui
// Set SCREENSHOT_DIR to keep screenshots of each step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium, type Page } from 'playwright';
import { FSD_MD, makeDocx, makeRepo } from '../fixtures.ts';

const shots = process.env.SCREENSHOT_DIR || '';
let step = 0;

async function shot(page: Page, name: string) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(shots, `${String(++step).padStart(2, '0')}-${name}.png`), fullPage: true });
}

/** file:/// address for a local path; Windows paths need forward slashes and three slashes. */
const fileUrl = (p: string) => `file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`;

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error(`UI check failed: ${msg}`);
  console.log(`  ok - ${msg}`);
}

/**
 * Open a rail group (e.g. 'Project setup') only when the submenu is not already
 * showing. When the submenu is visible the group button is behind an inert panel
 * and cannot be interacted with — we simply skip the click.
 */
async function openRailGroup(page: Page, name: string | RegExp) {
  const backBtn = page.getByRole('button', { name: 'Back', exact: true });
  // If the Back button is already visible the submenu is open; nothing to do.
  if (await backBtn.isVisible()) return;
  await page.getByRole('button', { name }).click();
}

/**
 * Close the currently-open rail submenu by clicking the Back button,
 * then wait for the main panel to become interactive again.
 * Call this before targeting a main-menu item (Sessions, Knowledge, etc.)
 * after navigating through a submenu.
 */
async function closeRailGroup(page: Page) {
  const backBtn = page.getByRole('button', { name: 'Back', exact: true });
  if (await backBtn.isVisible()) {
    await backBtn.click();
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ui-'));
  process.env.DATA_DIR = dataDir;
  process.env.DEMO_SPEED = process.env.DEMO_SPEED ?? '0.15';
  process.env.PORTAL_NO_AUTOSTART = '1';
  process.env.PORTAL_SECRET_KEY = 'ui-test-key';
  const { startServer } = await import('../../server/index.ts');
  const server = await startServer({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const errors: string[] = [];

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

  try {
    console.log('setup and projects');
    await page.goto(base);
    await page.getByRole('heading', { name: 'Create the admin account', exact: true }).waitFor();
    await shot(page, 'setup');
    await page.getByLabel('Your name').fill('Yusei');
    await page.getByLabel('Email').fill('yusei@example.com');
    await page.getByLabel('Password', { exact: true }).fill('a-long-password-1');
    await page.getByLabel('Repeat password').fill('a-long-password-1');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create your first project', exact: true }).click();
    await page.getByLabel('Name').fill('Refund service');
    await page.getByLabel('What is it about?').fill('Backend for card refunds, used by customer support.');
    await shot(page, 'new-project');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await page.getByRole('heading', { name: 'Knowledge', exact: true }).waitFor();
    check(page.url().includes('/knowledge'), 'lands on Knowledge after creating a project');
    // Extract the project ID from the URL now, so all navigation tests can use it.
    const pidFromUrl = /\/p\/([^/]+)\//.exec(page.url());
    const pid = pidFromUrl ? pidFromUrl[1] : '';

    console.log('knowledge');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-files-'));
    const fsd = path.join(tmp, 'Refunds FSD.md');
    fs.writeFileSync(fsd, FSD_MD);
    const tsd = path.join(tmp, 'Refunds TSD.docx');
    fs.writeFileSync(tsd, await makeDocx());
    await page.locator('input[type=file]').first().setInputFiles([fsd, tsd]);
    await page.getByRole('link', { name: 'Refunds TSD', exact: true }).waitFor();
    await page.waitForTimeout(400);
    await shot(page, 'documents');
    await page.getByLabel('Search documents').fill('finance manager');
    await page.locator('.results li').first().waitFor();
    check((await page.locator('.results mark').count()) > 0, 'search highlights matches');
    await shot(page, 'search');
    await page.locator('.results a').first().click();
    await page.locator('.doc-outline').waitFor();
    await shot(page, 'document-view');
    await page.getByText('← All documents').click();
    await page.getByRole('link', { name: 'Ask', exact: true }).click();
    await page.getByLabel('Ask anything about this project').fill('Who must approve refunds above 500 USD?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.locator('.answer .sources').waitFor();
    check((await page.locator('.sources li.is-cited').count()) > 0, 'answer cites sources');
    await shot(page, 'ask');
    await page.getByLabel('Ask anything about this project').fill('Which bank holiday calendar applies?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await page.getByRole('button', { name: 'Ask the team', exact: true }).click();
    await page.getByRole('link', { name: /Open questions/ }).click();
    await page.locator('.input-card').first().waitFor();
    await page.getByLabel(/Your answer to/).fill('Use the Malaysian federal holiday calendar.');
    await shot(page, 'open-question');
    await page.getByRole('button', { name: 'Send answer', exact: true }).click();
    await page.getByText('No open questions').waitFor();
    await page.getByRole('link', { name: 'Decisions log', exact: true }).click();
    await page.getByText('Malaysian federal holiday calendar').waitFor();
    check(true, 'answers land in the decisions log');

    console.log('builder');
    // Agents and skills — navigate directly via deep link (no more Project setup submenu).
    await closeRailGroup(page);
    await page.goto(`${base}/#/p/${pid}/builder`);
    await page.getByRole('heading', { name: 'Business analyst', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Business analyst', exact: true }).waitFor();
    for (const role of ['Business analyst', 'QA engineer', 'Technical writer and trainer']) {
      const card = page.locator('.role-card', { has: page.getByRole('heading', { name: role }) });
      await card.getByRole('button', { name: 'Add to project', exact: true }).click();
      await card.getByText('In use').waitFor();
    }
    await shot(page, 'roles');
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await page.getByRole('heading', { name: 'business-analyst', exact: true }).waitFor();
    await shot(page, 'agent-editor');
    await page.getByRole('link', { name: 'Skills', exact: true }).click();
    await page.locator('.editor-head h2').waitFor();
    await shot(page, 'skill-editor');
    // Kiro agents sit apart from the Claude Code ones.
    await page.getByRole('tab', { name: 'Kiro', exact: true }).click();
    await page.getByText('No Kiro agents yet').waitFor();
    await page.getByRole('button', { name: 'New agent', exact: true }).first().click();
    await page.getByLabel('Name').fill('kiro-reviewer');
    await page.getByLabel('Description').fill('Reviews changes');
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    await page.getByRole('heading', { name: 'kiro-reviewer', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'JSON', exact: true }).click();
    await page.getByLabel('Agent definition').waitFor();
    await shot(page, 'kiro-agent-editor');
    check((await page.getByLabel('Agent definition').inputValue()).includes('"description": "Reviews changes"'), 'a Kiro agent is created from the Kiro tab');
    await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();

    console.log('repositories');
    const bare = makeRepo(path.join(dataDir, 'fixture'));
    // Repositories — navigate directly (no more submenu).
    await page.goto(`${base}/#/p/${pid}/repos`);
    await page.getByRole('button', { name: 'Connect a repository', exact: true }).click();
    await page.getByRole('tab', { name: 'Other Git', exact: true }).click();
    await page.getByLabel('Repository address').fill(fileUrl(bare));
    await page.getByLabel('Display name (optional)').fill('refund-service');
    await page.getByRole('button', { name: 'Connect and clone', exact: true }).click();
    await page.locator('.repo .badge', { hasText: 'Ready' }).waitFor({ timeout: 20000 });
    await shot(page, 'repos');

    console.log('configuration');
    // Configuration — navigate directly.
    await page.goto(`${base}/#/p/${pid}/config`);
    await page.getByRole('button', { name: 'business-analyst.md', exact: true }).click();
    const editor = page.getByLabel('Contents of .claude/agents/business-analyst.md');
    await editor.waitFor();
    await editor.press('End');
    await editor.pressSequentially('\nAlways cite the FSD.');
    await page.keyboard.press('Control+s');
    await page.getByText('Saved .claude/agents/business-analyst.md').waitFor();
    check(true, 'an agent file can be edited and saved in Configuration');
    await shot(page, 'configuration');

    console.log('workspaces');
    // Workspaces is now in the main project menu (right after Sessions), not in Project setup.
    // Close the setup submenu first if it is open, then click the main-menu link.
    await closeRailGroup(page);
    await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
    await page.getByRole('button', { name: 'Create a workspace', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Refunds');
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await page.locator('.conn-card', { hasText: 'refund-service' }).waitFor();
    check(true, 'a workspace lists its repositories');

    console.log('single run (from Sessions)');
    // Sessions is on the main panel – no need to close a submenu.
    await page.getByRole('link', { name: 'Sessions', exact: true }).click();
    check((await page.getByRole('link', { name: 'Agent runs', exact: true }).count()) === 0, 'Agent runs is no longer in the menu');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByRole('tab', { name: 'Single run', exact: true }).click();
    await page.getByLabel('Goal', { exact: true }).fill('Design and build the refund approval flow for Finance Managers');
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    await page.getByLabel('Repository 1', { exact: true }).selectOption({ label: 'refund-service' });
    await shot(page, 'composer');
    await page.getByRole('button', { name: 'Start run', exact: true }).click();
    await page.waitForURL(/\/sessions\/run\//);
    const [, , singleRunId] = /\/p\/([^/]+)\/sessions\/run\/([^/?]+)/.exec(page.url())!;
    await page.locator('.pending .input-card').waitFor({ timeout: 20000 });
    await shot(page, 'run-question');
    await page.locator('.pending .choice', { hasText: 'New module' }).click();
    await page.locator('.pending .choice', { hasText: 'business-analyst' }).click();
    await page.locator('.pending .choice', { hasText: 'qa-engineer' }).click();
    await page.getByRole('button', { name: 'Send answer', exact: true }).click();
    await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor({ timeout: 20000 });
    check((await page.locator('.tnode-child').count()) >= 2, 'tree shows subagents');
    await shot(page, 'run-approval');
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await page.locator('.run-head .badge', { hasText: 'Completed' }).waitFor({ timeout: 20000 });
    await shot(page, 'run-done');
    await page.locator('.tnode-child .tnode-btn').first().click();
    await page.locator('.tl-brief').waitFor();
    await shot(page, 'run-subagent');
    await page.getByRole('button', { name: 'Files and changes', exact: true }).click();
    await page.locator('.diff-file').first().waitFor();
    await shot(page, 'run-changes');
    await page.getByRole('button', { name: 'Push changes', exact: true }).click();
    await page.getByRole('button', { name: 'Commit and push', exact: true }).click();
    await page.getByText(/Pushed commit/).waitFor();
    check(/agent\//.test(execFileSync('git', ['branch'], { cwd: bare }).toString()), 'push created a branch in the remote');
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
    await page.getByRole('tab', { name: 'Single runs', exact: true }).click();
    check((await page.locator('.ws-item.is-active').count()) === 1, 'the single run is listed and selected');

    console.log('session');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByLabel('Goal', { exact: true }).fill('Add a refund limit check for amounts above 500 [demo-iterations: 2]');
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    await page.getByLabel('Repository 1', { exact: true }).selectOption({ label: 'refund-service' });
    await page.getByRole('button', { name: 'Add context', exact: true }).click();
    await page.locator('.ctx-pick-row', { hasText: 'Refunds FSD' }).getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('tab', { name: 'Note', exact: true }).click();
    await page.getByLabel('Note', { exact: true }).fill('Amounts are stored in cents.');
    await page.getByRole('button', { name: 'Add note', exact: true }).click();
    await shot(page, 'context-picker');
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Add context for the agents' }).waitFor({ state: 'detached' });
    check(await page.getByRole('heading', { name: 'Start agent work' }).isVisible(), 'Escape closes only the top dialog');
    check((await page.locator('.ctx-chip').count()) === 2, 'picked context shows as chips in the New dialog');
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.locator('.ws-head').waitFor();
    await page.locator('.ws-item .ws-now').first().waitFor({ timeout: 20000 });
    check(true, 'the session list shows what a running session is doing right now');
    await page.locator('.ws-live').waitFor({ timeout: 20000 });
    await shot(page, 'session-live');
    await page.locator('.ws-head .badge', { hasText: 'Ready for review' }).waitFor({ timeout: 60000 });
    check((await page.locator('.ws-iter').count()) >= 2, 'iteration strip shows each iteration');
    // The list refreshes shortly after the session's own header does.
    await page.locator('.ws-group-head', { hasText: 'Ready for review' }).waitFor({ timeout: 5000 });
    check(true, 'the list groups the session under Ready for review');
    check((await page.locator('.ac-bubble').count()) >= 3, 'the canvas shows the main agent and its subagents as bubbles');
    await page.locator('.ac-bubble:not(.ac-main)').first().click();
    await page.locator('.ws-inspector .tl-brief').waitFor();
    check(true, 'clicking a bubble shows that agent’s brief and work in the inspector');
    await page.locator('.ac-main').focus();
    await page.keyboard.press('ArrowDown');
    check((await page.locator('.ac-bubble.is-selected:not(.ac-main)').count()) === 1, 'arrow keys move between agents');
    await shot(page, 'session-canvas');
    await page.getByRole('tab', { name: 'List', exact: true }).click();
    check((await page.locator('.ag-node').count()) >= 3, 'the list view shows the same agents');
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
    await page.locator('.ws-iter').first().click();
    await page.getByText('You are looking at an earlier iteration').waitFor();
    await shot(page, 'session-done');
    await page.getByRole('link', { name: 'Changes', exact: true }).click();
    await page.locator('.diff-file, .file-list li').first().waitFor({ timeout: 20000 });
    await shot(page, 'session-changes');
    await page.getByRole('link', { name: /^Context/ }).click();
    await page.locator('.ctx-item').first().waitFor();
    check((await page.locator('.ctx-item').count()) === 2, 'the Context tab lists what the session was started with');
    await page.getByRole('button', { name: 'Add context', exact: true }).click();
    await page.getByRole('tab', { name: 'Upload', exact: true }).click();
    await page.getByLabel('Files to attach').setInputFiles(fsd);
    await page.getByRole('button', { name: /^Done/ }).click();
    await page.locator('.ctx-item').nth(2).waitFor();
    check((await page.locator('.ctx-item', { hasText: /File · work\/sessions\// }).count()) === 1, 'files can be attached from the Context tab');
    await shot(page, 'session-context');
    await page.getByLabel('Instruction for the agents').fill('Also cover an amount of exactly 500.');
    await page.getByRole('button', { name: 'Send and continue', exact: true }).click();
    await page.getByRole('link', { name: 'History', exact: true }).click();
    await page.locator('.wf-human', { hasText: 'exactly 500' }).waitFor();
    check(true, 'instructions show in the history');
    await page.getByRole('button', { name: 'Delegate a task', exact: true }).click();
    await page.getByLabel('Task', { exact: true }).fill('Write the release notes for the refund limit [demo-iterations: 1]');
    await page.getByRole('button', { name: 'Start delegated session', exact: true }).click();
    await page.locator('.ws-family', { hasText: 'delegated by' }).waitFor();
    check(true, 'a delegated session shows where it came from');
    await page.locator('.ws-family a').first().click();
    await page.locator('.ws-child').first().waitFor();
    check(true, 'the parent lists its delegated sessions');
    await shot(page, 'session-delegated');

    console.log('agent push');
    await page.getByRole('link', { name: 'New', exact: true }).click();
    await page.getByLabel('Goal', { exact: true }).fill('Ship [demo-push] [demo-branch: feature/ui-agent-push] [demo-iterations: 1]');
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    await page.getByText('More options', { exact: true }).click();
    await page.getByLabel('Agent pushes').selectOption('ask');
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await page.getByRole('button', { name: 'Allow push', exact: true }).waitFor({ timeout: 60000 });
    check((await page.locator('.push-request', { hasText: 'feature/ui-agent-push' }).count()) === 1, 'the session asks before the agents push');
    await shot(page, 'agent-push-request');
    await page.getByRole('button', { name: 'Allow push', exact: true }).click();
    await page.locator('.ws-head .badge', { hasText: 'Ready for review' }).waitFor({ timeout: 30000 });
    check(execFileSync('git', ['branch'], { cwd: bare }).toString().includes('feature/ui-agent-push'), 'allowing pushes the branch to the remote');

    console.log('old links');
    await page.goto(`${base}/#/p/${pid}/runs/${singleRunId}`);
    await page.waitForURL(new RegExp(`/sessions/run/${singleRunId}`));
    check(true, 'an old Agent runs link opens the run under Sessions');

    console.log('code review');
    await page.getByRole('link', { name: 'Code review', exact: true }).click();
    await page.getByRole('button', { name: 'Review a branch', exact: true }).click();
    await page.getByLabel('Changes on').selectOption('feature/refund-api');
    await page.getByText('Deep look at risky files').click();
    await page.getByRole('button', { name: 'Start review', exact: true }).click();
    await page.locator('.finding').first().waitFor({ timeout: 20000 });
    check((await page.locator('.finding.sev-critical').count()) > 0, 'review shows a critical finding inline');
    await shot(page, 'review');
    await page.locator('.finding').first().getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.locator('.finding.is-dismissed').first().waitFor({ state: 'detached' }).catch(() => undefined);

    console.log('learn');
    await page.getByRole('link', { name: 'Learn', exact: true }).click();
    await page.getByRole('button', { name: 'Write a document', exact: true }).click();
    await page.getByLabel('Title').fill('How refunds work');
    await page.getByRole('button', { name: 'Write it', exact: true }).click();
    await page.getByRole('button', { name: 'Approve and publish', exact: true }).waitFor({ timeout: 20000 });
    await page.locator('.mermaid-ok').first().waitFor({ timeout: 20000 }).catch(() => undefined);
    await shot(page, 'learn-business');
    await page.getByRole('tab', { name: 'For engineers', exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, 'learn-technical');
    await page.getByRole('button', { name: 'Approve and publish', exact: true }).click();
    await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Make a quiz from this', exact: true }).click();
    await page.getByRole('button', { name: 'Make quiz', exact: true }).click();
    await page.locator('.q-review li').first().waitFor({ timeout: 20000 });
    await shot(page, 'quiz-review');
    await page.getByRole('button', { name: 'Approve and publish', exact: true }).click();
    await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Take quiz', exact: true }).click();
    const qs = page.locator('.take > li');
    const n = await qs.count();
    for (let i = 0; i < n; i++) await qs.nth(i).locator('.choice').first().click();
    await page.getByRole('button', { name: 'Check my answers', exact: true }).click();
    await page.locator('.score').waitFor();
    await shot(page, 'quiz-result');
    await page.getByRole('link', { name: '← Quizzes', exact: true }).click();
    await page.getByRole('link', { name: 'Onboarding paths', exact: true }).click();
    await page.getByRole('button', { name: 'Path for everyone', exact: true }).click();
    await page.locator('.steps').waitFor();
    await shot(page, 'path');

    console.log('connections');
    await page.goto(`${base}/#/connections`);
    await page.getByRole('heading', { name: 'Repository connections', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New connection', exact: true }).click();
    await page.getByRole('tab', { name: 'Other Git server', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Team GitLab');
    await page.getByLabel('Server address').fill('https://gitlab.example.com');
    await page.getByLabel('Username', { exact: true }).fill('agent');
    await page.getByLabel('Token', { exact: true }).fill('glpat-example-0001');
    await page.getByRole('button', { name: 'Save and test', exact: true }).click();
    await page.locator('.conn-card', { hasText: 'Team GitLab' }).waitFor();
    check((await page.locator('.conn-card', { hasText: '…0001' }).count()) === 1, 'a new connection shows only the last characters of its token');
    await shot(page, 'connections');

    console.log('integrations');
    await page.goto(`${base}/#/integrations`);
    await page.getByRole('heading', { name: 'Integrations', exact: true }).waitFor();
    await page.getByRole('button', { name: /Custom MCP \(command\)/ }).click();
    await page.getByLabel('Name', { exact: true }).fill('Local tools');
    await page.getByLabel('Command', { exact: true }).fill(process.execPath);
    await page.getByLabel('Arguments', { exact: true }).fill(path.join(import.meta.dirname, '..', 'fake-mcp.mjs'));
    await page.getByRole('button', { name: 'Save and test', exact: true }).click();
    await page.locator('.conn-card', { hasText: 'Local tools' }).locator('.badge', { hasText: 'Working' }).waitFor({ timeout: 30000 });
    check((await page.locator('.conn-card', { hasText: 'Read-only' }).count()) === 1, 'a new integration is read-only and passes its MCP handshake');
    await shot(page, 'integrations');

    console.log('api access');
    await page.goto(`${base}/#/api`);
    await page.getByRole('heading', { name: 'API access', exact: true }).waitFor();
    await page.getByLabel('Token name').fill('Smoke test');
    await page.getByRole('button', { name: 'Create token', exact: true }).click();
    const shown = await page.locator('.api-token').textContent();
    check(/^ap_/.test(shown ?? ''), 'a new token is shown once');
    const listed = await page.locator('.table:not(.api-table)').textContent();
    check(!(listed ?? '').includes(shown ?? 'x'), 'the token list shows only its beginning');
    await shot(page, 'api-access');

    console.log('vault');
    await page.goto(`${base}/#/vault`);
    await page.getByRole('heading', { name: 'Vault', exact: true }).waitFor();
    await page.getByLabel('Files to upload').setInputFiles(fsd);
    await page.locator('.vault-files', { hasText: 'Refunds FSD.md' }).waitFor();
    check(true, 'a file can be added to the vault');
    await shot(page, 'vault');

    console.log('settings and mobile');
    await page.goto(`${base}/#/settings`);
    await page.getByRole('heading', { name: 'Model provider', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Test connection', exact: true }).click();
    await page.getByText(/Connected/).waitFor();
    await shot(page, 'settings');

    console.log('project setup hub');
    await page.goto(`${base}/#/p/${pid}/setup`);
    await page.getByRole('heading', { name: 'Project setup', exact: true }).waitFor();
    await page.getByRole('region', { name: 'Project readiness' }).waitFor();
    check((await page.locator('.readiness-table tr').count()) >= 2, 'readiness panel shows items');
    await shot(page, 'setup-hub');

    console.log('admin panel');
    await page.goto(`${base}/#/admin`);
    await page.getByRole('heading', { name: 'Admin', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Users', exact: true }).click();
    await page.getByRole('heading', { name: 'Users', exact: true }).waitFor();
    check((await page.locator('table tr').count()) >= 1, 'admin users table is shown');
    await shot(page, 'admin-users');
    await page.getByRole('button', { name: 'Audit log', exact: true }).click();
    await page.getByRole('heading', { name: 'Audit log', exact: true }).waitFor();
    await shot(page, 'admin-audit');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#/projects`);
    await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor();
    await shot(page, 'mobile-projects');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await shot(page, 'mobile-menu');
    await page.goto(`${base}/#/p/${pid}/sessions`);
    await page.locator('.ws-item').first().click();
    await page.locator('.ws-head').waitFor();
    await shot(page, 'mobile-session');
    const overflow = (await page.evaluate('document.documentElement.scrollWidth')) as number - page.viewportSize()!.width;
    check(overflow <= 1, `a session fits a phone screen without sideways scrolling (${overflow}px over)`);

    check(errors.length === 0, `no browser errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    console.log('UI smoke test passed');
  } catch (e) {
    await shot(page, 'failure');
    console.error(errors.join('\n'));
    throw e;
  } finally {
    await browser.close();
    await new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
