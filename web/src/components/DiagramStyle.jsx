import { useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { href } from '../lib/router.js';
import { useLoad } from '../lib/useAsync.js';
import { cx } from '../lib/util.js';
import { Note } from './ui.jsx';

/**
 * Drawing style for diagrams an agent makes (D-14): "Quick sketch" (Mermaid text, drawn in the page) or "Icon diagram"
 * (draw.io with the official AWS, Azure, Google Cloud and Kubernetes icons, which needs the Icon diagrams tool pack).
 * The diagram, document and presentation list responses carry `styles`, `clouds` and `defaultCloud`; the choice is sent as
 * `style`/`cloud` (diagrams) or `diagramStyle`/`diagramCloud` (documents and decks) and remembered per project.
 */

export const STYLE_WORDS = {
  mermaid: 'Quick sketch (Mermaid)',
  icon: 'Icon diagram (draw.io, official cloud icons)',
};
const STYLE_HINT = {
  mermaid: 'A text diagram drawn in the page. Fast, works everywhere.',
  icon: 'Official service icons in nested boxes with labelled arrows, as in cloud reference architectures. Stored as a .drawio file you can open in draw.io.',
};

const STORE_KEY = (projectId) => `diagram-style:${projectId}`;

/** The style and cloud last used in this project in this browser, or null. */
export function rememberedStyle(projectId) {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY(projectId)) || 'null');
    return v && (v.style === 'mermaid' || v.style === 'icon') ? v : null;
  } catch {
    return null;
  }
}

/** Remember a choice for the project (storage can be blocked, which is fine). */
export function rememberStyle(projectId, value) {
  try {
    localStorage.setItem(STORE_KEY(projectId), JSON.stringify({ style: value.style, cloud: value.cloud }));
  } catch {
    /* private mode or storage disabled: the choice is simply not remembered */
  }
}

/** Is the icon style usable now? */
export const iconAvailable = (data) => Boolean(data?.styles?.find((s) => s.id === 'icon')?.available);

/**
 * The starting choice of a dialog: the item's stored values (refresh, regenerate), else what was last used in the project,
 * else Mermaid. The icon style is never preselected when it cannot be used.
 * @param {string} projectId
 * @param {{ styles?: any[], clouds?: any[], defaultCloud?: string } | null | undefined} data A list response
 * @param {{ style?: string | null, cloud?: string | null }} [stored]
 */
export function initialStyle(projectId, data, stored) {
  const remembered = stored ? null : rememberedStyle(projectId);
  // An item that is already icon-styled keeps it in its dialog even if the pack is gone; the server then refuses with the reason.
  const wantIcon = (stored?.style ?? remembered?.style) === 'icon';
  const clouds = data?.clouds || [];
  const cloud = stored?.cloud || remembered?.cloud || data?.defaultCloud || 'aws';
  return {
    style: wantIcon && (stored?.style === 'icon' || iconAvailable(data)) ? 'icon' : 'mermaid',
    cloud: clouds.length && !clouds.some((c) => c.id === cloud) ? data?.defaultCloud || 'aws' : cloud,
  };
}

/** The request fields for a diagram (`style`, `cloud`). */
export function diagramStyleBody(v) {
  return v.style === 'icon' ? { style: 'icon', cloud: v.cloud } : { style: 'mermaid' };
}

/** The request fields for a document or a deck (`diagramStyle`, `diagramCloud`; the cloud is '' for Mermaid). */
export function docStyleBody(v) {
  return v.style === 'icon' ? { diagramStyle: 'icon', diagramCloud: v.cloud } : { diagramStyle: 'mermaid', diagramCloud: '' };
}

/**
 * The cloud the repositories point to (GET .../diagrams/detect-cloud), looked up while the icon style is chosen and
 * repositories are picked.
 */
export function useDetectedCloud(projectId, repoIds, enabled) {
  const key = repoIds.join(',');
  return useLoad(
    () => (enabled && key ? api.get(`/api/projects/${encodeURIComponent(projectId)}/diagrams/detect-cloud?repoIds=${encodeURIComponent(key)}`) : Promise.resolve(null)),
    [projectId, key, enabled],
  );
}

/**
 * Preselect the detected cloud once per set of repositories, unless the person already picked a cloud in this dialog.
 * @param {{ data: any }} detect Result of useDetectedCloud
 * @param {{ style: string, cloud: string }} value
 * @param {(v: { style: string, cloud: string }) => void} onChange
 */
