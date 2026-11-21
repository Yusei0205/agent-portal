import { useCallback, useEffect, useRef, useState } from 'react';
import { CatSprite } from './CatSprite.jsx';
import { CatChatPanel } from './CatChatPanel.jsx';
import { CAT_NAME } from '../lib/cat-actions.js';
import { subscribeProject } from '../lib/events.js';
import { loadCatPrefs, saveCatPrefs } from '../lib/cat-prefs.js';
import { createReactionGate, isWorking, moodForEvent, pickMotion, roamPaused, trackRunning } from '../lib/cat-mood.js';
import {
  DRAG_THRESHOLD_PX, REACTION_SHOW_MS, clampX, initialBrain, nextBrainStep, roamAllowed,
} from '../lib/cat-brain.js';

/**
 * The portal's cat companion: a pixel cat that roams along the bottom of the screen on wide screens, can be dragged anywhere, waves
 * when hovered, shows tips, and reacts to the open project's live events (a session finished, failed or is blocked, something needs you
 * in the Inbox). A small menu sets Roam / Sit / Hidden; the choice and the position are remembered in this browser only.
 * No network calls of its own: it listens to the project event stream the page already uses. Colours come from the theme tokens, and
 * under reduced motion nothing moves (the sprites show their first frame).
 */
export const CAT_TIPS = [
  'Things that need you, like approvals and questions, wait in the Inbox.',
  'Press Ctrl+K (⌘K on a Mac) to open the command palette.',
  'Press ? to see every keyboard shortcut.',
  'On the Sessions page, press Alt+N to start a new session.',
  'Upload a file to the Vault once, and every run gets a copy.',
  'A session can push its changes to a new branch or open a pull request.',
  'Loop specs repeat a goal until it is done, blocked or out of budget.',
  'Auto-fix lives in each project’s Setup tab. It is off until you turn it on.',
];

const SHOW_AFTER_MS = 2000;
const AUTO_TIP_MS = 10000;
const LONG_PRESS_MS = 500;
const ANIM_SHOW_MS = 3000;
const EDGE_GAP = 4;
const DEFAULT_RIGHT_GAP = 16;
const PHONE_MAX = 600;
const MODES = [
  { id: 'roam', label: 'Roam' },
  { id: 'sit', label: 'Sit' },
  { id: 'hidden', label: 'Hidden' },
];

function matches(query) {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

function isTyping() {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el || el === document.body) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(el.type);
  return false;
}

function readEnv() {
  return {
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
    reducedMotion: matches('(prefers-reduced-motion: reduce)'),
    typing: isTyping(),
    dialogOpen: typeof document !== 'undefined' && Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
  };
}

const sameEnv = (a, b) => a.width === b.width && a.height === b.height && a.reducedMotion === b.reducedMotion
  && a.typing === b.typing && a.dialogOpen === b.dialogOpen;

const sizeFor = (width) => (width <= PHONE_MAX ? 44 : 56);
const boundsFor = (width, size) => ({ min: EDGE_GAP, max: width - size - EDGE_GAP });

function startX(prefs, width, size) {
  const b = boundsFor(width, size);
  const x = prefs.x == null ? width - size - DEFAULT_RIGHT_GAP : prefs.x * (width - size);
  return clampX(x, b);
}

