/**
 * Create
 *
 * One menu entry for everything an agent produces for the project. Each tab has its own address,
 * #/p/<id>/create/<tab>[/<item>]:
 *   diagrams | documents | decks | templates
 * The tabs show the Diagrams, Generated docs and Presentations pages in place, plus this project's Word and PowerPoint
 * templates (the portal-wide defaults stay in Settings). Older addresses (#/p/<id>/diagrams, /documents,
 * /presentations) redirect here (see lib/router.js).
 */
import { useState } from 'react';
import { api } from '../lib/api.js';
import { useProject } from '../lib/context.js';
import { href } from '../lib/router.js';
import { EmbeddedContext, PageHeader, Tabs, Toggle, useUi } from '../components/ui.jsx';
import { Diagrams } from './Diagrams.jsx';
import { GeneratedDocs } from './GeneratedDocs.jsx';
import { Presentations } from './Presentations.jsx';
import { Templates } from './Templates.jsx';

export const CREATE_TAB_LIST = [
  { value: 'diagrams', label: 'Diagrams' },
  { value: 'documents', label: 'Documents' },
  { value: 'decks', label: 'Decks' },
  { value: 'templates', label: 'Templates' },
];

/** The route the page inside a tab sees: the part of the address after the tab, with the same query. */
function innerRoute(route) {
  return { ...route, rest: route.rest.slice(1) };
}

/**
 * The project setting "Save generated files to the Vault": a copy of every diagram, document and deck goes to the
 * project vault's generated/ folder (latest version only; runs do not get that folder). Owners change it.
 */
function VaultSetting() {
  const { project, isOwner, reload } = useProject();
  const { toast } = useUi();
  const [busy, setBusy] = useState(false);
  const on = project.vault_generated !== 0 && project.vault_generated !== false;
  const change = async (value) => {
    setBusy(true);
    try {
      await api.patch(`/api/projects/${project.id}`, { vaultGenerated: value });
      await reload();
      toast(value ? 'Generated files are saved to the Vault' : 'Generated files are no longer saved to the Vault');
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row tight wrap create-vault-setting">
      <Toggle checked={on} disabled={!isOwner || busy} onChange={change} label="Save generated files to the Vault" />
      <span className="muted small">
        {on ? 'A copy of each diagram, document and deck is kept in the ' : 'Turn on to keep a copy of each diagram, document and deck in the '}
        <a href={href(project.id, 'vault')}>project Vault</a> under <code>generated/</code> (latest version only; runs do not get that folder).
        {isOwner ? '' : ' Only project owners can change this.'}
      </span>
    </div>
  );
}

export function Create({ route }) {
  const { project } = useProject();
  const current = CREATE_TAB_LIST.find((t) => t.value === route.rest[0]) || CREATE_TAB_LIST[0];
  const inner = innerRoute(route);
  return (
    <div className="page wide">
      <PageHeader title="Create" sub="Diagrams, documents and decks an agent writes from your repositories and knowledge, and the templates they follow." />
      <VaultSetting />
      <Tabs value={current.value} tabs={CREATE_TAB_LIST.map((t) => ({ ...t, href: href(project.id, 'create', t.value) }))} />
      <div className="hub-body" role="region" aria-label={current.label}>
        <EmbeddedContext.Provider value>
          {current.value === 'diagrams' ? (
            <Diagrams route={inner} />
          ) : current.value === 'documents' ? (
            <GeneratedDocs route={inner} />
          ) : current.value === 'decks' ? (
            <Presentations route={inner} />
          ) : (
            <Templates />
          )}
        </EmbeddedContext.Provider>
      </div>
    </div>
  );
}
