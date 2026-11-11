/**
 * "Add to Vault" for one session output file. Shown only while the file is not in the Vault. After it succeeds it asks the
 * session workspace to reload its output list (a window event), so every place that lists the file shows the new state.
 */

import { useState } from 'react';
import { Icon } from '../../components/Icon.jsx';
import { api } from '../../lib/api.js';

export const OUTPUT_FILES_CHANGED = 'portal:output-files-changed';

/** @param {{ workflowId: string, file: { id: string, name: string, vault_file_id?: string | null }, className?: string }} props */
export function AddToVaultButton({ workflowId, file, className = 'btn btn-sm btn-ghost' }) {
  const [state, setState] = useState('idle'); // idle | busy | failed
  const [message, setMessage] = useState('');
  if (!workflowId || file.vault_file_id) return null;

  const add = async () => {
    setState('busy');
    setMessage('');
    try {
      await api.post(`/api/workflows/${encodeURIComponent(workflowId)}/output-files/${encodeURIComponent(file.id)}/vault`);
      setState('idle');
      window.dispatchEvent(new CustomEvent(OUTPUT_FILES_CHANGED, { detail: { workflowId } }));
    } catch (err) {
      setMessage(err?.message || 'Could not add the file to the Vault');
      setState('failed');
    }
  };

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={add}
        disabled={state === 'busy'}
        aria-label={`Add ${file.name} to the Vault`}
        title={message || 'Save a copy of this file in the project Vault'}
      >
        <Icon name="archive" size={12} aria-hidden="true" />
        {state === 'busy' ? 'Adding…' : state === 'failed' ? 'Retry add to Vault' : 'Add to Vault'}
      </button>
      {state === 'failed' && <span className="muted" role="alert" style={{ fontSize: 11 }}>{message}</span>}
    </>
  );
}
