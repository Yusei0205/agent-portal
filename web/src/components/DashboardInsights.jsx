/**
 * Two panels for the Dashboard that answer "what needs me?" and "how are the runs going?":
 *   - AttentionPanel: what is waiting on the person (the inbox: approvals, questions, blocked or cut-off turns, review-ready),
 *     sessions the idle check is about to close, and recent sessions that failed.
 *   - RunsTrendPanel: runs per day (done / failed / stopped by the person) with the average run time.
 */

import { useState, useEffect, useMemo } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { api } from '../lib/api.js';
import { href } from '../lib/router.js';
import { Icon } from './Icon.jsx';

const INBOX_LABELS = {
  approval: 'Needs approval',
  push: 'Push approval',
  question: 'Question for you',
  blocked: 'Blocked',
  'review-ready': 'Review ready',
};
const TONE_ORDER = { danger: 0, warn: 1, info: 2 };
const MAX_SHOWN = 6;

function inboxLabel(item) {
  if (item.type === 'blocked' && item.payload?.kind === 'turn-interrupted') return 'Turn cut off';
  return INBOX_LABELS[item.type] || 'Needs attention';
}

function inboxTone(item) {
  if (item.type === 'blocked') return 'danger';
  if (item.type === 'review-ready') return 'info';
  return 'warn';
}

function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** "closes in 4 min" / "closing now" for a stop time, against the viewer's clock. */
export function closesIn(stopAt, nowMs = Date.now()) {
  const left = Date.parse(stopAt) - nowMs;
  if (!Number.isFinite(left)) return '';
  if (left <= 30_000) return 'closing now';
  const min = Math.ceil(left / 60_000);
  return `closes in ${min} min`;
}

/**
 * Everything that wants the person, most urgent first: one row per thing. A failed or blocked recent session that already has an
 * inbox item is not listed twice.
 */
export function buildAttention({ inbox = [], idleClosing = [], recentSessions = [], nowMs = Date.now() }) {
  const rows = [];
  const inInbox = new Set();
  for (const item of inbox) {
    if (item.workflow_id) inInbox.add(item.workflow_id);
    rows.push({
      key: `inbox-${item.id}`,
      tone: inboxTone(item),
      label: inboxLabel(item),
      title: clip(item.workflow_goal || item.payload?.title || item.payload?.question || 'Session', 70),
      detail: clip(item.payload?.message || item.payload?.description || item.payload?.question || '', 140),
      project: item.project_name || '',
      href: item.project_id && item.workflow_id ? href(item.project_id, 'sessions', item.workflow_id) : '#/inbox',
    });
  }
  for (const s of recentSessions) {
    if ((s.status !== 'failed' && s.status !== 'blocked') || inInbox.has(s.id)) continue;
    rows.push({
      key: `session-${s.id}`,
      tone: 'danger',
      label: s.status === 'failed' ? 'Session failed' : 'Session blocked',
      title: clip(s.title || `Session ${String(s.id).slice(0, 8)}`, 70),
      detail: '',
      project: s.projectName || '',
      href: href(s.projectId, 'sessions', s.id),
    });
  }
  for (const s of idleClosing) {
    rows.push({
      key: `idle-${s.id}`,
      tone: 'warn',
      label: closesIn(s.stopAt, nowMs) === 'closing now' ? 'Closing now' : 'Idle, closing soon',
      title: clip(s.title || `Session ${String(s.id).slice(0, 8)}`, 70),
      detail: closesIn(s.stopAt, nowMs) === 'closing now' ? 'It has been idle too long. Send a message to keep it open.' : `${closesIn(s.stopAt, nowMs)} unless you send a message.`,
      project: s.projectName || '',
      href: href(s.projectId, 'sessions', s.id),
    });
  }
  return rows.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}

