import { useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Badge, Button, ErrorNote, Field, Modal, PageHeader, Spinner, Toggle, useUi } from '../components/ui.jsx';

export const INTEGRATION_KINDS = {
  atlassian: { label: 'Jira & Confluence', icon: 'inbox', hint: "Atlassian's hosted Rovo MCP server. Signs in with your Atlassian email and an API token; the agent acts as that account." },
  aws: { label: 'AWS (read-only)', icon: 'lock', hint: 'CloudWatch Logs, DynamoDB, Lambda, CloudFormation and the rest of the AWS API, read-only, through one of the AWS accounts. Runs the AWS API MCP server with uvx.' },
  browser: { label: 'Web browser', icon: 'external', hint: 'A headless browser (Playwright MCP) the agent drives: open pages, read them, click, fill forms, take screenshots and run JavaScript in pages. Each run gets a fresh browser profile. Runs with npx.' },
  http: { label: 'Custom MCP (HTTP)', icon: 'builder', hint: 'Any remote MCP server over streamable HTTP, with secret headers such as Authorization.' },
  stdio: { label: 'Custom MCP (command)', icon: 'settings', hint: 'An MCP server the portal starts as a command on its own server. Admins only.' },
};

/** Integrations: services agents can use in a run as MCP tools. */
export function Integrations() {
  const list = useLoad(() => api.get('/api/integrations'), []);
  const [editing, setEditing] = useState(null); // null | { kind } | integration
  const [picking, setPicking] = useState(false);
  const items = list.data?.integrations || [];
  return (
    <div className="page">
      <PageHeader
        title="Integrations"
        sub="Services the agents can use in a run as MCP tools: Jira and Confluence, AWS, a web browser, or any MCP server. Attach them to a workspace or to one session."
        actions={<Button variant="primary" icon="plus" onClick={() => setPicking(true)}>New integration</Button>}
      />
      <p className="note note-info small">
        <Icon name="lock" size={15} /> Integrations are read-only unless you allow writes: tools that would create, change or delete something are refused before they run. Secrets are write-only and reach a run only as its MCP server&apos;s headers or environment.
      </p>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : !items.length ? (
        <div className="panel stack">
          <h2>No integrations yet</h2>
          <p className="muted">Pick one to start:</p>
          <KindGrid onPick={(kind) => setEditing({ kind })} />
        </div>
      ) : (
        <>
          <IntegSection title="Team" sub="Shared with everyone; can be attached to workspaces." items={items.filter((i) => i.scope === 'team')} onEdit={setEditing} reload={() => list.reload(true)} />
          <IntegSection title="Only you" sub="Usable only in your own sessions and runs." items={items.filter((i) => i.scope === 'personal')} onEdit={setEditing} reload={() => list.reload(true)} />
        </>
      )}
      {picking ? (
        <Modal wide title="New integration" onClose={() => setPicking(false)}>
          <KindGrid
            onPick={(kind) => {
              setPicking(false);
              setEditing({ kind });
            }}
          />
        </Modal>
      ) : null}
      {editing ? <IntegForm integ={editing.id ? editing : null} kind={editing.kind} atlassianUrl={list.data?.atlassianUrl} onClose={() => setEditing(null)} onSaved={() => list.reload(true)} /> : null}
    </div>
  );
}

