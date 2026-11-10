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

import { BedrockAgentCoreClient, StartBrowserSessionCommand, StopBrowserSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
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
      sessionTimeoutSeconds: 900,
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

/** The browser tools, independent of how they are served (Claude SDK in-process MCP, or a stdio MCP for Kiro). */
export function browserToolSpecs(browser: AgentCoreBrowser): BrowserToolSpec[] {
  return [
    {
      name: 'goto', readOnly: true,
      description: 'Open a web page (http or https) in the cloud browser and return its title and address.',
      shape: { url: z.string().describe('Full URL, e.g. https://example.com') },
      handler: ({ url }: { url: string }) => guarded(async () => {
        const page = await browser.getPage();
        await page.goto(assertWebUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
        const png = await page.screenshot({ fullPage: !!full_page, type: 'png' });
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
        }
        await browser.publishFrame();
        return text(`Typed into ${selector}${submit ? ' and submitted' : ''}. Now at ${page.url()}`);
      }),
    },
  ];
}

/** Builds the in-process MCP server config for sdk.query({ options: { mcpServers } }). */
export function createBrowserMcpServer(sdk: SdkModule, browser: AgentCoreBrowser): unknown {
  const { tool, createSdkMcpServer } = sdk;
  return createSdkMcpServer({
    name: BROWSER_SERVER_NAME,
    version: '1.0.0',
    tools: browserToolSpecs(browser).map((t) =>
      tool(t.name, t.description, t.shape, t.handler, t.readOnly ? { annotations: { readOnlyHint: true } } : undefined)),
  });
}
