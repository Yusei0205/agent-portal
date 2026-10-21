import { useState } from 'react';
import { api } from '../lib/api.js';
import { useLoad } from '../lib/useAsync.js';
import { cx, timeAgo } from '../lib/util.js';
import { Icon } from '../components/Icon.jsx';
import { Badge, Button, ErrorNote, Field, Modal, PageHeader, Segmented, Spinner, useUi } from '../components/ui.jsx';
import { CONNECTION_LABEL } from './Repos.jsx';

const KINDS = [
  { value: 'github', label: 'GitHub', hint: 'A personal access token (classic or fine-grained) with repository contents and pull requests.' },
  { value: 'bitbucket', label: 'Bitbucket', hint: 'A Bitbucket username and an app password or API token with repository read and write, for one workspace.' },
  { value: 'codecommit', label: 'AWS CodeCommit', hint: 'Signs in through one of the AWS accounts, so no git secret is stored here.' },
  { value: 'git', label: 'Other Git server', hint: 'Any Git server over HTTPS, with a username and a token.' },
];

/** Repository connections: shared or personal sign-ins that repositories clone and push with. */
export function Connections() {
  const list = useLoad(() => api.get('/api/git-connections'), []);
  const [editing, setEditing] = useState(null); // null | 'new' | connection
  const items = list.data?.connections || [];
  const team = items.filter((c) => c.scope === 'team');
  const mine = items.filter((c) => c.scope === 'personal');
  return (
    <div className="page">
      <PageHeader
        title="Repository connections"
        sub="GitHub, Bitbucket, CodeCommit and other Git sign-ins that repositories clone and push with. Secrets are write-only: only their last characters are ever shown."
        actions={<Button variant="primary" icon="plus" onClick={() => setEditing('new')}>New connection</Button>}
      />
      <p className="note note-info small">
        <Icon name="lock" size={15} /> A run gets the credential of every repository it works on, and its agent can use it, for example to push. Use tokens that reach only what agents should reach.
      </p>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <ErrorNote error={list.error} />
      ) : (
        <>
          <ConnSection title="Team" sub="Shared with everyone on the portal. Admins and whoever made one can change it." items={team} onEdit={setEditing} reload={() => list.reload(true)} />
          <ConnSection title="Only you" sub="Visible to and usable by you alone." items={mine} onEdit={setEditing} reload={() => list.reload(true)} />
        </>
      )}
      {editing ? <ConnForm conn={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => list.reload(true)} /> : null}
    </div>
  );
}

function ConnSection({ title, sub, items, onEdit, reload }) {
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
          {items.map((c) => (
            <ConnCard key={c.id} c={c} onEdit={() => onEdit(c)} reload={reload} />
          ))}
        </div>
      ) : (
        <p className="muted small">None yet.</p>
      )}
    </section>
  );
}

