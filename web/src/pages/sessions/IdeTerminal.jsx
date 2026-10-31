/**
 * Terminal panel — lazy-loads xterm.js on first open.
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
 *   height: number,
 * }} props
 */
export function IdeTerminal({ workflowId, height }) {
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

  const innerStyle = { height: height - 32, minHeight: 80, display: 'flex', flexDirection: 'column', overflow: 'hidden' };

  if (!capability) {
    return (
      <div style={innerStyle}>
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <div className="spinner" aria-label="Checking terminal availability…" />
        </div>
      </div>
    );
  }

  if (!capability.available) {
    return (
      <div style={innerStyle}>
        <div className="ws-placeholder" style={{ padding: '16px', gap: 6 }}>
          <Icon name="terminal" size={28} />
          <p style={{ fontSize: '0.84rem' }}>{capability.reason ?? 'Terminal disabled'}</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={innerStyle}>
        <div className="error-note" style={{ margin: 12 }} role="alert">
          Failed to load terminal: {loadError}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { _loadingMod = null; _termMod = null; setTermComponent(null); setLoadError(null); }} style={{ marginLeft: 8 }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!TermComponent) {
    return (
      <div style={innerStyle}>
        <div style={{ display: 'grid', placeItems: 'center', flex: 1 }}>
          <div className="spinner" aria-label="Loading terminal…" />
        </div>
      </div>
    );
  }

  return (
    <div style={innerStyle}>
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
