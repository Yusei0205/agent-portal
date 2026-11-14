/**
 * Browser tools for the Claude run, backed by the managed Amazon Bedrock AgentCore Browser.
 *
 * The browser is started lazily on the first tool call (a run that never browses costs nothing) and stopped when
 * the run ends. Playwright drives it over the CDP WebSocket that StartBrowserSession returns; that URL needs
 * SigV4 headers from the runtime's execution role (it must allow bedrock-agentcore:*BrowserSession* and
 * ConnectBrowserAutomationStream).
 *
 * The tools are exposed to the Claude Agent SDK as an in-process MCP server named "browser", so the model sees
 * them as mcp__browser__goto, mcp__browser__snapshot, etc.
 */

import { BedrockAgentCoreClient, GetBrowserSessionCommand, StartBrowserSessionCommand, StopBrowserSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { z } from 'zod';
import type { Browser, Page } from 'playwright-core';

export const BROWSER_SERVER_NAME = 'browser';
/** Managed browser with no custom configuration. A custom browser (recording, VPC) can be set per runtime. */
const DEFAULT_BROWSER_ID = 'aws.browser.v1';
const MAX_TEXT_CHARS = 20_000;
const ACTION_TIMEOUT_MS = 15_000;
/** Largest live-view picture (base64 characters) sent to the portal; it is stored with the session's events. */
const MAX_FRAME_BASE64 = 250_000;

export interface BrowserFrame { url: string; jpegBase64: string }

/** The AgentCore browser session in use: the portal signs a Live View URL for it. */
export interface BrowserSessionInfo { browserId: string; sessionId: string; width: number; height: number }
const VIEWPORT = { width: 1280, height: 800 };

type EmitFn = (event: Record<string, unknown>) => void;
type ToolResult = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkModule = Record<string, any>;

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t.length > MAX_TEXT_CHARS ? `${t.slice(0, MAX_TEXT_CHARS)}\n…[truncated ${t.length - MAX_TEXT_CHARS} characters]` : t }] };
}

function fail(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text', text: `Browser error: ${msg.split('\n')[0]}` }], isError: true };
}

