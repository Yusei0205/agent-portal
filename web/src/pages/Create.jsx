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
import { useProject } from '../lib/context.js';
import { href } from '../lib/router.js';
import { EmbeddedContext, PageHeader, Tabs } from '../components/ui.jsx';
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

export function Create({ route }) {
  const { project } = useProject();
  const current = CREATE_TAB_LIST.find((t) => t.value === route.rest[0]) || CREATE_TAB_LIST[0];
  const inner = innerRoute(route);
  return (
    <div className="page wide">
      <PageHeader title="Create" sub="Diagrams, documents and decks an agent writes from your repositories and knowledge, and the templates they follow." />
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
