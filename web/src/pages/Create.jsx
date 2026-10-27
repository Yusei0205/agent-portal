import { useState } from 'react';
import { Diagrams } from './Diagrams.jsx';
import { GeneratedDocs } from './GeneratedDocs.jsx';
import { Presentations } from './Presentations.jsx';

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
    <div className="create-hub">
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
