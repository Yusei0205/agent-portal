import { useEffect, useRef, useState } from 'react';
import { api, sharedStream } from '../../lib/api.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx, timeAgo } from '../../lib/util.js';
import { Badge, Button, ErrorNote, Field, Spinner, useUi } from '../../components/ui.jsx';
import { useSave } from './useSave.js';

export function SecretsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [x, setX] = useState(s.secrets);
  useEffect(() => setX(s.secrets), [s.secrets]);
  return (
    <section className="panel span-2">
      <h2>Where secrets are stored</h2>
      <div className="choice-row">
      <label className={cx('choice', x.mode === 'local' && 'is-checked')}>
        <input type="radio" name="secrets" checked={x.mode === 'local'} onChange={() => setX({ ...x, mode: 'local' })} />
        <span>
          <strong>Encrypted in the portal database</strong> <span className="muted">AES-256, key from PORTAL_SECRET_KEY or data/master.key. No extra cost.</span>
        </span>
      </label>
      <label className={cx('choice', x.mode === 'aws-ssm' && 'is-checked')}>
        <input type="radio" name="secrets" checked={x.mode === 'aws-ssm'} onChange={() => setX({ ...x, mode: 'aws-ssm' })} />
        <span>
          <strong>AWS Systems Manager Parameter Store</strong> <span className="muted">SecureString parameters, read with the server’s own AWS identity. Needs the AWS CLI.</span>
        </span>
      </label>
      </div>
      {x.mode === 'aws-ssm' ? (
        <div className="row">
          <Field label="Parameter prefix">{(id) => <input id={id} className="input mono" value={x.prefix} onChange={(e) => setX({ ...x, prefix: e.target.value })} />}</Field>
          <Field label="Region (optional)">{(id) => <input id={id} className="input mono" value={x.region} onChange={(e) => setX({ ...x, region: e.target.value.trim() })} />}</Field>
        </div>
      ) : null}
      <p className="muted small">Changing this applies to secrets you save from now on. Save each secret again to move it.</p>
      <ErrorNote error={error} />
      <Button variant="primary" busy={busy} disabled={JSON.stringify(x) === JSON.stringify(s.secrets)} onClick={() => save({ secrets: x })}>
        Save
      </Button>
      <p className="muted small">Data folder on the server: <code>{s.dataDir}</code></p>
    </section>
  );
}

export function SecretRow({ title, desc, name, info, reload, inline }) {
  const { toast } = useUi();
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(!info?.set);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => setEditing(!info?.set), [info?.set]);
  const body = (
    <>
      <div className="row between">
        <div>
          <strong>{title}</strong>
          {desc ? <p className="muted small">{desc}</p> : null}
        </div>
        {info?.set ? <Badge tone="ok">Saved {info.hint}</Badge> : <Badge tone="muted">Not set</Badge>}
      </div>
      {editing ? (
        <div className="row">
          <input className="input mono" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} aria-label={title} placeholder="Paste the value" />
          <Button
            variant="primary"
            busy={busy}
            disabled={!value.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post(`/api/settings/secrets/${name}`, { value });
                setValue('');
                toast(`${title} saved`);
                await reload();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
          {info?.set ? <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button> : null}
        </div>
      ) : (
        <div className="row tight">
          <Button size="sm" onClick={() => setEditing(true)}>
            Replace
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.del(`/api/settings/secrets/${name}`);
              toast(`${title} removed`);
              await reload();
            }}
          >
            Remove
          </Button>
          {info?.updatedAt ? <span className="muted small">updated {timeAgo(info.updatedAt)}</span> : null}
        </div>
      )}
      <ErrorNote error={error} />
    </>
  );
  return inline ? <div className="secret-row">{body}</div> : <section className="panel">{body}</section>;
}

/* ------------------------------------------------------------------ */
/* Tools section (admin only)                                         */
/* ------------------------------------------------------------------ */

/**
 * One install pack row (uv, kiro, or browser).
 * Shows status, what it enables, an Install button (where applicable),
 * live progress via SSE, and plain error text on failure.
 */
