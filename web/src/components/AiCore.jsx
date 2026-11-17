import { useEffect, useRef, useState } from 'react';

const STATE_TEXT = {
  idle: 'idle',
  running: 'agents are running',
  success: 'the last run succeeded',
  failed: 'a run failed',
};

let webgl;
function hasWebgl() {
  if (webgl === undefined) {
    try {
      const c = document.createElement('canvas');
      webgl = Boolean(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { webgl = false; }
  }
  return webgl;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * The portal's AI core. It shows a state the portal really is in: idle (slow breathing), running (fast spin, rings turning),
 * success or failed. A CSS orb is drawn first (and kept when WebGL is not available); the 3D core replaces it once it has loaded.
 * With motion off (the person's setting or `animated={false}`) the 3D core is one still frame.
 *
 * @param {{ state?: 'idle'|'running'|'success'|'failed', size?: number, animated?: boolean, className?: string }} props
 */
export function AiCore({ state = 'idle', size = 120, animated = true, className = '' }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const ctrlRef = useRef(null);
  const [ready, setReady] = useState(false);
  const reduced = usePrefersReducedMotion();
  const live = animated && !reduced;
  const use3d = hasWebgl();

  // The first state and motion setting are read when the scene is made; later changes go through the two effects below.
  const initial = useRef({ state, live });
  initial.current = { state, live };

  useEffect(() => {
    if (!use3d) return undefined;
    let cancelled = false;
    let ctrl = null;
    import('./ai-core-scene.js').then(({ createCore }) => {
      if (cancelled || !canvasRef.current || !hostRef.current) return;
      try {
        ctrl = createCore(canvasRef.current, hostRef.current, { state: initial.current.state, animated: initial.current.live });
        ctrlRef.current = ctrl;
        setReady(true);
      } catch { /* WebGL could not start: the CSS orb stays */ }
    }).catch(() => { /* the 3D chunk did not load: the CSS orb stays */ });
    return () => { cancelled = true; ctrl?.dispose(); ctrlRef.current = null; setReady(false); };
  }, [use3d]);

  useEffect(() => { ctrlRef.current?.setState(state); }, [state, ready]);
  useEffect(() => { ctrlRef.current?.setAnimated(live); }, [live, ready]);

  return (
    <div
      ref={hostRef}
      className={`ai-core ai-core--${state}${ready ? ' is-3d' : ''}${live ? ' is-live' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`AI core: ${STATE_TEXT[state] ?? STATE_TEXT.idle}`}
    >
      <span className="ai-core-orb" aria-hidden="true" />
      {use3d && <canvas ref={canvasRef} className="ai-core-canvas" aria-hidden="true" />}
    </div>
  );
}