export function CatMascot({ projectId = null, inboxCount = 0, route = null, user = null }) {
  const [prefs, setPrefs] = useState(() => loadCatPrefs());
  const [env, setEnv] = useState(readEnv);
  const size = sizeFor(env.width);
  const [x, setX] = useState(() => startX(prefs, env.width, size));
  const [ms, setMs] = useState(0);
  const [bottom, setBottom] = useState(prefs.bottom);
  const [walking, setWalking] = useState(false);
  const [dir, setDir] = useState(1); // 1 = facing right (the sprites are drawn that way)
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [bubble, setBubble] = useState(null); // { kind: 'tip' | 'reaction', text, href, id }
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [notice, setNotice] = useState(null); // a reaction said inside the open panel
  const [running, setRunning] = useState(() => new Set()); // ids of the open project's running sessions, from the live events
  const [anim, setAnim] = useState(null); // { name, id } while a reaction plays
  const [tip, setTip] = useState(() => Math.floor(Math.random() * CAT_TIPS.length));

  const bodyRef = useRef(null);
  const buttonRef = useRef(null);
  const panelOpenRef = useRef(false);
  panelOpenRef.current = panelOpen;
  const xRef = useRef(x);
  const brainRef = useRef(null);
  const prefsRef = useRef(prefs);
  const gateRef = useRef(null);
  if (gateRef.current === null) gateRef.current = createReactionGate();
  const seq = useRef(0);
  const animTimer = useRef(null);
  const bubbleTimer = useRef(null);
  const tipTimer = useRef(null);
  const pressTimer = useRef(null);
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const lastVisibleMode = useRef('roam');
  const mountedAt = useRef(Date.now());
  const prevInbox = useRef(inboxCount);
  const bottomRef = useRef(bottom);
  bottomRef.current = bottom;

  prefsRef.current = prefs;

  const updatePrefs = useCallback((patch) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    setPrefs(next);
    saveCatPrefs(next);
  }, []);

  const moveTo = useCallback((nx, transitionMs = 0) => {
    xRef.current = nx;
    setMs(transitionMs);
    setX(nx);
  }, []);

  // The environment the cat reads before it roams: width, motion preference, a focused text field, an open modal dialog.
  useEffect(() => {
    const update = () => setEnv((prev) => { const next = readEnv(); return sameEnv(prev, next) ? prev : next; });
    let mo = null;
    let moTimer = null;
    const onFocus = () => setTimeout(update, 0);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onFocus);
    let mql = null;
    try {
      mql = window.matchMedia('(prefers-reduced-motion: reduce)');
      mql.addEventListener?.('change', update);
    } catch { mql = null; }
    if (typeof MutationObserver === 'function') {
      mo = new MutationObserver(() => { clearTimeout(moTimer); moTimer = setTimeout(update, 200); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onFocus);
      mql?.removeEventListener?.('change', update);
      mo?.disconnect();
      clearTimeout(moTimer);
    };
  }, []);

  // Keep the cat inside the window after a resize.
  useEffect(() => {
    const b = boundsFor(env.width, size);
    const clamped = clampX(xRef.current, b);
    if (clamped !== xRef.current && !drag.current) moveTo(clamped);
    const maxBottom = Math.max(0, env.height - size - EDGE_GAP);
    setBottom(Math.min(prefsRef.current.bottom, maxBottom));
  }, [env.width, env.height, size, moveTo]);

  const working = isWorking(running);
  const roaming = prefs.mode === 'roam' && roamAllowed(env) && !roamPaused(working) && !dragging && !bubble && !menuOpen && !panelOpen;

  // Roaming: sit a while, walk a short way, repeat. Stops where it is when roaming is no longer allowed.
  useEffect(() => {
    if (!roaming) return undefined;
    brainRef.current = initialBrain(xRef.current, Date.now());
    let timer = null;
    const step = () => {
      const now = Date.now();
      const next = nextBrainStep(brainRef.current, now, Math.random, boundsFor(window.innerWidth, size));
      brainRef.current = next;
      if (next.phase === 'walk') {
        setDir(next.dir);
        setWalking(true);
        moveTo(next.targetX, Math.max(0, next.until - now));
      } else {
        setWalking(false);
      }
      timer = setTimeout(step, Math.max(0, next.until - now));
    };
    timer = setTimeout(step, Math.max(0, brainRef.current.until - Date.now()));
    return () => {
      clearTimeout(timer);
      if (brainRef.current?.phase === 'walk' && bodyRef.current) {
        moveTo(Math.round(bodyRef.current.getBoundingClientRect().left));
      }
      brainRef.current = null;
      setWalking(false);
    };
  }, [roaming, size, moveTo]);

  const closeBubble = useCallback(() => {
    clearTimeout(bubbleTimer.current);
    clearTimeout(tipTimer.current);
    setBubble(null);
  }, []);

  const showReaction = useCallback((r) => {
    const id = ++seq.current;
    clearTimeout(tipTimer.current);
    clearTimeout(animTimer.current);
    clearTimeout(bubbleTimer.current);
    setMenuOpen(false);
    if (panelOpenRef.current) setNotice({ text: r.text, href: r.href, id }); // the open panel says it instead of a bubble
    else setBubble({ kind: 'reaction', text: r.text, href: r.href, id });
    setAnim({ name: r.animation, id });
    animTimer.current = setTimeout(() => setAnim((a) => (a && a.id === id ? null : a)), ANIM_SHOW_MS);
    bubbleTimer.current = setTimeout(() => setBubble((b) => (b && b.id === id ? null : b)), REACTION_SHOW_MS);
  }, []);

  const react = useCallback((r) => {
    if (prefsRef.current.mode === 'hidden') return;
    if (!gateRef.current(Date.now(), typeof document !== 'undefined' && document.hidden)) return;
    showReaction(r);
  }, [showReaction]);

  // The open project's live events. Closed when the project changes or the cat unmounts (also on sign-out).
  useEffect(() => {
    setRunning((prev) => (prev.size ? new Set() : prev));
    if (!projectId) return undefined;
    let live = true;
    const unsubscribe = subscribeProject(projectId, (ev) => {
      if (!live) return;
      setRunning((prev) => trackRunning(prev, ev));
      const r = moodForEvent(ev, { projectId });
      if (r) react(r);
    });
    return () => { live = false; unsubscribe(); };
  }, [projectId, react]);

  // A rising inbox count (not the first load: the count starts at 0 and is filled in by the first request).
  useEffect(() => {
    const prev = prevInbox.current;
    prevInbox.current = inboxCount;
    if (Date.now() - mountedAt.current < 5000) return;
    if (inboxCount > prev) react({ animation: 'alert', text: 'Something needs you in the Inbox.', href: '#/inbox' });
  }, [inboxCount, react]);

  // The tip bubble opens by itself a moment after load, on wider screens only.
  useEffect(() => {
    if (!matches('(min-width: 601px)')) return undefined;
    tipTimer.current = setTimeout(() => {
      if (prefsRef.current.mode === 'hidden' || panelOpenRef.current) return;
      // Opened by itself, it also leaves by itself (a bubble that stays open keeps the cat from roaming).
      const id = ++seq.current;
      setBubble((b) => b ?? { kind: 'tip', id });
      bubbleTimer.current = setTimeout(() => setBubble((b) => (b && b.id === id ? null : b)), AUTO_TIP_MS);
    }, SHOW_AFTER_MS);
    return () => clearTimeout(tipTimer.current);
  }, []);

  // Escape closes the menu and any bubble; a press outside the menu closes it.
  useEffect(() => {
    if (!bubble && !menuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { setMenuOpen(false); closeBubble(); } };
    const onDown = (e) => {
      if (menuOpen && !e.target.closest?.('.cat-menu, .cat-menu-toggle, .cat-button')) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [bubble, menuOpen, closeBubble]);

  useEffect(() => () => {
    clearTimeout(animTimer.current); clearTimeout(bubbleTimer.current); clearTimeout(tipTimer.current); clearTimeout(pressTimer.current);
  }, []);

  const nextTip = () => {
    setPanelOpen(false);
    clearTimeout(tipTimer.current);
    clearTimeout(bubbleTimer.current);
    setMenuOpen(false);
    if (bubble?.kind === 'tip') setTip((t) => (t + 1) % CAT_TIPS.length);
    setBubble({ kind: 'tip', id: ++seq.current });
  };

  const openPanel = () => {
    clearTimeout(tipTimer.current);
    clearTimeout(bubbleTimer.current);
    setBubble(null);
    setMenuOpen(false);
    setNotice(null);
    setPanelOpen(true);
  };
  // Closing gives focus back to the cat, except when the panel closes to navigate (the page then moves focus to its own content).
  const closePanel = useCallback((opts) => {
    setPanelOpen(false);
    if (opts?.restoreFocus !== false) buttonRef.current?.focus();
  }, []);

  const openMenu = () => {
    setPanelOpen(false);
    clearTimeout(pressTimer.current);
    clearTimeout(tipTimer.current);
    clearTimeout(bubbleTimer.current);
    setBubble(null);
    setMenuOpen(true);
  };

  const chooseMode = (mode) => {
    if (mode !== 'hidden') lastVisibleMode.current = mode;
    updatePrefs({ mode });
    setMenuOpen(false);
    if (mode === 'hidden') { closeBubble(); setPanelOpen(false); }
  };

  // Pointer: a movement under the threshold is a click, anything more is a drag; holding still for half a second opens the menu.
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    suppressClick.current = false;
    drag.current = { sx: e.clientX, sy: e.clientY, x0: xRef.current, b0: bottom, moved: false, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable: the drag still works while the pointer stays over the cat */ }
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      if (drag.current && !drag.current.moved) { suppressClick.current = true; openMenu(); }
    }, LONG_PRESS_MS);
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      d.moved = true;
      clearTimeout(pressTimer.current);
      setDragging(true);
      setHovered(false);
    }
    const w = window.innerWidth;
    const h = window.innerHeight;
    moveTo(clampX(d.x0 + dx, boundsFor(w, size)));
    setBottom(Math.min(Math.max(0, d.b0 - dy), Math.max(0, h - size - EDGE_GAP)));
  };
  const endPointer = (e) => {
    clearTimeout(pressTimer.current);
    const d = drag.current;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
    if (!d || !d.moved) return;
    suppressClick.current = true;
    setDragging(false);
    const w = window.innerWidth;
    const span = Math.max(1, w - size);
    const nx = clampX(xRef.current, boundsFor(w, size));
    moveTo(nx);
    updatePrefs({ x: Math.min(1, Math.max(0, nx / span)), bottom: Math.round(bottomRef.current) });
  };

  const onClick = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (panelOpen) closePanel(); else openPanel();
  };

  if (prefs.mode === 'hidden') {
    return (
      <div className="cat-mascot cat-mascot-hidden" data-testid="cat-mascot" data-mode="hidden">
        <button type="button" className="cat-paw" aria-label="Show the cat" title="Show the cat" onClick={() => chooseMode(lastVisibleMode.current)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
            <ellipse cx="8" cy="11" rx="3.6" ry="3" />
            <ellipse cx="3.2" cy="7" rx="1.5" ry="2" />
            <ellipse cx="6.4" cy="4" rx="1.5" ry="2" />
            <ellipse cx="9.6" cy="4" rx="1.5" ry="2" />
            <ellipse cx="12.8" cy="7" rx="1.5" ry="2" />
          </svg>
        </button>
      </div>
    );
  }

  const motionName = pickMotion({ reaction: anim ? anim.name : null, walking, hovered: hovered && !dragging, working });
  const hoverCapable = matches('(hover: hover)');
  const showLabel = hovered && hoverCapable && !bubble && !menuOpen && !panelOpen && !dragging && !walking;
  const style = { bottom, '--cat-x': `${x}px`, '--cat-size': `${size}px` };

  return (
    <div className={`cat-mascot${panelOpen ? ' has-panel' : ''}`} data-testid="cat-mascot" data-mode={prefs.mode} data-walking={walking ? 'true' : 'false'} data-working={working ? 'true' : 'false'} style={style}>
      {bubble && (
        <div className="cat-bubble" role="status" aria-live="polite" data-testid="cat-bubble" data-kind={bubble.kind}>
          <p className="cat-bubble-text">
            {bubble.kind === 'tip'
              ? <><strong>Tip: </strong>{CAT_TIPS[tip]}</>
              : <>{bubble.text}{bubble.href && <> <a className="cat-bubble-link" href={bubble.href} onClick={closeBubble}>Open</a></>}</>}
          </p>
          <button type="button" className="cat-menu-toggle" aria-label="Cat settings" aria-haspopup="menu" onClick={openMenu}>⋯</button>
          <button type="button" className="cat-bubble-close" aria-label={bubble.kind === 'tip' ? 'Close tip' : 'Close'} onClick={closeBubble}>×</button>
        </div>
      )}
      {menuOpen && (
        <div className="cat-menu" role="menu" aria-label="Cat settings" data-testid="cat-menu">
          <button type="button" role="menuitem" className="cat-menu-item" onClick={nextTip}>
            <span className="cat-menu-dot cat-menu-dot-tip" aria-hidden="true" />Show a tip
          </button>
          {MODES.map((m) => (
            <button key={m.id} type="button" role="menuitemradio" aria-checked={prefs.mode === m.id} className="cat-menu-item" onClick={() => chooseMode(m.id)}>
              <span className="cat-menu-dot" aria-hidden="true" />{m.label}
            </button>
          ))}
        </div>
      )}
      {panelOpen && (
        <CatChatPanel
          route={route ?? { projectId, tab: '', rest: [] }}
          user={user}
          roam={prefs.mode === 'roam'}
          onRoamChange={(on) => { if (on) lastVisibleMode.current = 'roam'; updatePrefs({ mode: on ? 'roam' : 'sit' }); }}
          onClose={closePanel}
          notice={notice}
        />
      )}
      {showLabel && <div className="cat-label" aria-hidden="true">Chat with {CAT_NAME} ✨</div>}
      <div
        ref={bodyRef}
        className="cat-body"
        style={{ transform: `translate3d(${x}px, 0, 0)`, transition: ms > 0 ? `transform ${ms}ms linear` : 'none' }}
      >
        <button
          type="button"
          className={`cat-button${dragging ? ' is-dragging' : ''}`}
          ref={buttonRef}
          aria-label={`Chat with ${CAT_NAME}`}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHovered(true); }}
          onPointerLeave={() => setHovered(false)}
          onContextMenu={(e) => { e.preventDefault(); openMenu(); }}
        >
          <CatSprite key={anim ? `${anim.name}-${anim.id}` : motionName} name={motionName} flip={dir === -1} size={size} />
        </button>
        {anim && anim.name === 'celebrate' && (
          <span className="cat-sparkles" aria-hidden="true" key={`sp-${anim.id}`}>
            {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} style={{ '--a': `${i * 60}deg` }} />)}
          </span>
        )}
      </div>
    </div>
  );
}