function PackRow({ pack, onInstalled }) {
  const { toast } = useUi();
  // Load any existing job on mount (resilient to page reload).
  const jobLoad = useLoad(
    () => (pack.id === 'browser' ? Promise.resolve({ job: null }) : api.get(`/api/tools/${pack.id}/install`)),
    [pack.id],
  );
  const [job, setJob] = useState(null);
  const [installing, setInstalling] = useState(false);
  const [logLines, setLogLines] = useState([]);
  const logRef = useRef(null);

  // Sync job from load result
  useEffect(() => {
    if (jobLoad.data?.job) {
      const j = jobLoad.data.job;
      setJob(j);
      setLogLines(j.log || []);
      if (j.status === 'pending' || j.status === 'running') setInstalling(true);
    }
  }, [jobLoad.data]);

  // Subscribe to install SSE events
  useEffect(() => {
    const closeInstalls = sharedStream('/api/tools/stream', {
      'tool.install.progress': (data) => {
        if (data.packId !== pack.id) return;
        setLogLines((prev) => [...prev, data.line]);
        setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 50);
      },
      'tool.install.done': (data) => {
        if (data.packId !== pack.id) return;
        setInstalling(false);
        jobLoad.reload(true);
        if (data.status === 'done') {
          toast(`${pack.label} installed`, 'ok');
          onInstalled?.();
        }
      },
    });
    return closeInstalls;
  }, [pack.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const startInstall = async () => {
    setInstalling(true);
    setLogLines([]);
    try {
      const r = await api.post(`/api/tools/${pack.id}/install`);
      setJob(r.job);
    } catch (e) {
      setInstalling(false);
      toast(e.message, 'danger');
    }
  };

  const statusTone = pack.status === 'available' ? 'ok' : pack.status === 'not configured' ? 'muted' : 'warn';
  const statusLabel = pack.status === 'available' ? 'Available' : pack.status === 'not configured' ? 'Not configured' : 'Missing';

  const canInstall = pack.id !== 'browser' && pack.status !== 'available';
  const jobFailed = job?.status === 'failed';
  const jobDone = job?.status === 'done';
  const showLog = logLines.length > 0;

  return (
    <div className="tools-pack-row">
      <div className="row between wrap" style={{ alignItems: 'flex-start', gap: '0.5rem' }}>
        <div className="stack" style={{ gap: '0.15rem', flex: 1 }}>
          <div className="row tight wrap">
            <strong>{pack.label}</strong>
            <Badge tone={statusTone}>{statusLabel}</Badge>
          </div>
          <p className="muted small">Needed by: {pack.neededBy}</p>
          {pack.status !== 'available' && pack.reason ? (
            <p className="muted small">{pack.reason}</p>
          ) : null}
          {/* Kiro login hint */}
          {pack.id === 'kiro' && pack.status === 'available' ? (
            <p className="field-hint">
              To sign in: <code className="mono small">docker compose exec portal kiro-cli login --use-device-flow</code>
            </p>
          ) : null}
          {/* Browser compose hint */}
          {pack.id === 'browser' ? (
            <p className="field-hint">
              To start the browser: <code className="mono small">docker compose --profile browser up -d</code>
            </p>
          ) : null}
        </div>
        <div className="row tight" style={{ flexShrink: 0 }}>
          {pack.id === 'browser' ? (
            <Button size="sm" icon="refresh" onClick={() => jobLoad.reload(true)} busy={jobLoad.loading}>
              Refresh
            </Button>
          ) : canInstall ? (
            <Button
              size="sm"
              variant="primary"
              busy={installing}
              disabled={installing}
              onClick={startInstall}
              aria-label={`Install ${pack.label}`}
            >
              Install
            </Button>
          ) : null}
        </div>
      </div>
      {/* Live install log */}
      {showLog ? (
        <div
          ref={logRef}
          className="tools-install-log"
          role="log"
          aria-label={`Install log for ${pack.label}`}
          aria-live="polite"
        >
          {logLines.map((line, i) => (
            <div key={i} className="tools-log-line mono small">{line}</div>
          ))}
        </div>
      ) : null}
      {jobFailed && job.error ? (
        <p className="danger small" role="alert">{job.error}</p>
      ) : null}
      {jobDone ? (
        <p className="ok small" role="status">{pack.label} installed successfully.</p>
      ) : null}
    </div>
  );
}

/** Settings › Tools section — admin only. */
export function ToolsSection() {
  const packs = useLoad(() => api.get('/api/tool-packs'), []);

  return (
    <section className="panel span-2" aria-labelledby="tools-section-heading">
      <h2 id="tools-section-heading">Tools</h2>
      <p className="muted small">
        Optional tools the portal can use. Install them here or follow the hint to start them separately.
        The browser is started via Docker Compose; uv and Kiro are installed into the portal&apos;s data directory.
      </p>
      {packs.loading && !packs.data ? (
        <Spinner />
      ) : packs.error ? (
        <ErrorNote error={packs.error} />
      ) : (
        <div className="tools-pack-list">
          {(packs.data?.packs || []).map((pack) => (
            <PackRow key={pack.id} pack={pack} onInstalled={() => packs.reload(true)} />
          ))}
        </div>
      )}
    </section>
  );
}
