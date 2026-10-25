import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useProject } from '../../lib/context.js';
import { useProjectEvents } from '../../lib/events.js';
import { useLoad } from '../../lib/useAsync.js';
import { go, sessionHref } from '../../lib/router.js';
import { TicketPreview } from '../../components/TicketPreview.jsx';
import { Empty, ErrorNote, Spinner, Tabs } from '../../components/ui.jsx';
import { SessionSettings } from './SessionSettings.jsx';
import { PendingBanner, SpecInfoPanel, VerifResults } from './SessionBanners.jsx';
import { SessionHeader } from './SessionHeader.jsx';
import { LiveTab, askedFor } from './SessionLive.jsx';
import { ChangesTab } from './SessionChanges.jsx';
import { History } from './SessionHistory.jsx';
import { Composer } from './SessionComposer.jsx';
import { ContextTab } from './SessionContext.jsx';
import { OutputBanner } from './SessionOutput.jsx';

const TABS = ['live', 'changes', 'history', 'context', 'settings'];

/** One session: what its agents are doing now, what changed, what happened, and a box to steer it. */
export function SessionWorkspace({ id, query }) {
  const { project, canEdit } = useProject();
  const data = useLoad(() => api.get(`/api/workflows/${id}`), [id]);
  const timer = useRef(null);
  useProjectEvents(['workflow.updated', 'workflow.deleted'], (event, payload) => {
    if (payload?.id && payload.id !== id) return;
    if (event === 'workflow.deleted') return go(project.id, 'sessions');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => data.reload(true), 250);
  });
  // The diagram, document or deck this session makes can change without the session changing (stored, failed, deleted).
  useProjectEvents(['diagrams.updated', 'generated-docs.updated', 'presentations.updated'], () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => data.reload(true), 250);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  // Keep a local copy of the workflow row so command results can refresh the header chips
  // immediately (without waiting for a server-sent event or a full reload).
  const [localWorkflow, setLocalWorkflow] = useState(null);
  const handleWorkflowChange = useCallback((updated) => {
    setLocalWorkflow(updated);
    // Also schedule a background reload so everything else catches up.
    data.reload(true);
  }, [data]);

  const w = localWorkflow || data.data?.workflow;
  // Leads for the header's agent-kind label. Hooks must run before the early returns below.
  const effectiveKiro = w?.provider === 'kiro';
  const leadsData = useLoad(() => api.get(`/api/projects/${project.id}/leads?engine=${effectiveKiro ? 'kiro' : 'claude'}`), [project.id, effectiveKiro]);
  if (data.error) return <div className="pad-lg"><ErrorNote error={data.error} /></div>;
  if (!w) return <div className="pad-lg"><Spinner /></div>;

  const tab = TABS.includes(query.get('tab')) ? query.get('tab') : 'live';
  // The run shown in Live: one picked from the iteration strip or history, else the latest.
  const runs = data.data.runs || [];
  const runId = runs.some((r) => r.id === query.get('run')) ? query.get('run') : w.last_run_id;
  const link = (params) => sessionHref(project.id, w.id, params);

  return (
    <div className="ws-detail">
      <SessionHeader w={w} canEdit={canEdit} reload={() => data.reload(true)} leads={leadsData.data?.leads} />
      <OutputBanner output={data.data.output} />
      <Tabs
        value={tab}
        tabs={[
          { value: 'live', label: 'Live', href: link({}) },
          { value: 'changes', label: 'Changes', href: link({ tab: 'changes' }) },
          { value: 'history', label: 'Activity', href: link({ tab: 'history' }), count: data.data.events.filter((e) => e.kind === 'human' && !e.consumed).length || undefined },
          { value: 'context', label: 'Context', href: link({ tab: 'context' }), count: w.context_count || undefined },
          { value: 'settings', label: 'Settings', href: link({ tab: 'settings' }) },
        ]}
      />
      {/* Push / approval sticky banner — visible on every tab */}
      <PendingBanner w={w} canEdit={canEdit} onDone={() => data.reload(true)} />
      <div className="ws-body">
        {tab === 'live' ? (
          runId ? (
            <LiveTab key={runId} runId={runId} isLatest={runId === w.last_run_id} runs={runs} link={link} asked={askedFor(w, data.data.events, runId)} output={data.data.output} />
          ) : (
            <Empty icon="runs" title="Nothing has run yet">{w.status === 'running' ? 'The first iteration is starting…' : 'Resume the session or send it an instruction to start.'}</Empty>
          )
        ) : tab === 'changes' ? (
          <ChangesTab w={w} canEdit={canEdit} />
        ) : tab === 'history' ? (
          <History events={data.data.events} link={link} canEdit={canEdit} />
        ) : tab === 'context' ? (
          <ContextTab w={w} canEdit={canEdit} />
        ) : (
          <div className="stack-lg">
            {w.jira_key ? (
              <details className="panel" open>
                <summary>Jira ticket {w.jira_key}</summary>
                <TicketPreview projectId={project.id} ticketKey={w.jira_key} />
              </details>
            ) : null}
            {/* Which spec/trigger started this session */}
            {w.loop_spec_id ? (
              <details className="panel">
                <summary>Loop spec</summary>
                <SpecInfoPanel specId={w.loop_spec_id} projectId={project.id} />
              </details>
            ) : null}
            {/* Verification results per iteration */}
            {w.loop_run_state?.last_check ? (
              <details className="panel" open>
                <summary>Last verification</summary>
                <VerifResults check={w.loop_run_state.last_check} />
              </details>
            ) : null}
            <SessionSettings workflow={w} canEdit={canEdit} onSaved={() => data.reload(true)} />
          </div>
        )}
      </div>
      <Composer workflow={w} canEdit={canEdit} onSent={() => data.reload(true)} onWorkflowChange={handleWorkflowChange} />
    </div>
  );
}
