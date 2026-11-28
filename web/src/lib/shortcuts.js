/**
 * Global shortcut registry — single source of truth for key bindings.
 *
 * The command palette, shortcuts sheet, and key handler all read from
 * this registry. Other features can register additional shortcuts at
 * any time (e.g. on component mount).
 *
 * ── How to register shortcuts from another feature ──────────────────
 *
 *   import { registerShortcuts } from '../../lib/shortcuts.js';
 *
 *   // Idempotent — safe to call multiple times / on every render
 *   registerShortcuts([
 *     { id: 'ws_save',    keys: 'Ctrl S',       label: 'Save file',          group: 'Workspace' },
 *     { id: 'ws_term',    keys: 'Ctrl `',        label: 'Toggle terminal',    group: 'Workspace' },
 *     { id: 'ws_explore', keys: 'Ctrl Shift E', label: 'Toggle explorer',    group: 'Workspace' },
 *     { id: 'ws_source',  keys: 'Ctrl Shift G', label: 'Source control',     group: 'Workspace' },
 *     { id: 'new_session', keys: 'Alt N',        label: 'New session',        group: 'Sessions'  },
 *   ]);
 *
 * ── How to wire a runtime handler ───────────────────────────────────
 *
 *   import { registerHandler } from '../../lib/shortcuts.js';
 *
 *   useEffect(() => {
 *     const unregister = registerHandler('ws_save', () => saveCurrentFile());
 *     return unregister; // cleanup on unmount
 *   }, [saveCurrentFile]);
 *
 * ── Key format (display strings) ────────────────────────────────────
 *
 *   'Ctrl K'        — Ctrl+K (or Cmd+K on Mac)
 *   'Ctrl Shift E'  — chord with Shift
 *   'g s'           — two-key sequence (g, then s within 1.5 s)
 *   '?'             — single key
 *   'Alt N'         — Alt+N
 *   'Ctrl `'        — Ctrl+backtick
 */

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {Array<{id:string, keys:string, label:string, description?:string, group:string}>} */
const _defs = [];

/** @type {Map<string, () => void>} */
const _handlers = new Map();

/** @type {Set<() => void>} */
const _changeListeners = new Set();

function _notify() {
  _changeListeners.forEach(fn => fn());
}

// ── Registration API ──────────────────────────────────────────────────────────

/**
 * Register shortcut metadata (for the palette and shortcuts sheet).
 * Idempotent — silently ignores duplicate ids.
 *
 * @param {Array<{id:string, keys:string, label:string, description?:string, group:string}>} defs
 */
export function registerShortcuts(defs) {
  let changed = false;
  for (const def of defs) {
    if (!_defs.find(d => d.id === def.id)) {
      _defs.push(def);
      changed = true;
    }
  }
  if (changed) _notify();
}

/**
 * All registered shortcut definitions (ordered by registration).
 * @returns {Array<{id:string, keys:string, label:string, description?:string, group:string}>}
 */
export function getShortcutDefs() {
  return _defs;
}

/**
 * Register a runtime handler for a shortcut id.
 * Returns an unregister function — call it in a useEffect cleanup.
 *
 * @param {string} id
 * @param {() => void} fn
 * @returns {() => void}
 */
export function registerHandler(id, fn) {
  _handlers.set(id, fn);
  return () => { if (_handlers.get(id) === fn) _handlers.delete(id); };
}

/**
 * Fire the handler registered for id. No-op if none is registered.
 * @param {string} id
 */
export function triggerShortcut(id) {
  _handlers.get(id)?.();
}

/**
 * Subscribe to registry changes (new defs registered).
 * @param {() => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribeShortcuts(fn) {
  _changeListeners.add(fn);
  return () => _changeListeners.delete(fn);
}

// ── Field detection ───────────────────────────────────────────────────────────

/**
 * Returns true if the event target is a text-entry element where
 * single-character and two-key shortcuts should be suppressed.
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isEditingField(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return false;
}

// ── Pre-register workspace shortcuts ─────────────────────────────────────────
// These are registered here so the shortcuts sheet always shows them even
// before the IDE workspace mounts.
registerShortcuts([
  { id: 'ws_save',     keys: 'Ctrl S',       label: 'Save file',              group: 'Workspace' },
  { id: 'ws_term',     keys: 'Ctrl `',        label: 'Toggle terminal',         group: 'Workspace' },
  { id: 'ws_explore',  keys: 'Ctrl Shift E', label: 'Toggle explorer',          group: 'Workspace' },
  { id: 'ws_source',   keys: 'Ctrl Shift G', label: 'Toggle source control',    group: 'Workspace' },
  { id: 'new_session', keys: 'Alt N',         label: 'New session',             group: 'Sessions'  },
]);
