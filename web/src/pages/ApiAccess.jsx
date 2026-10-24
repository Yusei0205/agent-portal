import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, dateTime, timeAgo } from '../lib/util.js';
import { Badge, Button, ErrorNote, Field, Note, PageHeader, Spinner, Toggle, useUi } from '../components/ui.jsx';

const ENDPOINTS = [
  ['GET', '/api/projects', 'Projects you can see', 'read'],
  ['GET', '/api/projects/{project}/workspaces', 'Workspaces of a project', 'read'],
  ['GET', '/api/projects/{project}/workflows', 'Sessions of a project', 'read'],
  ['POST', '/api/projects/{project}/workflows', 'Start a session: { goal, workspaceId?, repos?, integrations?, model?, leadAgent? }. A single run is { singleRun: true, prompt, repos?, permissionMode?, model? }', 'write'],
  ['GET', '/api/workflows/{session}', 'A session, its history and its runs', 'read'],
  ['POST', '/api/workflows/{session}/messages', 'Send an instruction: { body }', 'write'],
  ['POST', '/api/workflows/{session}/pause | resume | stop', 'Pause, resume or stop a session', 'write'],
  ['GET', '/api/runs/{run}', 'One agent run (an iteration of a session) with its events (the transcript)', 'read'],
  ['GET', '/api/runs/{run}/stream', 'Live events of an agent run (server-sent events)', 'read'],
  ['GET', '/api/runs/{run}/changes', 'Files and diff of an agent run', 'read'],
  ['POST', '/api/inputs/{input}/answer', 'Answer a question or approval', 'write'],
  ['GET / PUT', '/api/projects/{project}/config/file?path=.claude/…', 'Read or change a .claude / .kiro file', 'read / write'],
];

function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      icon={done ? 'check' : 'copy'}
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

/** API Access: personal access tokens for the REST API. */
export function ApiAccess() {
  const list = useLoad(() => api.get('/api/tokens'), []);
  const base = `${window.location.origin}/api`;
  const example = `curl -s ${base}/projects \\\n  -H "Authorization: Bearer ap_YOUR_TOKEN"`;
  const startExample = `curl -s -X POST ${base}/projects/PROJECT_ID/workflows \\\n  -H "Authorization: Bearer ap_YOUR_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"goal": "Fix the failing refund tests", "workspaceId": "WORKSPACE_ID"}'`;
  const tokens = list.data?.tokens || [];
  const active = tokens.filter((t) => t.active);
  return (
    <div className="page">
      <PageHeader title="API access" sub="Drive the portal from scripts and CI. A personal access token acts as you: sessions it starts are recorded under your name." />

      <section className="panel stack">
        <h2>REST API</h2>
        <p className="muted small">The same API this app uses. Send the token as a bearer header; no browser session or special header is needed.</p>
        <div className="row tight wrap">
          <code className="api-base">{base}</code>
          <CopyButton text={base} />
        </div>
        <pre className="prompt-box api-code">{example}</pre>
        <details>
          <summary className="small">Start a session from a script</summary>
          <pre className="prompt-box api-code">{startExample}</pre>
        </details>
        <Note tone="info" icon="lock">
          Tokens can read projects, sessions and runs, and with write access start, steer and stop them, answer questions and edit .claude / .kiro files. Users, tokens, settings, connections, integrations, AWS accounts, pushing to repositories and protected configuration stay browser-only, so a leaked token cannot change who has access, make more tokens, reach secrets or push code.
        </Note>
        <details>
          <summary className="small">Endpoints</summary>
          <div className="table-wrap">
            <table className="table api-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>What</th>
                  <th>Needs</th>
                </tr>
              </thead>
              <tbody>
                {ENDPOINTS.map(([m, p, what, scope]) => (
                  <tr key={m + p}>
                    <td className="mono small">{m}</td>
                    <td className="mono small">{p}</td>
                    <td className="small">{what}</td>
                    <td className="small">{scope}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <NewToken atLimit={active.length >= (list.data?.maxActive ?? 10)} onMade={() => list.reload(true)} />

      <section className="panel stack">
        <h2>
          Your tokens <span className="muted small">{active.length} active of at most {list.data?.maxActive ?? 10}</span>
        </h2>
        {list.loading && !list.data ? <Spinner /> : list.error ? <ErrorNote error={list.error} /> : <TokenTable tokens={tokens} reload={() => list.reload(true)} />}
      </section>
    </div>
  );
}

function NewToken({ atLimit, onMade }) {
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [made, setMade] = useState(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/api/tokens', { name, days: Number(days), scope: write ? 'write' : 'read' });
      setMade(r);
      setName('');
      onMade();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel stack">
      <h2>New token</h2>
      {made ? (
        <Note tone="success" icon="check" action={<Button size="sm" onClick={() => setMade(null)}>Done</Button>}>
          <div className="stack">
            <span>
              Copy <strong>{made.info.name}</strong> now. It is not shown again.
            </span>
            <div className="row tight wrap">
              <code className="api-token">{made.token}</code>
              <CopyButton text={made.token} label="Copy token" />
            </div>
          </div>
        </Note>
      ) : null}
      <div className="row wrap">
        <Field label="Token name" hint="Where it will be used, so you recognise it later.">
          {(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub Actions nightly" />}
        </Field>
        <Field label="Expires after">
          {(id) => (
            <select id={id} className="input" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">365 days</option>
            </select>
          )}
        </Field>
      </div>
      <div className="stack tight">
        <p className="small">
          <strong>Read</strong> <span className="muted">— list projects, sessions and runs, read transcripts, changes and .claude / .kiro files. Always included.</span>
        </p>
        <Toggle checked={write} onChange={setWrite} label="Write — start, steer, stop and delete sessions and runs, answer questions, edit .claude / .kiro files: that is, run agents with a shell as you." />
      </div>
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" icon="plus" busy={busy} disabled={!name.trim() || atLimit} onClick={create} title={atLimit ? 'Revoke a token first' : undefined}>
          Create token
        </Button>
      </div>
    </section>
  );
}

function TokenTable({ tokens, reload }) {
  const { toast, confirm } = useUi();
  if (!tokens.length) return <p className="muted small">You have no tokens.</p>;
  const revoke = async (t) => {
    if (!(await confirm({ title: 'Revoke token', message: `Revoke "${t.name}"? Scripts using it stop working at once.`, confirmLabel: 'Revoke', danger: true }))) return;
    try {
      await api.del(`/api/tokens/${t.id}`);
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Token</th>
            <th>Access</th>
            <th>Expires</th>
            <th>Last used</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id} className={cx(!t.active && 'muted')}>
              <td>{t.name}</td>
              <td className="mono small">{t.prefix}…</td>
              <td>{t.scope === 'write' ? <Badge tone="warn">Read + write</Badge> : <Badge tone="muted">Read</Badge>}</td>
              <td className="small">{t.revoked_at ? `revoked ${timeAgo(t.revoked_at)}` : t.active ? dateTime(t.expires_at) : 'expired'}</td>
              <td className="small">{t.last_used_at ? timeAgo(t.last_used_at) : 'never'}</td>
              <td>
                {t.active ? (
                  <Button size="sm" variant="ghost" icon="trash" onClick={() => revoke(t)}>
                    Revoke
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

