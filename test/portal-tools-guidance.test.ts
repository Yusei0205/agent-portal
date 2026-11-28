/** The per-run "Portal tools" briefing: web search before the browser, what vault and knowledge mean, and each connected service. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { portalToolsBriefing, integrationPurpose } from '../server/agent/portal-tools-guidance.ts';

describe('portal tools briefing', () => {
  it('sends searches to the web search tool, never a search engine in the browser', () => {
    const b = portalToolsBriefing({ project: false, integrations: [], browser: true });
    assert.match(b, /"google it"/);
    assert.match(b, /WebSearch or web_search/);
    assert.match(b, /html\.duckduckgo\.com\/html\/\?q=/);
    assert.match(b, /Never open Google or another search engine in the browser/);
    assert.match(b, /cloud browser tools are for working in a specific site/);
    assert.doesNotMatch(portalToolsBriefing({ project: false, integrations: [], browser: false }), /cloud browser tools/);
  });

  it('with the portal-data tools, Knowledge and the Vault are read with them', () => {
    const b = portalToolsBriefing({ project: true, integrations: [{ name: 'portal-data', url: 'https://k/api/mcp/portal-data' }], browser: false });
    assert.match(b, /search_knowledge and list_knowledge/);
    assert.match(b, /list_vault \(scope "team" or "mine"\) and read_vault_file/);
    assert.match(b, /not Azure Key Vault/);
    assert.match(b, /write it as a file in the current run folder/);
    assert.doesNotMatch(b, /Connected services/, 'portal-data is not listed as a service');
  });

  it('without them, says Knowledge and the Vault cannot be read and to ask for an attachment', () => {
    const b = portalToolsBriefing({ project: true, integrations: [], browser: false });
    assert.match(b, /It cannot be read from this session/);
    assert.match(b, /You cannot read the vault directly/);
    assert.doesNotMatch(portalToolsBriefing({ project: false, integrations: [], browser: false }), /Vault/);
  });

  it('names each connected service with what it is for, and the Jira and AWS notes when they apply', () => {
    const b = portalToolsBriefing({
      project: true, browser: true, jiraUnavailable: true, awsAccount: true,
      integrations: [{ name: 'notion', url: 'https://mcp.notion.com/mcp' }, { name: 'google', url: 'https://k/api/mcp/google' }, { name: 'acme', url: 'https://mcp.acme.dev' }],
    });
    assert.match(b, /- notion: Notion pages and databases/);
    assert.match(b, /- google: Google Drive, Docs, Sheets and Slides/);
    assert.match(b, /- acme: the acme service/);
    assert.match(b, /use their tools, not the browser/);
    assert.match(b, /Jira is not available in this session/);
    assert.match(b, /AWS_\* variables/);
  });

  it('knows the usual services by address or name', () => {
    assert.equal(integrationPurpose('atlassian', 'https://mcp.atlassian.com/v1/sse'), 'Jira tickets and Confluence pages');
    assert.equal(integrationPurpose('gh', 'https://api.githubcopilot.com/mcp/'), 'GitHub repositories, issues and pull requests');
    assert.equal(integrationPurpose('gmail', 'https://k/api/mcp/gmail'), "the person's Gmail");
  });
});
