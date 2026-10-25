import { useId, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApp } from '../../lib/context.js';
import { useLoad } from '../../lib/useAsync.js';
import { cx } from '../../lib/util.js';
import { PUSH_MODES } from './status.js';
import { Button, Field } from '../../components/ui.jsx';

export const ENGINE_LABEL = { anthropic: 'Anthropic API', bedrock: 'Amazon Bedrock', kiro: 'Kiro CLI', demo: 'Demo' };

/** The agents that can lead on an engine: the project's Kiro agents on Kiro when it has any, otherwise its Claude Code agents. */
export function useLeads(projectId, kiro) {
  const leads = useLoad(() => api.get(`/api/projects/${projectId}/leads?engine=${kiro ? 'kiro' : 'claude'}`), [projectId, kiro]);
  return leads.data?.leads;
}

export function LeadField({ team = [], value, onChange, kiro }) {
  const own = team[0]?.kind === 'kiro';
  const fallback = kiro && team.length > 0 && team[0]?.kind === 'claude';
  const hint = own
    ? 'A lead runs as the main agent with its own Kiro profile and hands tasks to the agents on its team (its availableAgents), then checks what they return.'
    : team.length
      ? 'A lead plans the work, hands tasks to the other agents of this project and checks what they return.'
      : kiro
        ? 'No agents in this project yet. Add Kiro agents under Agents and skills › Kiro (or Claude Code agents) and a lead can delegate to them.'
        : 'No agents in this project yet. Add some under Agents and skills and a lead can delegate to them.';
  // Source label shown under the dropdown so the user knows which agent set is listed.
  const sourceLabel = team.length
    ? own
      ? 'Kiro agents (.kiro/agents)'
      : fallback
        ? 'Claude Code agents (.claude/agents) — no Kiro agents in this project yet'
        : 'Claude Code agents (.claude/agents)'
    : null;
  return (
    <Field label="Lead agent" hint={hint}>
      {(id) => (
        <>
          <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={sourceLabel ? `${id}-source` : undefined}>
            <option value="">Default (the main agent decides)</option>
            {value && !team.some((a) => a.name === value) ? <option value={value}>{value} (cannot lead on this engine)</option> : null}
            {team.length > 0 ? (
              <optgroup label={own ? 'Kiro agents (.kiro/agents)' : fallback ? 'Claude Code agents — fallback (.claude/agents)' : 'Claude Code agents (.claude/agents)'}>
                {team.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                    {a.description ? ` — ${a.description.slice(0, 60)}` : ''}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {sourceLabel ? (
            <p id={`${id}-source`} className="field-hint" style={{ marginTop: '0.25rem' }}>
              Showing: {sourceLabel}
            </p>
          ) : null}
        </>
      )}
    </Field>
  );
}

/** Whether the agents may ask the portal to push their changes to the session's new branch. */
export function PushModeField({ value, onChange }) {
  const mode = PUSH_MODES.find((m) => m.value === value) ?? PUSH_MODES[0];
  return (
    <Field label="Agent pushes" hint={`${mode.hint} Only ever to the session's own new branch, never to the base or shared branches like main.`}>
      {(id) => (
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
          {PUSH_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/** The explanation next to the trust switch; the generated-work dialogs (diagrams, documents, decks) show the same words. */
export function trustToolsHint(hasRepos) {
  return hasRepos
    ? "Commands and edits run without asking. The agent can push to this session's own new branch (never to dev-sg, main or other shared branches) using the repository's credentials, which it never sees. Deploys, terraform apply and deleting files outside the working copy stay blocked."
    : "Commands and edits run without asking. The agent can push to this session's own new branch (never to dev-sg, main or other shared branches) using the repository's credentials, which it never sees. Deploys, terraform apply and deleting files outside the working copy stay blocked. This session has no repository, so it can't push.";
}

/**
 * "Trust all tools" toggle: commands and edits run without approval prompts.
 * Shown in New session dialog and session Settings.
 */
export function TrustToolsField({ value, onChange, hasRepos }) {
  const uid = useId();
  const id = `trust-tools-${uid}`;
  const hint = trustToolsHint(hasRepos);
  return (
    <div className="field">
      <div className="row tight">
        <input
          id={id}
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={`${id}-hint`}
        />
        <label htmlFor={id} className="field-label" style={{ marginBottom: 0, cursor: 'pointer' }}>
          Trust all tools
        </label>
      </div>
      <p id={`${id}-hint`} className="field-hint">{hint}</p>
    </div>
  );
}

export function LimitFields({ f, set, kiro }) {
  return (
    <div className="row wrap">
      {kiro ? (
        <Field label="Budget (Kiro credits)" hint="It pauses when this is spent.">
          {(id) => <input id={id} type="number" min="1" step="1" className="input input-sm" value={f.budgetCredits} onChange={set('budgetCredits')} />}
        </Field>
      ) : (
        <Field label="Budget (USD)" hint="It pauses when this is spent.">
          {(id) => <input id={id} type="number" min="0.1" step="0.5" className="input input-sm" value={f.budgetUsd} onChange={set('budgetUsd')} />}
        </Field>
      )}
      <Field label="Iterations before pausing" hint="Per start; it asks you before going further.">
        {(id) => <input id={id} type="number" min="1" max="50" className="input input-sm" value={f.maxIterations} onChange={set('maxIterations')} />}
      </Field>
    </div>
  );
}

// ─── Settings precedence row for the launcher ────────────────────────────────

/**
 * The "Using: ..." line that expands into a full precedence table showing
 * portal default → project → session-level settings.
 */
export function SettingsPrecedenceRow({ engines, engine, f, effectiveKiro, project, setMore }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveEngine = ENGINE_LABEL[engine || engines.default] ?? (engine || engines.default);
  const effectiveModel = f.model;
  const effectiveBudget = effectiveKiro ? `${f.budgetCredits} credits` : `$${f.budgetUsd}`;
  const effectivePushMode = f.pushMode;
  const effectiveLead = f.leadAgent || 'None';

  if (!expanded) {
    return (
      <p className="ls-effective-settings small muted">
        Using: <strong>{effectiveEngine}</strong>
        {' · '}<strong>{effectiveModel}</strong>
        {' · '}budget <strong>{effectiveBudget}</strong>
        {' '}
        <button type="button" className="btn-link small" onClick={() => setExpanded(true)}>Details</button>
        {' '}
        <button type="button" className="btn-link small" onClick={() => setMore(true)}>Change</button>
      </p>
    );
  }

  return (
    <div className="ls-precedence-block">
      <div className="row between">
        <span className="field-label">Settings for this session</span>
        <button type="button" className="btn-link small" onClick={() => setExpanded(false)}>Hide</button>
      </div>
      <table className="table compact precedence-table" aria-label="Settings precedence">
        <thead>
          <tr>
            <th>Setting</th>
            <th>Portal default</th>
            <th>Project default</th>
            <th>This session</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Engine / provider</td>
            <td className="muted small">{ENGINE_LABEL[engines.default] ?? engines.default}</td>
            <td className="muted small">{engine ? ENGINE_LABEL[engine] ?? engine : <span className="muted">Inherits portal</span>}</td>
            <td><strong>{effectiveEngine}</strong></td>
          </tr>
          <tr>
            <td>Model</td>
            <td className="muted small">{project.default_model || 'sonnet'}</td>
            <td className="muted small"><span className="muted">Inherits portal</span></td>
            <td><strong>{effectiveModel}</strong></td>
          </tr>
          <tr>
            <td>Lead agent</td>
            <td className="muted small">{project.default_lead_agent || <span className="muted">None</span>}</td>
            <td className="muted small"><span className="muted">Inherits project</span></td>
            <td><strong>{f.leadAgent || project.default_lead_agent || 'None'}</strong></td>
          </tr>
          <tr>
            <td>Budget</td>
            <td className="muted small">{effectiveKiro ? `${engines.budgetCredits ?? 20} credits` : `$${engines.budgetUsd ?? 5}`}</td>
            <td className="muted small"><span className="muted">Inherits portal</span></td>
            <td><strong>{effectiveBudget}</strong></td>
          </tr>
          <tr>
            <td>Agent pushes</td>
            <td className="muted small">{engines.pushMode || 'never'}</td>
            <td className="muted small"><span className="muted">Inherits portal</span></td>
            <td><strong>{effectivePushMode}</strong></td>
          </tr>
        </tbody>
      </table>
      <p className="muted small">
        <button type="button" className="btn-link small" onClick={() => setMore(true)}>Change session-level values</button>
        {' · '}
        <a href="#/settings" className="small">Portal settings</a>
        {project.id ? <>{' · '}<a href={`#/p/${project.id}/setup`} className="small">Project settings</a></> : null}
      </p>
    </div>
  );
}

// ─── Loop spec picker (shown at top of NewSessionDialog for sessions) ─────────

export function LoopSpecPicker({ projectId, value, onChange }) {
  const specs = useLoad(() => api.get(`/api/projects/${projectId}/loop-specs`), [projectId]);
  const list = specs.data?.specs ?? [];
  if (!list.length) return null;
  return (
    <div className="ls-dialog-picker">
      <label className="field-label" htmlFor="ls-pick">Loop spec</label>
      <div className="ls-picker-options" role="radiogroup" aria-label="Loop spec">
        <label className={cx('ls-pick-opt', !value && 'is-active')}>
          <input type="radio" name="ls-pick" value="" checked={!value} onChange={() => onChange(null)} />
          <span>Blank</span>
        </label>
        {list.map((s) => (
          <label key={s.id} className={cx('ls-pick-opt', value?.id === s.id && 'is-active')} title={s.description}>
            <input type="radio" name="ls-pick" value={s.id} checked={value?.id === s.id} onChange={() => onChange(s)} />
            <span>{s.name}</span>
          </label>
        ))}
      </div>
      {value ? (
        <p className="field-hint muted small">
          Spec pre-fills goal, verification, stop rules, and push mode. You can change anything.
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Tools for this session" row shown in the New session dialog.
 * - Web browser checkbox: attaches the built-in browser integration
 * - AWS (read-only) checkbox: shown when an AWS integration exists (needs uv)
 */
export function SessionToolsRow({ integrations, setIntegrations, packs, awsIntegrations, builtinBrowserId }) {
  const { user } = useApp();
  const isAdmin = Boolean(user?.is_admin);
  const [uvInstallError, setUvInstallError] = useState(null);

  const uvPack      = (packs || []).find((p) => p.id === 'uv');
  const browserPack = (packs || []).find((p) => p.id === 'browser');

  const browserAvailable = browserPack?.status === 'available';
  const uvAvailable = uvPack?.status === 'available';

  const browserId = builtinBrowserId || 'in_browser_builtin__v1';
  const browserOn = integrations.includes(browserId);

  const toggleBrowser = (on) => {
    if (on) {
      if (!integrations.includes(browserId)) setIntegrations([...integrations, browserId]);
    } else {
      setIntegrations(integrations.filter((id) => id !== browserId));
    }
  };

  const toggleAws = (awsId, on) => {
    if (on) {
      if (!integrations.includes(awsId)) setIntegrations([...integrations, awsId]);
    } else {
      setIntegrations(integrations.filter((id) => id !== awsId));
    }
  };

  const nonAdminHint = 'Ask an admin to install this under Settings \u203a Tools.';

  return (
    <div className="session-tools-row">
      <span className="field-label">Tools for this session</span>
      <div className="session-tools-checks">
        {/* Web browser */}
        <div className="session-tool-item">
          <label className="session-tool-check">
            <input
              type="checkbox"
              checked={browserOn}
              onChange={(e) => toggleBrowser(e.target.checked)}
              disabled={!browserAvailable}
              aria-describedby="session-tool-browser-hint"
            />
            <span>Web browser</span>
          </label>
          <span id="session-tool-browser-hint" className="session-tool-hint">
            {browserAvailable
              ? 'A headless browser (Playwright MCP) the agents can drive.'
              : isAdmin
                ? <>Browser not running. Start it: <code>docker compose --profile browser up -d</code></>
                : nonAdminHint}
          </span>
        </div>

        {/* AWS (read-only) — only if AWS integrations exist */}
        {(awsIntegrations || []).map((awsInt) => {
          const awsOn = integrations.includes(awsInt.id);
          const disabled = !uvAvailable;
          return (
            <div key={awsInt.id} className="session-tool-item">
              <div className="row tight">
                <label className="session-tool-check">
                  <input
                    type="checkbox"
                    checked={awsOn}
                    onChange={(e) => toggleAws(awsInt.id, e.target.checked)}
                    disabled={disabled}
                    aria-describedby={`session-tool-aws-hint-${awsInt.id}`}
                  />
                  <span>AWS (read-only)</span>
                </label>
                {disabled && isAdmin ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      setUvInstallError(null);
                      try {
                        await api.post('/api/tools/uv/install');
                      } catch (e) {
                        setUvInstallError(e?.message || String(e));
                      }
                    }}
                  >
                    Install uv
                  </Button>
                ) : null}
              </div>
              {uvInstallError ? (
                <p className="session-tool-hint" role="alert" style={{ color: 'var(--color-danger, #c00)' }}>
                  Install failed: {uvInstallError}
                </p>
              ) : null}
              <span id={`session-tool-aws-hint-${awsInt.id}`} className="session-tool-hint">
                {disabled
                  ? isAdmin
                    ? <><a href="#/settings">Install uv under Settings › Tools</a> to use AWS integrations.</>
                    : nonAdminHint
                  : `${awsInt.name}: CloudWatch, DynamoDB, Lambda and more (read-only).`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
