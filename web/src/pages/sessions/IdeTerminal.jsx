/**
 * Terminal panel — lazy-loads xterm.js on first open.
 *
 * Layout fix: the outer container uses flex:1 to fill whatever height the
 * parent panel flex-column gives it, rather than computing an explicit pixel
 * height.  The old `height - 32` arithmetic was double-subtracting 32 px
 * (the panel header had already been excluded by the parent before passing the
 * prop), leaving the terminal 32 px shorter than its allocated space and making
 * FitAddon miscalculate the available rows.
 */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Icon } from '../../components/Icon.jsx';

let _termMod = null;
let _loadingMod = null;

function loadTerminalModule() {
  if (_termMod) return Promise.resolve(_termMod);
  if (_loadingMod) return _loadingMod;
  _loadingMod = import('./xterm-terminal.jsx').then((m) => {
    _termMod = m;
    return m;
  });
  return _loadingMod;
}

/**
 * @param {{
 *   workflowId: string,
 *   height?: number,  // kept for API compat; no longer used for sizing
 * }} props
 */
export function IdeTerminal({ workflowId }) {
  const [capability, setCapability] = useState(null);
  const [TermComponent, setTermComponent] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [key, setKey] = useState(0); // increment to reconnect

  useEffect(() => {
    api.get('/api/terminal/capability')
      .then((data) => setCapability(data))
      .catch(() => setCapability({ available: false, reason: 'Could not check terminal availability' }));
  }, []);

  useEffect(() => {
    if (!capability?.available) return;
    loadTerminalModule()
      .then((m) => setTermComponent(() => m.XtermTerminal))
      .catch((e) => setLoadError(e.message));
  }, [capability?.available]);

  // Fill remaining space in the ide-terminal-panel flex column.
  // position:relative anchors the absolutely-positioned reconnect button.
  const outerStyle = {
    flex: 1,
    minHeight: 80,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    position: 'relative',
  };

  if (!capability) {
    return (
      <div style={outerStyle}>
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <div className="spinner" aria-label="Checking terminal availability…" />
        </div>
      </div>
    );
  }

  if (!capability.available) {
    return (
      <div style={outerStyle}>
        <div className="ws-placeholder" style={{ padding: '16px', gap: 6 }}>
          <Icon name="terminal" size={28} />
          <p style={{ fontSize: '0.84rem' }}>{capability.reason ?? 'Terminal disabled'}</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={outerStyle}>
        <div className="error-note" style={{ margin: 12 }} role="alert">
          Failed to load terminal: {loadError}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => { _loadingMod = null; _termMod = null; setTermComponent(null); setLoadError(null); }}
            style={{ marginLeft: 8 }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!TermComponent) {
    return (
      <div style={outerStyle}>
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <div className="spinner" aria-label="Loading terminal…" />
        </div>
      </div>
    );
  }

  return (
    <div style={outerStyle}>
      <TermComponent
        key={key}
        workflowId={workflowId}
        onClose={() => setKey((k) => k + 1)}
      />
      <div style={{ position: 'absolute', top: 4, right: 8, display: 'flex', gap: 4 }}>
        <button
          type="button"
          className="btn-icon"
          title="Reconnect terminal"
          aria-label="Reconnect terminal"
          style={{ color: 'var(--ink-3)', background: 'transparent' }}
          onClick={() => setKey((k) => k + 1)}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>
    </div>
  );
}