function KindGrid({ onPick }) {
  const { user } = useApp();
  return (
    <div className="integ-kinds">
      {Object.entries(INTEGRATION_KINDS).map(([kind, k]) => {
        const locked = kind === 'stdio' && !user.is_admin;
        return (
          <button key={kind} type="button" className="integ-kind" disabled={locked} onClick={() => onPick(kind)} title={locked ? 'Only admins can add a command-line server' : undefined}>
            <span className="integ-kind-head">
              <Icon name={k.icon} size={17} />
              <strong>{k.label}</strong>
            </span>
            <span className="muted small">{k.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

function IntegSection({ title, sub, items, onEdit, reload }) {
  return (
    <section className="stack">
      <div>
        <h2>
          {title} <span className="muted small">{items.length}</span>
        </h2>
        <p className="muted small">{sub}</p>
      </div>
      {items.length ? (
        <div className="conn-grid">
          {items.map((i) => (
            <IntegCard key={i.id} i={i} onEdit={() => onEdit(i)} reload={reload} />
          ))}
        </div>
      ) : (
        <p className="muted small">None yet.</p>
      )}
    </section>
  );
}

function IntegCard({ i, onEdit, reload }) {
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState(false);
  const k = INTEGRATION_KINDS[i.kind];
  const test = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/integrations/${i.id}/test`);
      toast(r.test.ok ? r.test.message : `Test failed: ${r.test.message}`, r.test.ok ? 'ok' : 'danger');
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete integration', message: `Delete "${i.name}" and its saved secrets?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/integrations/${i.id}`);
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  const state = !i.test ? { tone: 'muted', label: 'Not tested' } : i.test.ok ? { tone: 'ok', label: 'Working' } : { tone: 'danger', label: 'Failing' };
  return (
    <article className="panel conn-card">
      <header className="conn-head">
        <h3>{i.name}</h3>
        <Badge tone={state.tone}>{state.label}</Badge>
      </header>
      <div className="row tight wrap">
        <span className="chip-static small">
          <Icon name={k?.icon ?? 'builder'} size={12} /> {k?.label ?? i.kind}
        </span>
        <span className={cx('chip-static small', i.allowWrites && 'chip-warn')}>{i.kind === 'browser' ? 'Browser' : i.allowWrites ? 'Writes allowed' : 'Read-only'}</span>
      </div>
      <dl className="kv conn-kv">
        {i.config.url ? <div><dt>Server</dt><dd className="mono break">{i.config.url}</dd></div> : null}
        {i.config.email ? <div><dt>Account</dt><dd>{i.config.email}</dd></div> : null}
        {i.config.command ? <div><dt>Command</dt><dd className="mono break">{[i.config.command, ...i.config.args].join(' ')}</dd></div> : null}
        {i.config.aws ? <div><dt>AWS account</dt><dd>{i.config.aws.name} · {i.config.aws.region}</dd></div> : null}
        {i.config.headerNames.length ? <div><dt>Headers</dt><dd className="mono">{i.config.headerNames.join(', ')}</dd></div> : null}
        {i.config.envNames.length ? <div><dt>Variables</dt><dd className="mono">{i.config.envNames.join(', ')}</dd></div> : null}
        <div><dt>Workspaces</dt><dd>{i.workspaces.length ? i.workspaces.map((w) => `${w.project} / ${w.name}`).join(', ') : 'none'}</dd></div>
        <div><dt>Last tested</dt><dd>{i.test ? timeAgo(i.test.at) : 'never'}</dd></div>
      </dl>
      {i.test ? <p className={cx('small', i.test.ok ? 'muted' : 'danger')}>{i.test.message}</p> : null}
      <div className="row tight wrap">
        <Button size="sm" icon="refresh" busy={busy} onClick={test}>
          Test
        </Button>
        {i.canManage ? (
          <>
            <Button size="sm" icon="edit" onClick={onEdit}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" icon="trash" onClick={remove}>
              Delete
            </Button>
          </>
        ) : null}
      </div>
    </article>
  );
}

/** Name/value rows for headers or environment variables; values are write-only (empty keeps the saved one). */
function SecretRows({ label, rows, setRows, savedNames }) {
  const update = (n, p) => setRows(rows.map((r, j) => (j === n ? { ...r, ...p } : r)));
  return (
    <fieldset className="repo-rows">
      <legend className="field-label">{label}</legend>
      {rows.map((r, n) => (
        <div key={n} className="repo-row">
          <input className="input mono" aria-label={`${label} name ${n + 1}`} value={r.name} onChange={(e) => update(n, { name: e.target.value })} placeholder="Authorization" />
          <input
            className="input mono"
            type="password"
            autoComplete="off"
            aria-label={`${label} value ${n + 1}`}
            value={r.value}
            onChange={(e) => update(n, { value: e.target.value })}
            placeholder={savedNames.includes(r.name) ? 'saved (leave empty to keep)' : 'value'}
          />
          <button type="button" className="icon-btn" aria-label={`Remove ${label.toLowerCase()} ${n + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== n))}>
            <Icon name="x" size={15} />
          </button>
        </div>
      ))}
      <div>
        <Button size="sm" icon="plus" onClick={() => setRows([...rows, { name: '', value: '' }])}>
          Add
        </Button>
      </div>
    </fieldset>
  );
}

function IntegForm({ integ, kind: newKind, atlassianUrl, onClose, onSaved }) {
  const { toast } = useUi();
  const kind = integ?.kind ?? newKind;
  const k = INTEGRATION_KINDS[kind];
  const aws = useLoad(() => (kind === 'aws' ? api.get('/api/aws/connections') : Promise.resolve(null)), [kind]);
  const [f, setF] = useState({
    name: integ?.name ?? (kind === 'atlassian' ? 'Jira & Confluence' : kind === 'browser' ? 'Web browser' : kind === 'aws' ? 'AWS read-only' : ''),
    scope: integ?.scope ?? 'team',
    url: integ?.config.url ?? (kind === 'atlassian' ? atlassianUrl ?? '' : ''),
    email: integ?.config.email ?? '',
    token: '',
    command: integ?.config.command ?? '',
    args: (integ?.config.args ?? []).join('\n'),
    awsConnectionId: integ?.config.aws?.id ?? '',
    allowWrites: integ?.allowWrites ?? false,
  });
  const saved = kind === 'http' ? integ?.config.headerNames ?? [] : integ?.config.envNames ?? [];
  const [rows, setRows] = useState(() => (saved.length ? saved.map((name) => ({ name, value: '' })) : kind === 'http' ? [{ name: 'Authorization', value: '' }] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setF({ ...f, [key]: e.target.value });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const pairs = Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]));
      const body = {
        kind,
        name: f.name,
        scope: f.scope,
        allowWrites: f.allowWrites,
        ...(kind === 'http' ? { url: f.url, headers: pairs } : {}),
        ...(kind === 'atlassian' ? { url: f.url, email: f.email, token: f.token || undefined } : {}),
        ...(kind === 'stdio' ? { command: f.command, args: f.args.split('\n').map((a) => a.trim()).filter(Boolean), env: pairs } : {}),
        ...(kind === 'aws' ? { awsConnectionId: f.awsConnectionId } : {}),
      };
      const r = integ ? await api.put(`/api/integrations/${integ.id}`, body) : await api.post('/api/integrations', body);
      // Check it straight away, so the card says whether it works.
      const t = await api.post(`/api/integrations/${r.integration.id}/test`).catch(() => null);
      toast(t?.test?.ok ? `Saved. ${t.test.message}` : `Saved, but the test failed: ${t?.test?.message ?? 'no answer'}`, t?.test?.ok ? 'ok' : 'danger');
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={integ ? `Edit ${integ.name}` : `New integration: ${k.label}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!f.name.trim()} onClick={save}>
            Save and test
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">{k.hint}</p>
        <div className="row wrap">
          <Field label="Name" hint="Agents see its tools under this name.">{(id) => <input id={id} className="input" value={f.name} onChange={set('name')} autoFocus />}</Field>
          <Field label="Who can use it">
            {(id) => (
              <select id={id} className="input" value={f.scope} onChange={set('scope')}>
                <option value="team">Team: everyone, and workspaces</option>
                <option value="personal">Only you, in your own sessions</option>
              </select>
            )}
          </Field>
        </div>
        {kind === 'http' || kind === 'atlassian' ? <Field label="Server address">{(id) => <input id={id} className="input mono" value={f.url} onChange={set('url')} placeholder="https://…/mcp" />}</Field> : null}
        {kind === 'atlassian' ? (
          <div className="row wrap">
            <Field label="Atlassian email">{(id) => <input id={id} className="input" value={f.email} onChange={set('email')} autoComplete="off" />}</Field>
            <Field label={integ?.secrets?.set ? 'Replace API token (saved)' : 'API token'} hint="id.atlassian.com › Security › API tokens.">
              {(id) => <input id={id} type="password" className="input mono" value={f.token} onChange={set('token')} autoComplete="off" />}
            </Field>
          </div>
        ) : null}
        {kind === 'stdio' ? (
          <>
            <Field label="Command" hint="A program name or full path, like npx, uvx or C:\tools\server.exe.">{(id) => <input id={id} className="input mono" value={f.command} onChange={set('command')} />}</Field>
            <Field label="Arguments" hint="One per line.">{(id) => <textarea id={id} className="input mono" rows={3} value={f.args} onChange={set('args')} />}</Field>
          </>
        ) : null}
        {kind === 'http' ? <SecretRows label="Headers" rows={rows} setRows={setRows} savedNames={saved} /> : null}
        {kind === 'stdio' ? <SecretRows label="Environment variables" rows={rows} setRows={setRows} savedNames={saved} /> : null}
        {kind === 'aws' ? (
          <Field label="AWS account" hint={aws.data?.connections?.length ? 'Its region is used. The server only allows read operations.' : 'Add one on the AWS accounts page first.'}>
            {(id) => (
              <select id={id} className="input" value={f.awsConnectionId} onChange={set('awsConnectionId')}>
                <option value="">Choose…</option>
                {(aws.data?.connections || []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.region}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
        {kind === 'http' || kind === 'stdio' || kind === 'atlassian' ? (
          <Toggle checked={f.allowWrites} onChange={(allowWrites) => setF({ ...f, allowWrites })} label="Allow writes: tools may create, change and delete things" />
        ) : (
          <p className="muted small">{kind === 'aws' ? 'Always read-only.' : 'The browser can click and type on websites the agent opens.'}</p>
        )}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

/** Tick integrations for a workspace, a session or a run. */
export function IntegrationPicker({ value, onChange, teamOnly, packs }) {
  const list = useLoad(() => api.get('/api/integrations'), []);
  const packsLoad = useLoad(() => api.get('/api/tool-packs'), []);
  const resolvedPacks = packs || packsLoad.data?.packs;
  const items = (list.data?.integrations || []).filter((i) => !teamOnly || i.scope === 'team');

  // Determine which pack (if any) is required for an integration kind.
  const requiredPackFor = (kind) => {
    if (kind === 'browser') return 'browser';
    if (kind === 'aws') return 'uv';
    return null;
  };

  // Returns null if the pack is available (or not required), or the hint string if missing.
  const packBlockedHint = (kind) => {
    const packId = requiredPackFor(kind);
    if (!packId || !resolvedPacks) return null;
    const pack = resolvedPacks.find((p) => p.id === packId);
    if (!pack || pack.status === 'available') return null;
    return pack.hint || `${pack.label} is not available`;
  };

  if (list.loading && !list.data) return <Spinner small />;
  if (!items.length) {
    return (
      <p className="muted small">
        No integrations yet. <a href="#/integrations">Add Jira, AWS, a browser or an MCP server</a>.
      </p>
    );
  }
  return (
    <div className="integ-pick">
      {items.map((i) => {
        const hint = packBlockedHint(i.kind);
        const unavailable = Boolean(hint);
        return (
          <div key={i.id} className="stack" style={{ gap: '0.15rem' }}>
            <label className={cx('choice', !unavailable && value.includes(i.id) && 'is-checked', unavailable && 'is-disabled')}>
              <input
                type="checkbox"
                checked={!unavailable && value.includes(i.id)}
                disabled={unavailable}
                onChange={(e) => !unavailable && onChange(e.target.checked ? [...value, i.id] : value.filter((x) => x !== i.id))}
                aria-describedby={unavailable ? `integ-pack-hint-${i.id}` : undefined}
              />
              <span>
                <strong>{i.name}</strong>{' '}
                <span className="muted small">{INTEGRATION_KINDS[i.kind]?.label} · {i.kind === 'browser' ? 'browser' : i.allowWrites ? 'writes allowed' : 'read-only'}{i.scope === 'personal' ? ' · only you' : ''}</span>
              </span>
            </label>
            {unavailable ? (
              <p id={`integ-pack-hint-${i.id}`} className="muted small" style={{ marginLeft: '1.5rem' }}>
                Not available: {hint}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
