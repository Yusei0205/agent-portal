import { useEffect, useRef, useState } from 'react';

/**
 * The portal's cat mascot: a small cat in the bottom-right corner that pops up a bubble with a tip. Decorative only: the tips are static
 * text, nothing is loaded or changed. The bubble appears a moment after the page loads; × closes it until the next load, and clicking the
 * cat shows the next tip. Colours come from the theme tokens, and the idle animation stops for people who ask for reduced motion.
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

export function CatMascot() {
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(() => Math.floor(Math.random() * CAT_TIPS.length));
  const timer = useRef(null);

  useEffect(() => {
    timer.current = setTimeout(() => setOpen(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer.current);
  }, []);

  const nextTip = () => {
    clearTimeout(timer.current);
    if (open) setTip((t) => (t + 1) % CAT_TIPS.length);
    setOpen(true);
  };

  return (
    <div className="cat-mascot" data-testid="cat-mascot">
      {open && (
        <div className="cat-bubble" role="status" aria-live="polite" data-testid="cat-bubble">
          <p className="cat-bubble-text"><strong>Tip: </strong>{CAT_TIPS[tip]}</p>
          <button type="button" className="cat-bubble-close" aria-label="Close tip" onClick={() => setOpen(false)}>×</button>
        </div>
      )}
      <button type="button" className="cat-button" aria-label="Show a tip" title="Show a tip" onClick={nextTip}>
        <svg className="cat-svg" viewBox="0 0 64 64" width="56" height="56" aria-hidden="true" focusable="false">
          <path className="cat-tail" d="M44 52c8 0 12-6 10-12" />
          <ellipse className="cat-body" cx="32" cy="48" rx="15" ry="12" />
          <path className="cat-ear" d="M17 22 L19 8 L28 17 Z" />
          <path className="cat-ear" d="M47 22 L45 8 L36 17 Z" />
          <path className="cat-ear-inner" d="M20 19 L21 12 L25 16 Z" />
          <path className="cat-ear-inner" d="M44 19 L43 12 L39 16 Z" />
          <circle className="cat-head" cx="32" cy="27" r="15" />
          <g className="cat-eyes">
            <ellipse className="cat-eye" cx="26" cy="26" rx="2" ry="2.6" />
            <ellipse className="cat-eye" cx="38" cy="26" rx="2" ry="2.6" />
          </g>
          <path className="cat-nose" d="M30.5 31 h3 l-1.5 1.8 Z" />
          <path className="cat-mouth" d="M32 32.8 q-2 2.4 -4 0.8 M32 32.8 q2 2.4 4 0.8" />
          <path className="cat-whisker" d="M22 31 h-8 M22 33.5 l-7 2 M42 31 h8 M42 33.5 l7 2" />
        </svg>
      </button>
    </div>
  );
}
