/**
 * Portal-handled slash commands (/tools, /rename, /cost, /status, /help) in an engine session:
 * they change the session or answer from saved data, and nothing is sent to the engine.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';

describe('slash commands', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  let wfId = '';

  before(async () => {
    const s = await createTestServer();
    baseUrl = s.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: `admin-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Slash' }, cookie });
    projectId = ((p.body as Record<string, unknown>).project as Record<string, unknown>).id as string;
    const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST', body: { goal: 'g', engine: 'kiro' }, cookie,
    });
    wfId = ((w.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
  });

  after(() => cleanup());

  const send = (message: string) =>
    fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/message`, { method: 'POST', body: { message }, cookie });

  async function lastCommandResult(): Promise<string> {
    const { all } = await import('../server/db.ts');
    const rows = all<{ body: string }>(
      "SELECT body FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'command-result' ORDER BY id DESC LIMIT 1", wfId);
    return rows[0]?.body ?? '';
  }

  it('lists the commands for the chat menu', async () => {
    const r = await fetchJson(baseUrl, '/api/slash-commands', { cookie });
    assert.equal(r.status, 200);
    const names = ((r.body as { commands: Array<{ name: string }> }).commands).map((c) => c.name);
    for (const n of ['help', 'model', 'agent', 'cost', 'tools', 'rename']) assert.ok(names.includes(n), n);
  });

  it('/tools trust and /tools ask change the tool mode', async () => {
    const { one } = await import('../server/db.ts');
    const r = await send('/tools trust');
    assert.equal((r.body as Record<string, unknown>).handled, true);
    assert.equal(one<{ trust_tools: number }>('SELECT trust_tools FROM p6_workflows WHERE id = ?', wfId)?.trust_tools, 1);
    await send('/tools ask');
    assert.equal(one<{ trust_tools: number }>('SELECT trust_tools FROM p6_workflows WHERE id = ?', wfId)?.trust_tools, 0);
  });

  it('/rename changes the title, and the answer is saved with the command', async () => {
    const { one } = await import('../server/db.ts');
    await send('/rename Better title');
    assert.equal(one<{ title: string }>('SELECT title FROM p6_workflows WHERE id = ?', wfId)?.title, 'Better title');
    assert.match(await lastCommandResult(), /^\/rename Better title\n---\nSession renamed/);
  });

  it('/cost and /status answer without starting a run', async () => {
    const { all } = await import('../server/db.ts');
    assert.equal(((await send('/cost')).body as Record<string, unknown>).handled, true);
    assert.match(await lastCommandResult(), /Session total/);
    await send('/status');
    assert.match(await lastCommandResult(), /Engine: kiro/);
    assert.equal(all('SELECT id FROM p6_runs WHERE workflow_id = ?', wfId).length, 0);
  });

  it('an unknown command is answered right away, and nothing is sent to the agent', async () => {
    const { all } = await import('../server/db.ts');
    const r = await send('/something-else');
    assert.equal((r.body as Record<string, unknown>).handled, true);
    assert.match(await lastCommandResult(), /^\/something-else\n---\n\/something-else is not a command in this session/);
    assert.match(await lastCommandResult(), /prompts\/<name>\.md/, 'says where a Kiro session finds commands');
    assert.equal(all("SELECT id FROM p6_workflow_events WHERE workflow_id = ? AND body = '/something-else' AND kind <> 'command-result'", wfId).length, 0);
  });

  // ── The owner's own commands and skills, /init and /review ───────────────────

  const putSetupFile = async (folder: string, path: string, content: string) => {
    const r = await fetchJson(baseUrl, `/api/user-config/${folder}/file`, { method: 'PUT', body: { path, content }, cookie });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };

  async function lastMessage(): Promise<{ kind: string; body: string; data: Record<string, unknown> }> {
    const { all } = await import('../server/db.ts');
    const row = all<{ kind: string; body: string; data: string }>(
      "SELECT kind, body, data FROM p6_workflow_events WHERE workflow_id = ? AND kind IN ('human', 'command') ORDER BY id DESC LIMIT 1", wfId)[0];
    return { kind: row.kind, body: row.body, data: JSON.parse(row.data || '{}') as Record<string, unknown> };
  }

  it("the menu lists the owner's Kiro prompts and skills with /init and /review", async () => {
    await putSetupFile('kiro', 'prompts/deploy-check.md',
      '---\ndescription: Check a deployment\nargument-hint: <environment>\n---\nCheck that $ARGUMENTS is healthy and report.\n');
    await putSetupFile('kiro', 'skills/release-notes/SKILL.md',
      '---\nname: release-notes\ndescription: Write release notes from the merged changes\n---\n# Release notes\n\nList each change in one line.\n');
    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/commands`, { cookie });
    assert.equal(r.status, 200);
    const commands = (r.body as { commands: Array<{ name: string; usage: string; source: string; description: string }> }).commands;
    const byName = new Map(commands.map((c) => [c.name, c]));
    assert.equal(byName.get('help')?.source, 'portal');
    assert.equal(byName.get('init')?.source, 'prompt');
    assert.equal(byName.get('review')?.source, 'prompt');
    assert.deepEqual(
      { source: byName.get('deploy-check')?.source, usage: byName.get('deploy-check')?.usage, description: byName.get('deploy-check')?.description },
      { source: 'command', usage: '/deploy-check <environment>', description: 'Check a deployment' },
    );
    assert.equal(byName.get('release-notes')?.source, 'skill');
    assert.ok(!('body' in (byName.get('release-notes') ?? {})), 'the menu does not carry file contents');
  });

  it('/help lists them too', async () => {
    await send('/help');
    const help = await lastCommandResult();
    assert.match(help, /\/init/);
    assert.match(help, /Your commands and skills:/);
    assert.match(help, /\/deploy-check <environment>\s+Check a deployment/);
    assert.match(help, /\/release-notes \[request\].*\(skill\)/);
  });

  it('an own command is saved as typed, with the prompt it stands for, and is not answered by the portal', async () => {
    const r = await send('/deploy-check staging');
    assert.notEqual((r.body as Record<string, unknown>).handled, true);
    const m = await lastMessage();
    assert.equal(m.kind, 'human', 'a request to the agent like any message');
    assert.equal(m.body, '/deploy-check staging');
    assert.equal(m.data.prompt, 'Check that staging is healthy and report.');
    assert.equal(m.data.command, 'deploy-check');
  });

  it('a skill becomes its instructions with the request', async () => {
    await send('/release-notes for v2.1');
    const m = await lastMessage();
    assert.equal(m.body, '/release-notes for v2.1');
    assert.match(String(m.data.prompt), /^Use the "release-notes" skill for this request/);
    assert.match(String(m.data.prompt), /<skill name="release-notes">\n# Release notes\n\nList each change in one line.\n<\/skill>/);
    assert.match(String(m.data.prompt), /Request: for v2\.1$/);
  });

  it('/init and /review ask the agent; /init names the guide file of the engine', async () => {
    await send('/init');
    assert.match(String((await lastMessage()).data.prompt), /AGENTS\.md at the root of each repository/);
    await send('/review error handling');
    const m = await lastMessage();
    assert.match(String(m.data.prompt), /Do not change any files\.\n\nFocus on: error handling$/);
  });

  it('a message that starts with a path is an ordinary message', async () => {
    const r = await send('/src/app.ts throws on start');
    assert.notEqual((r.body as Record<string, unknown>).handled, true);
    const m = await lastMessage();
    assert.equal(m.kind, 'human');
    assert.equal(m.body, '/src/app.ts throws on start');
    assert.equal(m.data.prompt, undefined);
  });

  it('a run gives the agent the prompts of the commands it picks up', async () => {
    const { eventPrompt } = await import('../server/workflows/session-commands.ts');
    const { getSessionsRepository } = await import('../server/repositories/sessions.ts');
    const pending = await getSessionsRepository().listUnconsumedWorkflowEvents(wfId);
    const prompts = pending.map(eventPrompt);
    assert.ok(prompts.includes('Check that staging is healthy and report.'));
    assert.ok(prompts.includes('/src/app.ts throws on start'));
    assert.ok(!prompts.includes('/deploy-check staging'));
  });

  it('Claude Code commands in subfolders are named folder:name', async () => {
    const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST', body: { goal: 'g', engine: 'claude-code' }, cookie,
    });
    const claudeWf = ((w.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
    await putSetupFile('claude', 'commands/frontend/component.md', 'Create a React component named $1 in $2.\n');
    const list = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${claudeWf}/commands`, { cookie });
    const names = (list.body as { commands: Array<{ name: string }> }).commands.map((c) => c.name);
    assert.ok(names.includes('frontend:component'), names.join(', '));
    assert.ok(!names.includes('deploy-check'), 'a Kiro prompt is not a Claude command');
    await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${claudeWf}/message`, {
      method: 'POST', body: { message: '/frontend:component Button src/ui' }, cookie,
    });
    const { all } = await import('../server/db.ts');
    const lastData = () => JSON.parse(all<{ data: string }>(
      "SELECT data FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'human' ORDER BY id DESC LIMIT 1", claudeWf)[0].data) as { prompt: string };
    assert.equal(lastData().prompt, 'Create a React component named Button in src/ui.');
    await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${claudeWf}/message`, { method: 'POST', body: { message: '/init' }, cookie });
    assert.match(lastData().prompt, /CLAUDE\.md at the root/);
  });

  it('a session started with a command as its goal runs the prompt it stands for', async () => {
    const { goalPrompt } = await import('../server/workflows/session-commands.ts');
    const { getSessionsRepository } = await import('../server/repositories/sessions.ts');
    // As the New session form makes it: the goal is saved, and the run starts from it.
    const sessionWithGoal = async (goal: string) => {
      const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, { method: 'POST', body: { goal, engine: 'kiro' }, cookie });
      const id = ((r.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
      const w = await getSessionsRepository().getWorkflowByProjectId(projectId, id);
      assert.ok(w);
      return w;
    };
    assert.equal(await goalPrompt(await sessionWithGoal('/deploy-check production')), 'Check that production is healthy and report.');
    assert.match(await goalPrompt(await sessionWithGoal('/review the auth code')), /Do not change any files\.\n\nFocus on: the auth code$/);
    for (const goal of ['Fix the login page', '/src/app.ts throws on start', '/nope do it']) {
      assert.equal(await goalPrompt(await sessionWithGoal(goal)), goal, 'goes in as typed');
    }
  });

  it("/model in a teammate's session lists the models of the owner's sign-in, which its runs use", async () => {
    const made = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST', cookie, body: { engine: 'claude-code', mode: 'subscription_token', name: 'Plan', secret: 'oauth-token-abcd' },
    });
    const credentialId = ((made.body as Record<string, unknown>).credential as Record<string, unknown>).id as string;
    const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST', body: { goal: 'g', engine: 'claude-code', credentialId }, cookie,
    });
    const ownersWf = ((w.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;

    const email = `teammate-${Date.now()}@example.com`;
    const u = await fetchJson(baseUrl, '/api/users', { method: 'POST', body: { email, name: 'Teammate', password: 'password1234', isAdmin: false }, cookie });
    const userId = ((u.body as Record<string, unknown>).user as Record<string, unknown>).id as string;
    const added = await fetchJson(baseUrl, `/api/projects/${projectId}/members`, { method: 'POST', body: { userId, role: 'editor' }, cookie });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const teammate = (await fetchJson(baseUrl, '/api/auth/login', { method: 'POST', body: { email, password: 'password1234' } })).cookie ?? '';

    const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${ownersWf}/message`, {
      method: 'POST', body: { message: '/model' }, cookie: teammate,
    });
    assert.equal((r.body as Record<string, unknown>).handled, true);
    const { all } = await import('../server/db.ts');
    const answer = all<{ body: string }>(
      "SELECT body FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'command-result' ORDER BY id DESC LIMIT 1", ownersWf)[0]?.body ?? '';
    assert.doesNotMatch(answer, /does not belong to you/);
    assert.match(answer, /claude-sonnet-4-5 {2}\(Claude Sonnet 4\.5\)/, answer);
  });

  it('/model on a Claude plan: a family name picks its newest model, a short ID its exact model', async () => {
    const made = await fetchJson(baseUrl, '/api/credentials', {
      method: 'POST', cookie, body: { engine: 'claude-code', mode: 'subscription_token', name: 'Plan 2', secret: 'oauth-token-efgh' },
    });
    const credentialId = ((made.body as Record<string, unknown>).credential as Record<string, unknown>).id as string;
    // Made while the portal ran on Bedrock: the session names a Bedrock model.
    const w = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows`, {
      method: 'POST', body: { goal: 'g', engine: 'claude-code', credentialId, model: 'global.anthropic.claude-opus-4-6-v1' }, cookie,
    });
    const wfId = ((w.body as Record<string, unknown>).workflow as Record<string, unknown>).id as string;
    const { all, one } = await import('../server/db.ts');
    const send = async (message: string) => {
      const r = await fetchJson(baseUrl, `/api/projects/${projectId}/workflows/${wfId}/message`, { method: 'POST', body: { message }, cookie });
      assert.equal((r.body as Record<string, unknown>).handled, true, message);
      const answer = all<{ body: string }>(
        "SELECT body FROM p6_workflow_events WHERE workflow_id = ? AND kind = 'command-result' ORDER BY id DESC LIMIT 1", wfId)[0]?.body ?? '';
      return { answer, model: one<{ model: string }>('SELECT model FROM p6_workflows WHERE id = ?', wfId)?.model };
    };

    const listing = await send('/model');
    assert.match(listing.answer, /Current model: global\.anthropic\.claude-opus-4-6-v1\n {2}\(not in this list/);
    assert.match(listing.answer, /claude-opus-5-5 {2}\(Claude Opus 5\.5\)/);

    let r = await send('/model opus');
    assert.match(r.answer, /Model switched to claude-opus-5-5 \(the newest Opus here\)/);
    assert.equal(r.model, 'claude-opus-5-5');
    r = await send('/model sonnet');
    assert.equal(r.model, 'claude-sonnet-5-5');
    r = await send('/model haiku');
    assert.equal(r.model, 'claude-haiku-5-5');
    r = await send('/model opus-5');
    assert.match(r.answer, /Model switched to claude-opus-5\. /, 'opus-5 is claude-opus-5, not every Opus 5.x');
    r = await send('/model sonnet-4-5');
    assert.equal(r.model, 'claude-sonnet-4-5');
    r = await send('/model Claude Opus 4.6');
    assert.equal(r.model, 'claude-opus-4-6');
    r = await send('/model 4-6');
    assert.match(r.answer, /"4-6" matches several models:\n {2}claude-opus-4-6\n {2}claude-sonnet-4-6\nBe more specific\./);
    assert.equal(r.model, 'claude-opus-4-6', 'unchanged');
    r = await send('/model fable');
    assert.match(r.answer, /No model matches "fable"/, 'Fable needs usage credits on Pro');
  });
});

describe('slash command parsing', () => {
  it('reads "/name args", and not a path or a bare slash', async () => {
    const { parseSlashCommand } = await import('../server/workflows/session-commands.ts');
    assert.deepEqual(parseSlashCommand('/Review  the auth code '), { name: 'review', args: 'the auth code' });
    assert.deepEqual(parseSlashCommand('/frontend:component Button'), { name: 'frontend:component', args: 'Button' });
    assert.deepEqual(parseSlashCommand('/init'), { name: 'init', args: '' });
    assert.equal(parseSlashCommand('/src/app.ts fails'), null);
    assert.equal(parseSlashCommand('/ hello'), null);
    assert.equal(parseSlashCommand('hello /init'), null);
  });

  it('fills $ARGUMENTS and $1..$9, and adds the arguments when there is no placeholder', async () => {
    const { fillArguments } = await import('../server/workflows/session-commands.ts');
    assert.equal(fillArguments('Fix issue $ARGUMENTS now', '#12 fast'), 'Fix issue #12 fast now');
    assert.equal(fillArguments('Move $1 to $2', 'a.ts b.ts extra'), 'Move a.ts to b.ts');
    assert.equal(fillArguments('Run the checks.', 'quickly'), 'Run the checks.\n\nARGUMENTS: quickly');
    assert.equal(fillArguments('Run the checks.\n', ''), 'Run the checks.');
  });

  it("a saved message's prompt is its command prompt, else its text", async () => {
    const { eventPrompt } = await import('../server/workflows/session-commands.ts');
    assert.equal(eventPrompt({ body: '/x', data: JSON.stringify({ prompt: 'Do x' }) }), 'Do x');
    assert.equal(eventPrompt({ body: 'hello', data: JSON.stringify({ by: 'u' }) }), 'hello');
    assert.equal(eventPrompt({ body: 'hello', data: 'not json' }), 'hello');
    assert.equal(eventPrompt({ body: 'hello', data: null }), 'hello');
  });
});
