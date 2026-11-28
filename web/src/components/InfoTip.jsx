import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';

/**
 * A small (i) button that explains something in a popover.
 *
 * Opens on click or keyboard (Enter/Space), and on hover for a mouse; closes with Escape, a click elsewhere, or
 * moving focus away. The text is linked to the button with aria-describedby so screen readers read it too.
 *
 *   <InfoTip title="Groups">A group is a folder of scripts…</InfoTip>
 *
 * @param {{ title?: string, label?: string, children: import('react').ReactNode, align?: 'start' | 'end' }} props
 */
export function InfoTip({ title, label = 'More information', children, align = 'start' }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const root = useRef(null);
  const id = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setPinned(false); } };
    const onDown = (e) => { if (root.current && !root.current.contains(e.target)) { setOpen(false); setPinned(false); } };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [open]);

  return (
    <span
      className="info-tip"
      ref={root}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (!pinned) setOpen(false); }}
    >
      <button
        type="button"
        className="info-tip-btn"
        aria-label={title ? `${label}: ${title}` : label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => { if (open && pinned) { setOpen(false); setPinned(false); } else { setOpen(true); setPinned(true); } }}
        onBlur={(e) => { if (!root.current?.contains(e.relatedTarget)) { setOpen(false); setPinned(false); } }}
      >
        <Icon name="info" size={14} aria-hidden="true" />
      </button>
      {open && (
        <span id={id} role="tooltip" className={`info-tip-pop info-tip-pop--${align}`}>
          {title && <strong className="info-tip-title">{title}</strong>}
          {children}
        </span>
      )}
    </span>
  );
}

export default InfoTip;