/** Only http(s): the browser must not be pointed at file:, chrome: or other local schemes. */
export function assertWebUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`Not a valid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https URLs can be opened');
  return u.toString();
}

export class AgentCoreBrowser {
  private client: BedrockAgentCoreClient;
  private region: string;
  private sessionId: string | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private starting: Promise<Page> | null = null;
  /** Receives a small picture of the page after each action, for the portal's live Browser view (never shown to the model). */
  onFrame: ((f: BrowserFrame) => void) | null = null;
  /** Called once the browser session exists (so a person can watch and take over through AgentCore Live View). */
  onSession: ((s: BrowserSessionInfo) => void) | null = null;
  /** Called when the agent starts or stops waiting for a person to use the browser (sign in) through Live View. */
  onWaiting: ((w: { state: 'waiting' | 'done'; message: string }) => void) | null = null;
  /** How long the cloud browser may live. A run that waits for a person to sign in needs more than the default. */
  sessionTimeoutSeconds = 900;

  constructor(private emit: EmitFn, region: string, private browserId = DEFAULT_BROWSER_ID) {
    this.region = region;
    this.client = new BedrockAgentCoreClient({ region });
  }

  /** Headers that authorise the automation WebSocket (SigV4 over the equivalent https URL). */
  private async signedHeaders(wsUrl: string): Promise<Record<string, string>> {
    const u = new URL(wsUrl);
    const signer = new SignatureV4({
      credentials: fromNodeProviderChain(),
      region: this.region,
      service: 'bedrock-agentcore',
      sha256: Sha256,
    });
    const signed = await signer.sign(new HttpRequest({
      method: 'GET',
      protocol: 'https:',
      hostname: u.hostname,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: { host: u.hostname },
    }));
    return signed.headers as Record<string, string>;
  }

  private async start(): Promise<Page> {
    const { chromium } = await import('playwright-core');
    const res = await this.client.send(new StartBrowserSessionCommand({
      browserIdentifier: this.browserId,
      name: 'agent-portal-run',
      sessionTimeoutSeconds: this.sessionTimeoutSeconds,
      viewPort: VIEWPORT,
    }));
    this.sessionId = res.sessionId ?? null;
    const wsUrl = res.streams?.automationStream?.streamEndpoint;
    if (!this.sessionId || !wsUrl) throw new Error('AgentCore did not return a browser automation endpoint');
    this.emit({ type: 'status', text: 'Browser session started' });
    try { this.onSession?.({ browserId: this.browserId, sessionId: this.sessionId, ...VIEWPORT }); } catch { /* optional */ }

    this.browser = await chromium.connectOverCDP(wsUrl, { headers: await this.signedHeaders(wsUrl) });
    const ctx = this.browser.contexts()[0] ?? await this.browser.newContext();
    this.page = ctx.pages()[0] ?? await ctx.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return this.page;
  }

  /** The current page, starting the browser on first use. */
  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.starting ??= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** The page of the open session, or null: unlike getPage() this never starts a browser. */
  currentPage(): Page | null {
    return this.page && !this.page.isClosed() ? this.page : null;
  }

  /**
   * Connects again to the session that is already open (same pages, same sign-in). Needed after a person has used Live View with the
   * agent's control paused, when the automation connection may have been dropped.
   */
  async reattach(): Promise<Page> {
    if (!this.sessionId) throw new Error('No browser session is open');
    const res = await this.client.send(new GetBrowserSessionCommand({ browserIdentifier: this.browserId, sessionId: this.sessionId }));
    const wsUrl = res.streams?.automationStream?.streamEndpoint;
    if (!wsUrl) throw new Error('The browser session has no automation endpoint');
    const old = this.browser;
    this.browser = await (await import('playwright-core')).chromium.connectOverCDP(wsUrl, { headers: await this.signedHeaders(wsUrl) });
    try { await old?.close(); } catch { /* the old connection is already gone */ }
    const ctx = this.browser.contexts()[0] ?? await this.browser.newContext();
    this.page = ctx.pages()[0] ?? await ctx.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    return this.page;
  }

  /** Sends the live view a picture of the current page. Best effort: a failure here never fails a tool call. */
  async publishFrame(): Promise<void> {
    const page = this.page;
    if (!this.onFrame || !page || page.isClosed()) return;
    try {
      for (const quality of [55, 30]) {
        const jpg = await page.screenshot({ type: 'jpeg', quality, timeout: 5_000 });
        const b64 = jpg.toString('base64');
        if (b64.length <= MAX_FRAME_BASE64) { this.onFrame({ url: page.url(), jpegBase64: b64 }); return; }
      }
    } catch { /* the live view is optional */ }
  }

  /** Always call when the run ends: a forgotten session keeps billing until its timeout. */
  async close(): Promise<void> {
    const browser = this.browser;
    const sessionId = this.sessionId;
    this.browser = null; this.page = null; this.sessionId = null;
    try { await browser?.close(); } catch { /* already gone */ }
    if (sessionId) {
      try {
        await this.client.send(new StopBrowserSessionCommand({ browserIdentifier: this.browserId, sessionId }));
      } catch { /* session may already have expired */ }
    }
  }
}

/** One page, so calls run one at a time even when the model issues several in parallel. */
let queue: Promise<unknown> = Promise.resolve();
/**
 * Let a page finish loading and painting before it is read or photographed. A page that renders with JavaScript (a sign-in page, an
 * app) is empty at `domcontentloaded`, so a screenshot taken right after opening it was a blank white image. Each wait is best effort
 * and short: a page that never goes quiet (a stream, a poll) is used as it is.
 */
export async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
  await page.waitForTimeout(400).catch(() => {});
}

/** A PNG this small is a blank page (a full-size white page is about 5 KB; a page with content is far larger). */
const BLANK_PNG_BYTES = 12_000;

function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const run = queue.then(async () => {
    try { return await fn(); } catch (e) { return fail(e); }
  });
  queue = run.catch(() => undefined);
  return run;
}

export interface BrowserToolSpec {
  name: string;
  description: string;
  /** zod raw shape for the arguments */
  shape: z.ZodRawShape;
  readOnly: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<ToolResult>;
}

/**
 * What a run adds to the browser tools. `workDir` turns on `capture` (screenshots saved for a document); `accounts` turns on
 * `sign_in` (the agent names a role, the runner types the test account's username and password, and only on `hosts`).
 */
export interface BrowserToolOptions {
  workDir?: string;
  accounts?: Array<{ role: string; username: string; password: string }>;
  hosts?: string[];
  /** Offer `wait_for_sign_in`: the person signs in themselves through Live View while the agent waits. */
  manualSignIn?: boolean;
  /**
   * The capture and sign-in code (shared/runner-browser-capture.ts), passed in by the runner entry point that has that folder: this
   * file is also type-checked on its own by the portal's tests, where the copy does not exist.
   */
  kit?: GuideKit;
}

export interface GuideKit {
  capture(page: unknown, workDir: string, args: { file?: unknown; highlights?: unknown; full_page?: unknown }): Promise<{ ok: true; png: Buffer } | { ok: false; error: string }>;
  summary(result: any): string;
  signIn(page: unknown, state: { accounts: Array<{ role: string; username: string; password: string }>; hosts: string[] }, args: unknown): Promise<{ ok: boolean; message: string }>;
}

/** The browser tools, independent of how they are served (Claude SDK in-process MCP, or a stdio MCP for Kiro). */
export function browserToolSpecs(browser: AgentCoreBrowser, options: BrowserToolOptions = {}): BrowserToolSpec[] {
  const specs: BrowserToolSpec[] = [
    {
      name: 'goto', readOnly: true,
      description: 'Open a web page (http or https) in the cloud browser and return its title and address.',
      shape: { url: z.string().describe('Full URL, e.g. https://example.com') },
      handler: ({ url }: { url: string }) => guarded(async () => {
        const page = await browser.getPage();
        await page.goto(assertWebUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await settlePage(page);
        await browser.publishFrame();
        return text(`Opened ${page.url()}
