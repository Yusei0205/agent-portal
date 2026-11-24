/**
 * "Portal tools": one briefing added to every run, built from what that run really has, so the agent knows what the portal's
 * words mean (the vault, the knowledge) and which tool to reach for (web search, an integration, the browser) instead of
 * guessing. Replaces the separate vault and Jira hints. Pure; runner.ts builds the context.
 */

export interface PortalToolsContext {
  /** The run has a project (vault and knowledge belong to a project). */
  project: boolean;
  /** MCP servers the run was given (runner-integrations.ts), by name and URL. */
  integrations: ReadonlyArray<{ name: string; url: string }>;
  /** The run has the cloud browser tools. */
  browser: boolean;
  /** The project is connected to Jira but this run has no Atlassian MCP (the sign-in was skipped or not done). */
  jiraUnavailable?: boolean;
  /** The project's AWS account credentials are in the run's environment. */
  awsAccount?: boolean;
}

export const PORTAL_DATA_SERVER = 'portal-data';

/** What a connected integration is for, from its address or name; a plain fallback for anything else. */
export function integrationPurpose(name: string, url: string): string {
  const u = `${url} ${name}`.toLowerCase();
  if (/atlassian|jira|confluence/.test(u)) return 'Jira tickets and Confluence pages';
  if (/\/api\/mcp\/google\b|google-workspace|^google\b/.test(u)) return 'Google Drive, Docs, Sheets and Slides of the person';
  if (/gmail/.test(u)) return 'the person\'s Gmail';
  if (/notion/.test(u)) return 'Notion pages and databases';
  if (/github/.test(u)) return 'GitHub repositories, issues and pull requests';
  if (/gitlab/.test(u)) return 'GitLab projects, issues and merge requests';
  if (/slack/.test(u)) return 'Slack channels and messages';
  if (/linear/.test(u)) return 'Linear issues and projects';
  if (/figma/.test(u)) return 'Figma designs';
  if (/sentry/.test(u)) return 'Sentry errors and issues';
  if (/hubspot/.test(u)) return 'HubSpot CRM records';
  if (/salesforce/.test(u)) return 'Salesforce records';
  if (/stripe/.test(u)) return 'Stripe payments data';
  return `the ${name} service`;
}

export function portalToolsBriefing(ctx: PortalToolsContext): string {
  const hasPortalData = ctx.integrations.some((i) => i.name === PORTAL_DATA_SERVER);
  const others = ctx.integrations.filter((i) => i.name !== PORTAL_DATA_SERVER);
  const lines: string[] = ['Portal tools (what these words mean in this portal, and which tool to use):'];

  lines.push(
    '- Web search ("google it", "look it up", "search online"): use your web search tool (WebSearch or web_search). If you have none, use WebFetch on https://html.duckduckgo.com/html/?q=<words> and open the results you need with WebFetch. Never open Google or another search engine in the browser: they block automated browsers.',
  );
  if (ctx.browser) {
    lines.push('- Browser: the cloud browser tools are for working in a specific site (open a page, sign in, click through a web app, test a UI, take screenshots), not for searching the web.');
  }

  if (ctx.project) {
    if (hasPortalData) {
      lines.push(
        `- Knowledge ("our knowledge base", "the docs", "project documents"): the project's Knowledge in the portal. Search it with the ${PORTAL_DATA_SERVER} tools search_knowledge and list_knowledge before answering questions about this project from memory.`,
        `- Vault ("vault", "our vault", "team vault"): the portal's own file store (My vault / Team vault in the Files panel), not Azure Key Vault, Google Drive, Notion or Obsidian. Read it with the ${PORTAL_DATA_SERVER} tools list_vault (scope "team" or "mine") and read_vault_file. To save something to the vault ("save to vault"), write it as a file in the current run folder: the portal collects it as an output and puts it in the vault. Say which file you wrote. Do not ask which vault they mean.`,
      );
    } else {
      lines.push(
        '- Knowledge ("our knowledge base", "the docs"): the project\'s Knowledge in the portal. It cannot be read from this session: if a task needs a document from it, ask the person to attach it.',
        '- Vault ("vault", "our vault", "team vault", "save to vault"): the portal\'s own file store (My vault / Team vault in the Files panel), not Azure Key Vault, Google Drive, Notion or Obsidian. To save something there, write it as a file in the current run folder: the portal collects it as an output and puts it in the vault (the person can also use "Add to vault" in the Outputs tab). Say which file you wrote. Do not ask which vault they mean. You cannot read the vault directly: for an existing vault file, ask the person to attach it.',
      );
    }
  }

  if (others.length) {
    lines.push('- Connected services: use their tools, not the browser (the browser has none of these sign-ins):');
    for (const i of others) lines.push(`  - ${i.name}: ${integrationPurpose(i.name, i.url)} (tools named after "${i.name}")`);
  }
  if (ctx.jiraUnavailable) {
    lines.push('- Jira is not available in this session (the Atlassian sign-in was skipped or has not been done). Say so if a task needs Jira tickets; do not open Jira in the browser, it has no Jira login.');
  }
  if (ctx.awsAccount) {
    lines.push('- AWS: the project\'s AWS account credentials are in your environment (the AWS_* variables). Use them with the AWS SDK or CLI where available; never print or copy them.');
  }
  lines.push('- If a task needs a portal service that is not listed here, say so instead of guessing or working around it.');
  return lines.join('\n');
}
