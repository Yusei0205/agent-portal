import { useState } from 'react';
import { api } from '../lib/api.js';
import { Button, ErrorNote, Field, Modal, Note, Spinner, Toggle } from './ui.jsx';

/**
 * DraftPromptModal — generates a draft agent or skill from a plain-language description.
 *
 * Props:
 *   kind: 'agent' | 'skill'
 *   projectId: string
 *   onClose: () => void
 *   onDraft: (draft) => void   — called with the draft; caller fills the edit form
 */
export function DraftPromptModal({ kind, projectId, onClose, onDraft }) {
  const [description, setDescription] = useState('');
  const [useDocuments, setUseDocuments] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const label = kind === 'agent' ? 'agent' : 'skill';
  const placeholder =
    kind === 'agent'
      ? 'e.g. A payment reconciliation expert that checks invoices against transactions and flags discrepancies, then writes a summary report.'
      : 'e.g. A step-by-step guide for writing database migration scripts: naming conventions, rollback strategy, and testing procedure.';

  async function handleDraft() {
    const desc = description.trim();
    if (!desc) return;
    setBusy(true);
    setError(null);
    try {
      const { draft } = await api.post(`/api/projects/${projectId}/builder/draft`, {
        kind,
        description: desc,
        useDocuments,
      });
      onDraft(draft);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Describe ${label === 'agent' ? 'an' : 'a'} ${label}`}
      onClose={onClose}
      footer={
        <div className="row tight">
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!description.trim()}
            onClick={handleDraft}
          >
            Draft {label}
          </Button>
        </div>
      }
    >
      <div className="stack-lg">
        <p className="muted">
          Describe what the {label} should do in plain language. The portal will draft a name,
          description, {kind === 'agent' ? 'tools, model, and instructions' : 'and instructions (SKILL.md)'} for
          you to review and edit before saving. Nothing is saved automatically.
        </p>

        <Field
          label={`What should the ${label} do?`}
          hint="Be specific: mention the inputs, the outputs, and the context it works in."
        >
          {(id) => (
            <textarea
              id={id}
              className="input"
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={placeholder}
              autoFocus
              aria-describedby={`draft-hint-${id}`}
            />
          )}
        </Field>

        <div className="field">
          <Toggle
            checked={useDocuments}
            onChange={setUseDocuments}
            label="Base on project documents"
          />
          <p className="field-hint">
            When on, a snippet from the project knowledge base is included to help tailor the draft.
          </p>
        </div>

        {busy && (
          <div className="row tight">
            <Spinner />
            <span className="muted small">Drafting with Haiku…</span>
          </div>
        )}

        <ErrorNote error={error} />

        <Note tone="info" icon="question">
          The draft fills the edit form — review it carefully before pressing <strong>Save</strong>.
          You can also press <strong>Run test</strong> after saving to try it out.
        </Note>
      </div>
    </Modal>
  );
}
