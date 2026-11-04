import { useState } from 'react';
import { Diagrams } from './Diagrams.jsx';
import { GeneratedDocs } from './GeneratedDocs.jsx';
import { Presentations } from './Presentations.jsx';
import { PageHeader, SectionHead } from '../components/PageHeader.jsx';
import { CreateActivity } from '../components/CreateActivity.jsx';

const TABS = [
  { id: 'diagrams',  label: 'Diagrams' },
  { id: 'documents', label: 'Documents' },
  { id: 'decks',     label: 'Decks' },
];

/**
 * Create hub — tabs for Diagrams, Documents, Decks.
 *
 * @param {{ projectId: string }} props
 */
export function Create({ projectId }) {
  const [activeTab, setActiveTab] = useState('diagrams');

  return (
    <div className="page create-hub">
      <PageHeader title="Create" description="Generate architecture diagrams, Word documents and slide decks from your repositories and knowledge." />
      <CreateActivity projectId={projectId} />
      <div className="tab-bar" role="tablist" aria-label="Create">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`create-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`create-panel-${tab.id}`}
            className={`tab-btn${activeTab === tab.id ? ' is-active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`create-panel-${activeTab}`}
        aria-labelledby={`create-tab-${activeTab}`}
      >
        {activeTab === 'diagrams' ? (
          <Diagrams projectId={projectId} />
        ) : activeTab === 'documents' ? (
          <GeneratedDocs projectId={projectId} />
        ) : (
          <Presentations projectId={projectId} />
        )}
      </div>
    </div>
  );
}
