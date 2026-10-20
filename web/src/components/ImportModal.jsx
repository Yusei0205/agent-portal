import { useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { cx } from '../lib/util.js';
import { Button, ErrorNote, Field, Modal, Note, Spinner } from './ui.jsx';

const STEP_SOURCE = 'source';
const STEP_PREVIEW = 'preview';
const STEP_RESULT = 'result';

/**
 * ImportModal — three-step wizard:
 *   1. Choose source (zip upload / folder picker / server path)
 *   2. Preview items with conflict resolution
 *   3. Result summary
 *
 * Props:
 *   projectId: string
 *   onClose: () => void
 *   onImported: () => void   (called after successful import)
 */
export function ImportModal({ projectId, onClose, onImported }) {
  const { user } = useApp();
  const isAdmin = Boolean(user?.is_admin);

  const [step, setStep] = useState(STEP_SOURCE);
  const [source, setSource] = useState('zip'); // 'zip' | 'folder' | 'path'
  const [serverPath, setServerPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Preview state
  const [preview, setPreview] = useState(null); // { items, parsed }

  // Per-item choice: Map<`${kind}:${name}`, { choice, renameTo }>
  const [choices, setChoices] = useState(new Map());

  // Confirm options
  const [saveToLibrary, setSaveToLibrary] = useState(false);

  // Result
  const [result, setResult] = useState(null);

  const zipInputRef = useRef(null);
  const folderInputRef = useRef(null);

  // ---- Helpers ----
  function itemKey(item) {
    return `${item.kind}:${item.name}`;
  }

  function getChoice(item) {
    return choices.get(itemKey(item)) ?? { choice: item.conflict ? 'skip' : 'overwrite', renameTo: '' };
  }

  function setChoice(item, choice, renameTo) {
    const k = itemKey(item);
    setChoices((prev) => {
      const next = new Map(prev);
      next.set(k, { choice, renameTo: renameTo ?? prev.get(k)?.renameTo ?? '' });
      return next;
    });
  }

  function setRenameTo(item, renameTo) {
    const k = itemKey(item);
    setChoices((prev) => {
      const next = new Map(prev);
      const cur = prev.get(k) ?? { choice: 'rename', renameTo: '' };
      next.set(k, { ...cur, renameTo });
      return next;
    });
  }

  // ---- Source step handlers ----
  async function handleZipUpload(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const res = await api.postRaw(`/api/projects/${projectId}/builder/import/zip`, new Uint8Array(buf));
      setPreview(res);
      initChoices(res.items);
      setStep(STEP_PREVIEW);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleFolderUpload(files) {
    if (!files || !files.length) return;
    setBusy(true);
    setError(null);
    try {
      // Read all files as base64
      const entries = await Promise.all(
        Array.from(files).map(
          (f) =>
            new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                // result is data URL: "data:<mime>;base64,<b64>"
                const b64 = reader.result.split(',')[1] ?? '';
                resolve({ path: f.webkitRelativePath || f.name, content: b64 });
              };
              reader.onerror = reject;
              reader.readAsDataURL(f);
            }),
        ),
      );
      const res = await api.post(`/api/projects/${projectId}/builder/import/folder`, { entries });
      setPreview(res);
      initChoices(res.items);
      setStep(STEP_PREVIEW);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleServerPath() {
    if (!serverPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post(`/api/projects/${projectId}/builder/import/path`, { path: serverPath.trim() });
      setPreview(res);
      initChoices(res.items);
      setStep(STEP_PREVIEW);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function initChoices(items) {
    const map = new Map();
    for (const item of items) {
      map.set(`${item.kind}:${item.name}`, {
        choice: item.conflict ? 'skip' : 'overwrite',
        renameTo: '',
      });
    }
    setChoices(map);
  }

  // ---- Confirm step ----
  async function handleConfirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const items = preview.items.map((item) => {
        const c = getChoice(item);
        return { kind: item.kind, name: item.name, choice: c.choice, renameTo: c.renameTo || undefined };
      });
      const res = await api.post(`/api/projects/${projectId}/builder/import/confirm`, {
        items,
        parsed: preview.parsed,
        saveToLibrary,
      });
      setResult(res);
      setStep(STEP_RESULT);
      if (res.imported > 0) onImported?.();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  // ---- Counts for the confirm button ----
  const willImport = preview
    ? preview.items.filter((item) => getChoice(item).choice !== 'skip').length
    : 0;

  // ---- Render ----
  return (
    <Modal
      title="Import agents and skills"
      onClose={onClose}
      wide
      footer={
        step === STEP_SOURCE ? (
          source === 'path' ? (
            <div className="row">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" busy={busy} disabled={!serverPath.trim()} onClick={handleServerPath}>
                Preview
              </Button>
            </div>
          ) : null
        ) : step === STEP_PREVIEW ? (
          <div className="row between">
            <Button variant="ghost" onClick={() => { setStep(STEP_SOURCE); setError(null); }} disabled={busy}>
              Back
            </Button>
            <div className="row tight">
              <Button onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" busy={busy} disabled={willImport === 0} onClick={handleConfirm}>
                Import {willImport > 0 ? `${willImport} item${willImport === 1 ? '' : 's'}` : ''}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" onClick={onClose}>Done</Button>
        )
      }
    >
      {/* Live region for screen readers */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {step === STEP_PREVIEW && preview ? `Preview loaded: ${preview.items.length} items found` : ''}
        {step === STEP_RESULT && result ? result.message : ''}
      </div>

      {step === STEP_SOURCE && <SourceStep
        source={source}
        setSource={setSource}
        serverPath={serverPath}
        setServerPath={setServerPath}
        isAdmin={isAdmin}
        busy={busy}
        error={error}
        zipInputRef={zipInputRef}
        folderInputRef={folderInputRef}
        onZipChange={(e) => handleZipUpload(e.target.files?.[0])}
        onFolderChange={(e) => handleFolderUpload(e.target.files)}
      />}

      {step === STEP_PREVIEW && preview && <PreviewStep
        items={preview.items}
        choices={choices}
        saveToLibrary={saveToLibrary}
        setSaveToLibrary={setSaveToLibrary}
        getChoice={getChoice}
        setChoice={setChoice}
        setRenameTo={setRenameTo}
        error={error}
        busy={busy}
      />}

      {step === STEP_RESULT && result && <ResultStep result={result} />}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1: source selection                                            */
/* ------------------------------------------------------------------ */

function SourceStep({ source, setSource, serverPath, setServerPath, isAdmin, busy, error, zipInputRef, folderInputRef, onZipChange, onFolderChange }) {
  return (
    <div className="stack-lg">
      <p className="muted">
        Import agents and skills from a Claude Code <code>.claude</code> folder. Accepts project roots (containing <code>.claude/</code>), bare <code>.claude</code> folders, or direct <code>agents/</code> + <code>skills/</code> layouts.
      </p>

      <fieldset className="stack" disabled={busy}>
        <legend className="field-label">Source</legend>

        <label className={cx('check-card', source === 'zip' && 'is-active')}>
          <input type="radio" name="import-source" value="zip" checked={source === 'zip'} onChange={() => setSource('zip')} />
          <strong>Upload a .zip file</strong>
          <span className="muted small">A zip containing agents/*.md and/or skills/*/SKILL.md</span>
        </label>

        <label className={cx('check-card', source === 'folder' && 'is-active')}>
          <input type="radio" name="import-source" value="folder" checked={source === 'folder'} onChange={() => setSource('folder')} />
          <strong>Select a folder</strong>
          <span className="muted small">Pick a folder from your computer using the browser file picker</span>
        </label>

        {isAdmin ? (
          <label className={cx('check-card', source === 'path' && 'is-active')}>
            <input type="radio" name="import-source" value="path" checked={source === 'path'} onChange={() => setSource('path')} />
            <strong>Server folder path</strong>
            <span className="muted small">Admin only — absolute path on the server, e.g. /home/user/my-team/.claude</span>
          </label>
        ) : null}
      </fieldset>

      {source === 'zip' && (
        <div className="stack">
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip"
            className="sr-only"
            id="import-zip-input"
            aria-label="Choose zip file"
            onChange={onZipChange}
          />
          <label htmlFor="import-zip-input">
            <Button icon="upload" busy={busy} onClick={() => zipInputRef.current?.click()} disabled={busy}>
              Choose .zip file…
            </Button>
          </label>
          <p className="muted small">Maximum 20 MB</p>
        </div>
      )}

      {source === 'folder' && (
        <div className="stack">
          <input
            ref={folderInputRef}
            type="file"
            // @ts-ignore — webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            multiple
            className="sr-only"
            id="import-folder-input"
            aria-label="Choose folder"
            onChange={onFolderChange}
          />
          <label htmlFor="import-folder-input">
            <Button icon="upload" busy={busy} onClick={() => folderInputRef.current?.click()} disabled={busy}>
              Choose folder…
            </Button>
          </label>
          <p className="muted small">Select the project root, the .claude folder, or a folder containing agents/ and skills/</p>
        </div>
      )}

      {source === 'path' && isAdmin && (
        <Field label="Absolute server path" hint="Path to the project root, .claude folder, or agents/skills directory on the server.">
          {(id) => (
            <input
              id={id}
              className="input mono"
              value={serverPath}
              onChange={(e) => setServerPath(e.target.value)}
              placeholder="/home/user/my-team/.claude"
              autoFocus
            />
          )}
        </Field>
      )}

      <ErrorNote error={error} />
      {busy ? <Spinner /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: preview + conflict resolution                               */
/* ------------------------------------------------------------------ */

function PreviewStep({ items, choices, saveToLibrary, setSaveToLibrary, getChoice, setChoice, setRenameTo, error, busy }) {
  const agents = items.filter((i) => i.kind === 'agent');
  const skills = items.filter((i) => i.kind === 'skill');
  const invalidCount = items.filter((i) => i.invalid).length;

  return (
    <div className="stack-lg">
      {invalidCount > 0 && (
        <Note tone="warn" icon="alert">
          {invalidCount} item{invalidCount === 1 ? ' has' : 's have'} validation issues and will be shown but not imported by default.
        </Note>
      )}

      <p className="muted small">
        Found <strong>{agents.length}</strong> agent{agents.length !== 1 ? 's' : ''} and <strong>{skills.length}</strong> skill{skills.length !== 1 ? 's' : ''}.
        For items that already exist, choose whether to overwrite, skip, or rename.
      </p>

      {agents.length > 0 && (
        <section>
          <h3 className="small muted" style={{ marginBottom: '0.5rem' }}>Agents</h3>
          <div className="import-table">
            {agents.map((item) => <PreviewRow key={`agent:${item.name}`} item={item} choice={getChoice(item)} setChoice={setChoice} setRenameTo={setRenameTo} />)}
          </div>
        </section>
      )}

      {skills.length > 0 && (
        <section>
          <h3 className="small muted" style={{ marginBottom: '0.5rem' }}>Skills</h3>
          <div className="import-table">
            {skills.map((item) => <PreviewRow key={`skill:${item.name}`} item={item} choice={getChoice(item)} setChoice={setChoice} setRenameTo={setRenameTo} />)}
          </div>
        </section>
      )}

      <label className="check">
        <input type="checkbox" checked={saveToLibrary} onChange={(e) => setSaveToLibrary(e.target.checked)} />
        <span>Also save imported items to the shared library</span>
      </label>

      <ErrorNote error={error} />
      {busy ? <Spinner /> : null}
    </div>
  );
}

function PreviewRow({ item, choice, setChoice, setRenameTo }) {
  const { name, kind, description, conflict, invalid, invalidReasons } = item;
  const missingSkills = kind === 'agent' ? (item.missingSkills ?? []) : [];
  const tools = kind === 'agent' ? item.tools : [];
  const model = kind === 'agent' ? item.model : null;
  const isSkipped = choice.choice === 'skip';

  return (
    <div className={cx('import-row', invalid && 'import-row-invalid', isSkipped && 'import-row-skipped')} aria-label={`${kind} ${name}`}>
      <div className="import-row-head">
        <span className="import-row-name">
          <code>{name}</code>
          <span className="badge badge-muted" style={{ marginLeft: '0.4rem', fontSize: '0.75rem' }}>{kind}</span>
          {invalid && <span className="badge badge-danger" style={{ marginLeft: '0.4rem', fontSize: '0.75rem' }}>invalid</span>}
          {conflict && !invalid && <span className="badge badge-warn" style={{ marginLeft: '0.4rem', fontSize: '0.75rem' }}>exists</span>}
        </span>
        <fieldset className="row tight import-choice" aria-label={`Action for ${name}`}>
          <label className="check">
            <input type="radio" name={`choice-${kind}-${name}`} value="overwrite" checked={choice.choice === 'overwrite'} onChange={() => setChoice(item, 'overwrite')} disabled={invalid} />
            Overwrite
          </label>
          <label className="check">
            <input type="radio" name={`choice-${kind}-${name}`} value="skip" checked={choice.choice === 'skip'} onChange={() => setChoice(item, 'skip')} />
            Skip
          </label>
          <label className="check">
            <input type="radio" name={`choice-${kind}-${name}`} value="rename" checked={choice.choice === 'rename'} onChange={() => setChoice(item, 'rename')} disabled={invalid} />
            Rename
          </label>
        </fieldset>
      </div>

      {choice.choice === 'rename' && (
        <div className="import-rename">
          <label htmlFor={`rename-${kind}-${name}`} className="field-label small">New name</label>
          <input
            id={`rename-${kind}-${name}`}
            className="input mono"
            style={{ width: '16rem' }}
            value={choice.renameTo}
            onChange={(e) => setRenameTo(item, e.target.value)}
            placeholder="new-name"
            aria-label={`New name for ${name}`}
          />
        </div>
      )}

      {description && <p className="muted small import-row-desc">{description}</p>}

      <div className="import-row-meta">
        {model && <span className="muted small">model: {model}</span>}
        {tools.length > 0 && <span className="muted small">tools: {tools.join(', ')}</span>}
        {kind === 'skill' && item.extraFileCount > 0 && <span className="muted small">{item.extraFileCount} extra file{item.extraFileCount !== 1 ? 's' : ''}</span>}
      </div>

      {invalidReasons?.length > 0 && (
        <ul className="import-row-errors" role="alert" aria-label={`Validation issues for ${name}`}>
          {invalidReasons.map((r, i) => <li key={i} className="small">{r}</li>)}
        </ul>
      )}

      {missingSkills.length > 0 && (
        <p className="muted small import-row-warn" role="alert" aria-label={`Missing skills warning for ${name}`}>
          ⚠ References skills not in this project or import set: {missingSkills.join(', ')}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: result                                                      */
/* ------------------------------------------------------------------ */

function ResultStep({ result }) {
  return (
    <div className="stack-lg">
      <Note tone={result.imported > 0 ? 'ok' : 'info'} icon={result.imported > 0 ? 'check' : 'alert'}>
        {result.message}
      </Note>
    </div>
  );
}
