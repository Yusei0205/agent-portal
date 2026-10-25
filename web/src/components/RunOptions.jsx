import { useState } from 'react';
import { trustToolsHint } from '../pages/sessions/NewSessionFields.jsx';
import { DiagramStyleFields, diagramStyleBody, docStyleBody, initialStyle, rememberStyle } from './DiagramStyle.jsx';
import { Button, Field, IconButton, Modal, Toggle } from './ui.jsx';

/**
 * Run options for work an agent session generates (diagrams, documents, decks): which agent leads and whether it may
 * use tools without asking. The list responses carry `runOptions` for the picker; each item stores its last choice
 * (`lead_agent`, `trust_all_tools`) and a refresh without a body reuses it.
 */

export const DEFAULT_AGENT = 'Default agent';

const TRUST_LABEL = 'Let the agent use tools freely';
const TRUST_HINT = `${trustToolsHint(false)} Cloud writes and pushes stay blocked as well.`;

/** The starting choice for a dialog: the item's stored values, else the project's default lead and tools off. */
export function initialRunOptions(runOptions, stored) {
  return {
    leadAgent: stored?.lead_agent || runOptions?.defaultLeadAgent || '',
    trustAllTools: Boolean(stored?.trust_all_tools),
  };
}

/** The request fields for a choice. Both are always sent, so what was picked is exactly what is stored. */
export function runOptionsBody(value) {
  return { leadAgent: value.leadAgent || '', trustAllTools: Boolean(value.trustAllTools) };
}

/** Show what the server says could not be honoured (a lead agent that is gone, for example) as notices. */
export function showWarnings(toast, warnings) {
  for (const w of warnings || []) toast(w, 'warn');
}

/** "Lead agent" select and the trust switch. */
export function RunOptionsFields({ runOptions, value, onChange }) {
  const leads = runOptions?.leadAgents || [];
  const missing = value.leadAgent && !leads.some((a) => a.name === value.leadAgent);
  return (
    <>
      <Field label="Lead agent" hint="The agent that plans the work and hands tasks to the rest of the team.">
        {(id) => (
          <select id={id} className="input" value={value.leadAgent} onChange={(e) => onChange({ ...value, leadAgent: e.target.value })}>
            <option value="">{DEFAULT_AGENT}</option>
            {missing ? <option value={value.leadAgent}>{value.leadAgent} (not available now)</option> : null}
            {leads.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.description ? ` — ${a.description.slice(0, 60)}` : ''}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="field">
        <Toggle checked={value.trustAllTools} onChange={(trustAllTools) => onChange({ ...value, trustAllTools })} label={TRUST_LABEL} />
        <p className="field-hint">{TRUST_HINT}</p>
      </div>
    </>
  );
}

/** A section for the New dialogs: a heading and the two fields. */
export function RunOptionsSection({ runOptions, value, onChange }) {
  return (
    <fieldset className="field run-options">
      <legend className="field-label">Agent and tools</legend>
      <div className="stack">
        <RunOptionsFields runOptions={runOptions} value={value} onChange={onChange} />
      </div>
    </fieldset>
  );
}

/** The saved choice of an item, as meta text for its view. */
export function RunChoice({ item }) {
  return (
    <>
      <span className="muted small">Lead agent: {item.lead_agent || DEFAULT_AGENT}</span>
      <span className="muted small">Tools: {item.trust_all_tools ? 'used freely' : 'ask first'}</span>
    </>
  );
}

/**
 * A refresh action that stays one click: the button reuses what the item stored. The small button beside it opens the
 * agent and tools choice for this one refresh.
 *
 * @param {object} props
 * @param {(body: { leadAgent: string, trustAllTools: boolean } | undefined) => void} props.onRefresh
 * @param {object} [props.runOptions]
 * @param {{ lead_agent?: string, trust_all_tools?: boolean }} [props.stored]
 * @param {string} [props.note] What the chosen values apply to, shown in the dialog
 * @param {{ projectId: string, data: object, stored: { style?: string, cloud?: string | null }, what: 'diagram' | 'doc' | 'deck' }} [props.styleOptions]
 *   When given, the dialog also offers the drawing style and cloud (diagrams: `style`/`cloud` go with the refresh)
 */
export function RefreshControl({ label = 'Refresh', busy, disabled, title, runOptions, stored, note, styleOptions, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(() => initialRunOptions(runOptions, stored));
  const [look, setLook] = useState(() => (styleOptions ? initialStyle(styleOptions.projectId, styleOptions.data, styleOptions.stored) : null));
  const start = () => {
    setValue(initialRunOptions(runOptions, stored));
    if (styleOptions) setLook(initialStyle(styleOptions.projectId, styleOptions.data, styleOptions.stored));
    setOpen(true);
  };
  return (
    <span className="row tight">
      <Button icon="refresh" busy={busy} disabled={disabled} title={title} onClick={() => onRefresh(undefined)}>
        {label}
      </Button>
      <IconButton icon="settings" label={`Agent and tools for: ${label}`} disabled={disabled || busy} onClick={start} />
      {open ? (
        <Modal
          title="Agent and tools"
          onClose={() => setOpen(false)}
          footer={
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                icon="refresh"
                onClick={() => {
                  setOpen(false);
                  if (styleOptions && look) {
                    rememberStyle(styleOptions.projectId, look);
                    onRefresh({ ...runOptionsBody(value), ...(styleOptions.what === 'diagram' ? diagramStyleBody(look) : docStyleBody(look)) });
                  } else onRefresh(runOptionsBody(value));
                }}
              >
                {label} with these
              </Button>
            </>
          }
        >
          <div className="stack">
            <p className="muted small">{note || 'The plain button reuses the choice saved with this item. Pick different ones here for this refresh; they are saved for the next one.'}</p>
            {styleOptions && look ? <DiagramStyleFields data={styleOptions.data} value={look} onChange={setLook} what={styleOptions.what} name="refresh-diagram-style" /> : null}
            <RunOptionsFields runOptions={runOptions} value={value} onChange={setValue} />
          </div>
        </Modal>
      ) : null}
    </span>
  );
}