export function AttentionPanel({ idleClosing, recentSessions, projectFilter, refreshKey }) {
  const [inbox, setInbox] = useState(null);
  const [inboxTotal, setInboxTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.get('/api/inbox?limit=50')
      .then((r) => {
        if (cancelled) return;
        const items = (r.items || []).filter((i) => !projectFilter || i.project_id === projectFilter);
        setInbox(items);
        setInboxTotal(projectFilter ? items.length : (r.total ?? items.length));
      })
      // The inbox is the page's own thing: if it cannot be read the rest of the panel still says what it can.
      .catch(() => { if (!cancelled) { setInbox([]); setInboxTotal(0); } });
    return () => { cancelled = true; };
  }, [projectFilter, refreshKey]);

  const rows = useMemo(
    () => buildAttention({ inbox: inbox || [], idleClosing: idleClosing || [], recentSessions: recentSessions || [] }),
    [inbox, idleClosing, recentSessions],
  );
  const shown = rows.slice(0, MAX_SHOWN);
  const hidden = Math.max(rows.length - shown.length, inboxTotal - (inbox || []).length, 0);

  return (
    <section className={`panel db-attn${inbox !== null && rows.length === 0 ? ' is-clear' : ''}`} aria-label="Needs attention">
      <div className="db-panel-header">
        <h2 className="db-panel-title">
          <Icon name={inbox !== null && rows.length === 0 ? 'check' : 'warning'} size={16} aria-hidden="true" />
          Needs attention
          {rows.length > 0 && <span className="db-attn-count" aria-label={`${rows.length} items`}>{rows.length}</span>}
        </h2>
        <a href="#/inbox" className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }}>Open inbox</a>
      </div>
      {inbox === null ? (
        <div className="skeleton skeleton-row" />
      ) : rows.length === 0 ? (
        <p className="db-attn-clear">
          <Icon name="check" size={14} aria-hidden="true" /> Nothing needs you right now.
        </p>
      ) : (
        <ul className="db-attn-list" role="list">
          {shown.map((r) => (
            <li key={r.key} className={`db-attn-item is-${r.tone}`}>
              <span className="db-attn-label">{r.label}</span>
              <a href={r.href} className="db-attn-title" title={r.title}>{r.title}</a>
              {r.project && <span className="muted db-attn-project">{r.project}</span>}
              {r.detail && <span className="muted db-attn-detail">{r.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && <p className="muted" style={{ fontSize: '0.78rem', margin: '8px 0 0' }}>+{hidden} more in the inbox</p>}
    </section>
  );
}

function fmtMinutes(ms) {
  if (!ms) return '0';
  return (ms / 60_000).toFixed(ms < 600_000 ? 1 : 0);
}

export function RunsTrendPanel({ daily, period, onPeriodChange }) {
  const days = daily || [];
  const total = days.reduce((s, d) => s + d.done + d.failed + d.cancelled, 0);
  const done = days.reduce((s, d) => s + d.done, 0);
  const failed = days.reduce((s, d) => s + d.failed, 0);
  const stopped = days.reduce((s, d) => s + d.cancelled, 0);
  const data = useMemo(() => days.map((d) => ({ ...d, avgMin: Math.round((d.avgDurationMs / 60_000) * 10) / 10 })), [days]);

  return (
    <section className="panel db-trend" aria-label="Runs per day">
      <h2 className="db-panel-title">
        <Icon name="chart" size={16} aria-hidden="true" />
        Runs per day
        <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: '0.8rem' }}>
          last {period === '30d' ? 30 : 7} days (UTC days)
        </span>
      </h2>
      {total === 0 ? (
        <div className="db-monitor-empty">
          <Icon name="chart" size={26} aria-hidden="true" />
          <p className="muted">No runs finished in this period.</p>
          {onPeriodChange && period !== '30d' && <button type="button" className="btn btn-sm" onClick={() => onPeriodChange('30d')}>Show last 30 days</button>}
          {period === '30d' && <p className="muted small">Completed runs will appear here.</p>}
        </div>
      ) : (
        <>
          <p className="sr-only">
            {total} runs in the last {days.length} days: {done} done, {failed} failed, {stopped} stopped by you.
          </p>
          <ResponsiveContainer width="100%" height={210}>
            <ComposedChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
              <YAxis yAxisId="runs" allowDecimals={false} tick={{ fontSize: 11 }} width={34} />
              <YAxis yAxisId="min" orientation="right" tick={{ fontSize: 11 }} width={40} tickFormatter={(v) => `${v}m`} />
              <Tooltip formatter={(v, name) => (name === 'Avg run time' ? [`${fmtMinutes(v * 60_000)} min`, name] : [v, name])} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar yAxisId="runs" dataKey="done" name="Done" stackId="runs" fill="var(--ok)" />
              <Bar yAxisId="runs" dataKey="failed" name="Failed" stackId="runs" fill="var(--danger)" />
              <Bar yAxisId="runs" dataKey="cancelled" name="Stopped by you" stackId="runs" fill="var(--ink-3)" />
              <Line yAxisId="min" type="monotone" dataKey="avgMin" name="Avg run time" stroke="var(--accent)" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </>
      )}
    </section>
  );
}
