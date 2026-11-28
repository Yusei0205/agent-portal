/**
 * Simple / Advanced UI pieces.
 *
 *   <UiLevelSwitch collapsed />   two-button switch for the rail
 *   <Advanced>…</Advanced>        renders children only in Advanced mode
 *   <AdvancedPageBar tab />       bar shown on an advanced page in Simple mode
 *   useUiLevel()                  hook: current level, re-renders on change
 */
import { useEffect, useState } from 'react';
import {
  getUiLevel, setUiLevel, applyUiLevel, isAdvancedTab, LS_UI_LEVEL, UI_LEVEL_EVENT,
} from '../lib/uiLevel.js';

/** React hook: current level, re-renders on change (also across tabs). */
export function useUiLevel() {
  const [level, setLevel] = useState(getUiLevel);
  useEffect(() => {
    const onChange = () => setLevel(getUiLevel());
    const onStorage = (e) => { if (e.key === LS_UI_LEVEL) { applyUiLevel(); onChange(); } };
    document.addEventListener(UI_LEVEL_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      document.removeEventListener(UI_LEVEL_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return level;
}


export function UiLevelSwitch({ collapsed = false }) {
  const level = useUiLevel();
  const advanced = level === 'advanced';

  if (collapsed) {
    return (
      <button
        type="button"
        className="ui-level-mini"
        onClick={() => setUiLevel(advanced ? 'simple' : 'advanced')}
        aria-label={advanced ? 'Advanced mode on. Switch to Simple' : 'Simple mode on. Switch to Advanced'}
        data-tooltip={advanced ? 'Advanced mode' : 'Simple mode'}
      >
        {advanced ? 'A' : 'S'}
      </button>
    );
  }

  return (
    <div className="ui-level-switch" role="group" aria-label="Interface mode">
      <button
        type="button"
        aria-pressed={!advanced}
        onClick={() => setUiLevel('simple')}
        title="Core features only. Hidden settings keep working with their saved values."
      >
        Simple
      </button>
      <button
        type="button"
        aria-pressed={advanced}
        onClick={() => setUiLevel('advanced')}
        title="Every page and setting."
      >
        Advanced
      </button>
    </div>
  );
}

export function Advanced({ children, fallback = null }) {
  return useUiLevel() === 'advanced' ? children : fallback;
}

export function AdvancedPageBar({ tab }) {
  const level = useUiLevel();
  if (level === 'advanced' || !isAdvancedTab(tab)) return null;
  return (
    <div className="advanced-page-bar" role="status">
      <span>This is an advanced page. It works as usual; it is just hidden from the menu in Simple mode.</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setUiLevel('advanced')}>
        Switch to Advanced
      </button>
    </div>
  );
}