function ConnCard({ c, onEdit, reload }) {
  const { toast, confirm } = useUi();
  const [busy, setBusy] = useState('');
  const [showUsers, setShowUsers] = useState(false);
  const test = async () => {
    setBusy('test');
    try {
      const r = await api.post(`/api/git-connections/${c.id}/test`);
      toast(r.test.ok ? 'Connection works' : r.test.message, r.test.ok ? 'ok' : 'danger');
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy('');
    }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete connection', message: `Delete "${c.name}" and its saved token?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/git-connections/${c.id}`);
      toast('Connection deleted');
      reload();
    } catch (e) {
      toast(e.message, 'danger');
    }
  };
  const state = !c.test ? { tone: 'muted', label: 'Not tested' } : c.test.ok ? { tone: 'ok', label: 'Working' } : { tone: 'danger', label: 'Failing' };
  return (
    <article className="panel conn-card">
      <header className="conn-head">
        <h3>{c.name}</h3>
        <Badge tone={state.tone}>{state.label}</Badge>
      </header>
      <div className="row tight wrap">
        <span className="chip-static small">{CONNECTION_LABEL[c.provider]}</span>
        <span className="chip-static small">{c.scope === 'team' ? 'Team' : 'Only you'}</span>
      </div>
      <dl className="kv conn-kv">
        {c.provider === 'codecommit' ? (
          <>
            <div><dt>AWS account</dt><dd>{c.aws ? c.aws.name : 'removed'}</dd></div>
            <div><dt>Region</dt><dd>{c.aws?.region ?? '—'}</dd></div>
          </>
        ) : (
          <>
            {c.host ? <div><dt>Server</dt><dd className="mono">{c.host}</dd></div> : null}
            {c.workspace ? <div><dt>Workspace</dt><dd className="mono">{c.workspace}</dd></div> : null}
            {c.username ? <div><dt>Username</dt><dd>{c.username}</dd></div> : null}
            <div><dt>Token</dt><dd className="mono">{c.token?.set ? c.token.hint : 'not saved'}</dd></div>
          </>
        )}
        <div>
          <dt>Used by</dt>
          <dd>
            {c.usedBy ? (
              <button type="button" className="linkish" onClick={() => setShowUsers((v) => !v)} aria-expanded={showUsers}>
                {c.usedBy} repositor{c.usedBy === 1 ? 'y' : 'ies'}
              </button>
            ) : (
              'nothing yet'
            )}
          </dd>
        </div>
        <div><dt>Last tested</dt><dd>{c.test ? timeAgo(c.test.at) : 'never'}</dd></div>
        <div><dt>Last updated</dt><dd>{timeAgo(c.updatedAt)}{c.updatedBy ? ` by ${c.updatedBy}` : ''}</dd></div>
      </dl>
      {showUsers ? (
        <ul className="plain-list small">
          {c.usedByRepos.map((r) => (
            <li key={r.id}>
              <a href={`#/p/${r.project_id}/repos`}>{r.project} / {r.name}</a>
            </li>
          ))}
        </ul>
      ) : null}
      {c.test ? <p className={cx('small', c.test.ok ? 'muted' : 'danger')}>{c.test.message}</p> : null}
      <div className="row tight wrap">
        <Button size="sm" icon="refresh" busy={busy === 'test'} onClick={test}>
          Test
        </Button>
        {c.canManage ? (
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

function ConnForm({ conn, onClose, onSaved }) {
  const { toast } = useUi();
  const aws = useLoad(() => api.get('/api/aws/connections'), []);
  const [f, setF] = useState({
    provider: conn?.provider ?? 'github',
    name: conn?.name ?? '',
    scope: conn?.scope ?? 'team',
    host: conn?.host ?? '',
    username: conn?.username ?? '',
    workspace: conn?.workspace ?? '',
    awsConnectionId: conn?.aws?.id ?? '',
    token: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const kind = KINDS.find((k) => k.value === f.provider);
  const awsList = aws.data?.connections || [];
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...f, token: f.token || undefined };
      const r = conn ? await api.put(`/api/git-connections/${conn.id}`, body) : await api.post('/api/git-connections', body);
      toast(r.test.ok ? `Saved. ${r.test.message}` : `Saved, but the test failed: ${r.test.message}`, r.test.ok ? 'ok' : 'danger');
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
      title={conn ? `Edit ${conn.name}` : 'New repository connection'}
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
        {conn ? null : <Segmented value={f.provider} onChange={(provider) => setF({ ...f, provider })} label="Kind of connection" options={KINDS.map(({ value, label }) => ({ value, label }))} />}
        <p className="muted small">{kind.hint}</p>
        <div className="row wrap">
          <Field label="Name">{(id) => <input id={id} className="input" value={f.name} onChange={set('name')} placeholder="Company GitHub" autoFocus />}</Field>
          <Field label="Who can use it">
            {(id) => (
              <select id={id} className="input" value={f.scope} onChange={set('scope')}>
                <option value="team">Team: everyone on the portal</option>
                <option value="personal">Only you</option>
              </select>
            )}
          </Field>
        </div>
        {f.provider === 'codecommit' ? (
          <Field label="AWS account" hint={awsList.length ? 'Its region is where repositories are listed.' : 'Add an AWS account on the AWS accounts page first.'}>
            {(id) => (
              <select id={id} className="input" value={f.awsConnectionId} onChange={set('awsConnectionId')}>
                <option value="">Choose…</option>
                {awsList.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.region}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <>
            {f.provider === 'git' ? <Field label="Server address">{(id) => <input id={id} className="input mono" value={f.host} onChange={set('host')} placeholder="https://gitlab.example.com" />}</Field> : null}
            {f.provider === 'bitbucket' ? <Field label="Bitbucket workspace" hint="As in bitbucket.org/<workspace>.">{(id) => <input id={id} className="input mono" value={f.workspace} onChange={set('workspace')} />}</Field> : null}
            <Field label={f.provider === 'github' ? 'Username (optional)' : 'Username'}>{(id) => <input id={id} className="input" value={f.username} onChange={set('username')} autoComplete="off" />}</Field>
            <Field label={conn?.token?.set ? `Replace token (saved, ${conn.token.hint})` : 'Token'} hint="Stored encrypted and never shown again.">
              {(id) => <input id={id} type="password" className="input mono" value={f.token} onChange={set('token')} autoComplete="off" />}
            </Field>
          </>
        )}
        <ErrorNote error={error} />
      </div>
    </Modal>
  );
}

