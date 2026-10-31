import { IdeWorkspace } from './IdeWorkspace.jsx';

/**
 * Session workspace (right panel) — delegates to IdeWorkspace.
 *
 * @param {{
 *   id: string,
 *   project: { id: string, name: string },
 * }} props
 */
export function SessionWorkspace({ id, project }) {
  return <IdeWorkspace id={id} project={project} />;
}
