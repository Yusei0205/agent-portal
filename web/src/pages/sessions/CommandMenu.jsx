import { useEffect, useRef } from 'react';
import { cx } from '../../lib/util.js';

/** All slash-commands with their usage and description (kept in sync with the server). */
export const SLASH_COMMANDS = [
  { name: '/help',    usage: '/help',                   description: 'List all available commands.' },
  { name: '/model',   usage: '/model [id]',             description: 'Show models, or set the model for the next iteration.' },
  { name: '/agent',   usage: '/agent [name]',           description: 'Show lead agents, or set the lead agent.' },
  { name: '/engine',  usage: '/engine [claude|kiro]',   description: 'Show engine choices, or switch the session engine.' },
  { name: '/context', usage: '/context',                description: 'Show context items attached to this session.' },
  { name: '/usage',   usage: '/usage',                  description: 'Show iterations and spend vs budget.' },
  { name: '/status',  usage: '/status',                 description: 'Show session status, engine, model, lead agent and branch.' },
  { name: '/stop',    usage: '/stop',                   description: 'Stop the session (including the run in progress).' },
  { name: '/resume',  usage: '/resume',                 description: 'Resume a stopped or paused session.' },
  { name: '/tools',   usage: '/tools [install]',        description: 'Show optional tool pack status; /tools install uv|kiro to install.' },
  { name: '/browser', usage: '/browser on|off',         description: 'Attach or remove the built-in Web browser integration.' },
  { name: '/aws',     usage: '/aws on|off',             description: 'Attach or remove the AWS read-only integration for this session.' },
];

/**
 * Inline autocomplete dropdown shown when the textarea contains a slash-command prefix.
 *
 * Props:
 *   items        – filtered CommandOption-like list [{ name, usage, description }]
 *   activeIndex  – currently keyboard-highlighted index
 *   onSelect(item) – called when the user clicks or presses Enter on an item
 *   anchorRef    – ref to the textarea; used to position the menu
 */
export function CommandMenu({ items, activeIndex, onSelect, anchorRef }) {
  const listRef = useRef(null);

  // Scroll the active item into view when keyboard navigation moves through the list.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelectorAll('[role="option"]')[activeIndex];
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!items.length) return null;

  return (
    <ul
      ref={listRef}
      className="cmd-menu"
      role="listbox"
      aria-label="Slash commands"
      id="cmd-menu-list"
    >
      {items.map((item, i) => (
        <li
          key={item.name}
          role="option"
          aria-selected={i === activeIndex}
          className={cx('cmd-menu-item', i === activeIndex && 'is-active')}
          onMouseDown={(e) => {
            // mousedown fires before the textarea's blur; prevent blur so focus stays.
            e.preventDefault();
            onSelect(item);
          }}
        >
          <span className="cmd-menu-name mono">{item.name}</span>
          <span className="cmd-menu-desc muted small">{item.description}</span>
        </li>
      ))}
    </ul>
  );
}