export function useApplyDetectedCloud(detect, value, onChange) {
  const picked = useRef(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const d = detect.data;
  useEffect(() => {
    if (!d || !d.detected || picked.current) return;
    if (latest.current.value.cloud !== d.cloud) latest.current.onChange({ ...latest.current.value, cloud: d.cloud });
  }, [d]);
  return () => {
    picked.current = true;
  };
}

/** Why the picture of an icon diagram cannot be previewed, from whichever response the page has. */
export function previewProblem(data) {
  const fromStyle = data?.styles?.find((s) => s.id === 'icon')?.preview;
  if (fromStyle) return fromStyle.available ? null : fromStyle.reason || 'No picture renderer is available';
  if (data?.iconPreview) return data.iconPreview.available ? null : data.iconPreview.reason || 'No picture renderer is available';
  return null;
}

const NOT_PREVIEWED = {
  diagram: 'The diagram will be stored and can be downloaded as a .drawio file, but it will not be previewed or exported as PNG or SVG here.',
  doc: 'The diagrams will be stored and can be downloaded as .drawio files, but Word shows a placeholder line instead of the picture.',
  deck: 'The diagrams will be stored and can be downloaded as .drawio files, but slides show a placeholder instead of the picture.',
};

/**
 * The style fieldset for a New or Regenerate dialog.
 *
 * @param {object} props
 * @param {object} props.data A list response with `styles`, `clouds` and `defaultCloud`
 * @param {{ style: string, cloud: string }} props.value
 * @param {(v: { style: string, cloud: string }) => void} props.onChange
 * @param {'diagram' | 'doc' | 'deck'} props.what
 * @param {{ data: any, loading: boolean } | null} [props.detect] Detected cloud for the chosen repositories (diagrams)
 * @param {() => void} [props.onCloudPicked]
 * @param {string} [props.name] Radio group name, unique per dialog
 */
export function DiagramStyleFields({ data, value, onChange, what, detect, onCloudPicked, name = 'diagram-style' }) {
  const { user } = useApp();
  const styles = data?.styles || [];
  const clouds = data?.clouds || [];
  if (!styles.length) return null;
  const problem = value.style === 'icon' ? previewProblem(data) : null;
  const wordReason = what === 'doc' && value.style === 'icon' && data?.word && data.word.iconDiagrams === false ? data.word.iconDiagramsReason : null;
  const det = detect?.data;
  return (
    <fieldset className="field" data-testid="diagram-style">
      <legend className="field-label">Drawing style</legend>
      <div className="kind-pick">
        {styles.map((s) => (
          <label key={s.id} className={cx('choice', value.style === s.id && 'is-checked', !s.available && 'is-disabled')}>
            <input type="radio" name={name} value={s.id} checked={value.style === s.id} disabled={!s.available} onChange={() => onChange({ ...value, style: s.id })} />
            <span>
              <strong>{STYLE_WORDS[s.id] || s.label}</strong> <span className="muted">{STYLE_HINT[s.id]}</span>
              {!s.available ? (
                <span className="style-reason small" data-testid="style-reason">
                  <span className="danger">Not available: {s.reason}</span>
                  {user?.is_admin ? (
                    <>
                      {' '}
                      <a href={href(null, 'settings')}>Install in Settings &gt; Tools</a>
                    </>
                  ) : null}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {value.style === 'icon' ? (
        <>
          <label className="field-label" htmlFor={`${name}-cloud`}>
            Cloud
          </label>
          <select
            id={`${name}-cloud`}
            className="input"
            value={value.cloud}
            onChange={(e) => {
              onCloudPicked?.();
              onChange({ ...value, cloud: e.target.value });
            }}
          >
            {clouds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          {detect ? (
            <p className="field-hint" data-testid="cloud-hint">
              {detect.loading && !det
                ? 'Looking at the repositories for the cloud they use…'
                : det
                  ? det.detected
                    ? `Detected from the repositories: ${det.label}${det.signals?.length ? ` (${det.signals.slice(0, 3).join('; ')})` : ''}. Change it if that is not what you want drawn.`
                    : `No cloud found in the repositories, so ${det.label} is suggested. Pick another if the system runs elsewhere.`
                  : 'Pick repositories to see which cloud they use. Without a choice the portal reads them and falls back to AWS.'}
            </p>
          ) : (
            <p className="field-hint">Without a choice the portal reads the repositories for the cloud they use and falls back to AWS.</p>
          )}
        </>
      ) : null}
      {problem ? (
        <Note tone="warn" icon="alert">
          <strong>No preview picture on this server.</strong> {problem}. {NOT_PREVIEWED[what]}
        </Note>
      ) : null}
      {wordReason && wordReason !== problem ? (
        <Note tone="warn" icon="alert">
          In the Word file an icon diagram stays a placeholder line: {wordReason}.
        </Note>
      ) : null}
    </fieldset>
  );
}