Title: ${await page.title()}`);
      }),
    },
    {
      name: 'snapshot', readOnly: true,
      description: 'Return the current page as an accessibility tree (roles, names, links, fields). Use it to decide what to click or type.',
      shape: {},
      handler: () => guarded(async () => {
        const page = await browser.getPage();
        return text(`URL: ${page.url()}
${await page.locator('body').ariaSnapshot()}`);
      }),
    },
    {
      name: 'get_text', readOnly: true,
      description: 'Return the visible text of the current page, or of one element when a selector is given.',
      shape: { selector: z.string().optional().describe('CSS selector; omit for the whole page') },
      handler: ({ selector }: { selector?: string }) => guarded(async () => {
        const page = await browser.getPage();
        return text(await page.locator(selector || 'body').first().innerText());
      }),
    },
    {
      name: 'screenshot', readOnly: true,
      description: 'Take a PNG screenshot of the current page.',
      shape: { full_page: z.boolean().optional().describe('Capture the whole scrollable page') },
      handler: ({ full_page }: { full_page?: boolean }) => guarded(async () => {
        const page = await browser.getPage();
        await settlePage(page);
        let png = await page.screenshot({ fullPage: !!full_page, type: 'png' });
        // Still blank: the page paints late. Give it more time once, then take what is there.
        if (png.length < BLANK_PNG_BYTES) {
          await page.waitForTimeout(2_000).catch(() => {});
          png = await page.screenshot({ fullPage: !!full_page, type: 'png' });
        }
        return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
      }),
    },
    {
      name: 'click', readOnly: false,
      description: 'Click an element, given a CSS selector or its visible text.',
      shape: {
        selector: z.string().optional().describe('CSS selector'),
        text: z.string().optional().describe('Visible text of the element, used when no selector is given'),
      },
      handler: ({ selector, text: label }: { selector?: string; text?: string }) => guarded(async () => {
        if (!selector && !label) throw new Error('Give a selector or text');
        const page = await browser.getPage();
        await (selector ? page.locator(selector) : page.getByText(label!, { exact: false })).first().click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await settlePage(page);
        await browser.publishFrame();
        return text(`Clicked. Now at ${page.url()}`);
      }),
    },
    {
      name: 'type', readOnly: false,
      description: 'Type text into a field. Set submit to press Enter afterwards.',
      shape: {
        selector: z.string().describe('CSS selector of the input'),
        text: z.string().describe('Text to enter'),
        submit: z.boolean().optional().describe('Press Enter after typing'),
      },
      handler: ({ selector, text: value, submit }: { selector: string; text: string; submit?: boolean }) => guarded(async () => {
        const page = await browser.getPage();
        const el = page.locator(selector).first();
        await el.fill(value);
        if (submit) {
          await el.press('Enter');
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await settlePage(page);
        }
        await browser.publishFrame();
        return text(`Typed into ${selector}${submit ? ' and submitted' : ''}. Now at ${page.url()}`);
      }),
    },
  ];
  const workDir = options.workDir;
  const kit = options.kit;
  if (workDir && kit) {
    specs.push({
      name: 'capture', readOnly: false,
      description: 'Take a screenshot of the current page and save it as a PNG under screenshots/ in the run folder, to put in a document. '
        + 'To show the reader what to use, pass highlights: each is the CSS selector or the visible text of an element (plus an optional label), and gets a red box and a number (1, 2, 3 in the order given), so give them in the order of the steps. '
        + 'Every highlight must be on the page, or nothing is saved. Returns the file name and what each number marks; insert the file with a Markdown image.',
      shape: {
        file: z.string().describe('File name, e.g. screenshots/03-add-user.png'),
        highlights: z.array(z.object({
          selector: z.string().optional().describe('CSS selector of the element'),
          text: z.string().optional().describe('Visible text of the element, used when there is no selector'),
          label: z.string().optional().describe('Short name of what the element is, e.g. "Save button"'),
        })).optional().describe('Elements to box and number, in step order'),
        full_page: z.boolean().optional().describe('Capture the whole scrollable page instead of the visible part'),
      },
      handler: (args: { file: string; highlights?: unknown; full_page?: boolean }) => guarded(async () => {
        const page = await browser.getPage();
        await settlePage(page);
        const r = await kit.capture(page, workDir, args);
        if (!r.ok) throw new Error(r.error);
        await browser.publishFrame();
        return { content: [{ type: 'text', text: kit.summary(r) }, { type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' }] };
      }),
    });
  }
  const accounts = options.accounts ?? [];
  if (kit && accounts.length) {
    specs.push({
      name: 'sign_in', readOnly: false,
      description: `Sign in to the system with one of its test accounts. Open the system's sign-in page first, then name the role (${accounts.map((a) => a.role).join(', ')}); `
        + 'the username and password are typed for you and you never see them. It works only on the system\'s own address. Check the page afterwards to see that you are signed in.',
      shape: {
        role: z.string().optional().describe(`The account to use: ${accounts.map((a) => a.role).join(', ')}`),
        username_selector: z.string().optional().describe('CSS selector of the username field, if it is not found on its own'),
        password_selector: z.string().optional().describe('CSS selector of the password field, if it is not found on its own'),
        submit_selector: z.string().optional().describe('CSS selector of the sign-in button, if Enter does not submit'),
      },
      handler: (args: { role?: string; username_selector?: string; password_selector?: string; submit_selector?: string }) => guarded(async () => {
        const page = await browser.getPage();
        const r = await kit.signIn(page, { accounts, hosts: options.hosts ?? [] }, args);
        await browser.publishFrame();
        if (!r.ok) throw new Error(r.message);
        return text(r.message);
      }),
    });
  }
  if (options.manualSignIn) {
    specs.push({
      name: 'wait_for_sign_in', readOnly: false,
      description: 'Ask the person to sign in to the system themselves, then wait. Call it when you are on a sign-in page and have no stored account for it (or the sign-in needs a code only the person has). '
        + 'The person sees the browser in the portal, signs in, and hands control back; the call returns when they have. You never see what they typed. Give a short message saying which system and, if known, which kind of user to sign in as.',
      shape: {
        message: z.string().optional().describe('What the person should do, e.g. "Sign in as an administrator"'),
        minutes: z.number().optional().describe('How long to wait, 1 to 10 (default 10)'),
      },
      handler: (args: { message?: string; minutes?: number }) => guarded(() => waitForPerson(browser, args)),
    });
  }
  return specs;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Timings of waitForPerson (milliseconds); a test makes them short. */
export const waitTuning = { pollMs: 2_000, answerMs: 4_000, reattachMs: 6_000, settleMs: 4_000, timeScale: 1 };

/**
 * Waits until the person has signed in. While they use Live View with the agent paused, the browser refuses the agent's commands; when
 * they hand control back, the commands work again (after a reconnect if the connection was dropped), and that is the signal. A person
 * who signs in without pausing the agent is noticed too: the password field has gone, or the page has moved on from the sign-in page.
 */
export async function waitForPerson(browser: AgentCoreBrowser, args: { message?: string; minutes?: number }): Promise<ToolResult> {
  const page0 = await browser.getPage();
  const minutes = Math.min(10, Math.max(1, Math.round(Number(args.minutes) || 10)));
  const message = (args.message || 'Sign in to the system in the browser, then hand control back.').slice(0, 300);
  const startUrl = page0.url();
  const deadline = Date.now() + minutes * 60_000 * waitTuning.timeScale;
  const startedAt = Date.now();
  browser.onWaiting?.({ state: 'waiting', message });
  let paused = false;
  let seenPassword = false;
  let quiet = 0;
  let lastReattach = 0;
  try {
    while (Date.now() < deadline) {
      await sleep(waitTuning.pollMs);
      let seen: { pw: boolean; url: string } | null = null;
      try {
        const p = browser.currentPage();
        if (!p) throw new Error('page closed');
        seen = await Promise.race([
          p.evaluate("({ pw: [...document.querySelectorAll('input[type=password]')].some((e) => e.offsetParent !== null), url: location.href })") as Promise<{ pw: boolean; url: string }>,
          sleep(waitTuning.answerMs).then(() => { throw new Error('no answer'); }),
        ]);
      } catch {
        paused = true; // the person has the browser: the agent's commands are refused
        if (Date.now() - lastReattach > waitTuning.reattachMs) { lastReattach = Date.now(); await browser.reattach().catch(() => undefined); }
        continue;
      }
      if (paused) { quiet = 99; break; }
      if (seen.pw) { seenPassword = true; quiet = 0; continue; }
      const moved = seen.url !== startUrl;
      quiet = (seenPassword || moved) && Date.now() - startedAt > waitTuning.settleMs ? quiet + 1 : 0;
      if (quiet >= 2) break;
    }
    if (quiet < 2) {
      browser.onWaiting?.({ state: 'done', message: 'Timed out waiting for the person to sign in.' });
      return { content: [{ type: 'text', text: `The person did not sign in within ${minutes} minutes. Document what can be seen without signing in, and say which parts need a sign-in.` }], isError: true };
    }
    const page = await browser.getPage();
    await settlePage(page);
    await browser.publishFrame();
    const stillLogin = await page.evaluate("[...document.querySelectorAll('input[type=password]')].some((e) => e.offsetParent !== null)").catch(() => false);
    browser.onWaiting?.({ state: 'done', message: stillLogin ? 'Control handed back.' : 'Signed in.' });
    if (stillLogin) return text(`Control is back, but the sign-in page is still showing at ${page.url()}, so the person may not have signed in. Look at the page; call wait_for_sign_in again if it still asks for a sign-in.`);
    return text(`The person finished signing in. Now at ${page.url()}\nTitle: ${await page.title()}. Check the page to see who is signed in.`);
  } catch (e) {
    browser.onWaiting?.({ state: 'done', message: 'Stopped waiting.' });
    throw e;
  }
}

/** Builds the in-process MCP server config for sdk.query({ options: { mcpServers } }). */
export function createBrowserMcpServer(sdk: SdkModule, browser: AgentCoreBrowser, options: BrowserToolOptions = {}): unknown {
  const { tool, createSdkMcpServer } = sdk;
  return createSdkMcpServer({
    name: BROWSER_SERVER_NAME,
    version: '1.0.0',
    tools: browserToolSpecs(browser, options).map((t) =>
      tool(t.name, t.description, t.shape, t.handler, t.readOnly ? { annotations: { readOnlyHint: true } } : undefined)),
  });
}
