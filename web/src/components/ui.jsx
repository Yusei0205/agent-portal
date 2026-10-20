import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../lib/util.js';
import { Icon } from './Icon.jsx';

export function Button({ variant = 'default', size, icon, busy, children, className, type = 'button', ...rest }) {
  return (
    <button type={type} className={cx('btn', `btn-${variant}`, size && `btn-${size}`, busy && 'is-busy', className)} disabled={busy || rest.disabled} {...rest}>
      {busy ? <Spinner small /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({ icon, label, className, ...rest }) {
  return (
    <button type="button" className={cx('icon-btn', className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={17} />
    </button>
  );
}

export function Spinner({ small }) {
  return <span className={cx('spinner', small && 'spinner-sm')} role="status" aria-label="Loading" />;
}

export function Field({ label, hint, error, children, className, inline }) {
  const id = useId();
  const child = typeof children === 'function' ? children(id) : children;
  return (
    <div className={cx('field', inline && 'field-inline', className)}>
      {label ? (
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      {child}
      {hint ? <p className="field-hint">{hint}</p> : null}
      {error ? <p className="field-error">{error}</p> : null}
    </div>
  );
}

export function ErrorNote({ error, onClose }) {
  if (!error) return null;
  return (
    <div className="note note-danger" role="alert">
      <Icon name="alert" size={16} />
      <span>{error.message || String(error)}</span>
      {onClose ? <IconButton icon="x" label="Dismiss" onClick={onClose} /> : null}
    </div>
  );
}

export function Note({ tone = 'info', icon, children, action }) {
  return (
    <div className={cx('note', `note-${tone}`)}>
      {icon ? <Icon name={icon} size={16} /> : null}
      <div className="note-body">{children}</div>
      {action}
    </div>
  );
}

const STATUS_TONE = {
  completed: 'ok',
  done: 'ok',
  ready: 'ok',
  published: 'ok',
  accepted: 'ok',
  answered: 'ok',
  running: 'accent',
  generating: 'accent',
  cloning: 'accent',
  syncing: 'accent',
  processing: 'accent',
  queued: 'muted',
  waiting: 'warn',
  pending: 'warn',
  draft: 'muted',
  open: 'muted',
  new: 'muted',
  stopped: 'muted',
  dismissed: 'muted',
  cancelled: 'muted',
  failed: 'danger',
  error: 'danger',
  critical: 'danger',
  high: 'danger-soft',
  medium: 'warn',
  low: 'muted',
  info: 'muted',
};

const STATUS_LABEL = {
  completed: 'Completed',
  done: 'Done',
  running: 'Running',
  waiting: 'Needs you',
  queued: 'Queued',
  failed: 'Failed',
  stopped: 'Stopped',
  generating: 'Writing…',
  cloning: 'Cloning…',
  syncing: 'Syncing…',
  processing: 'Converting…',
};

export function Badge({ status, children, tone }) {
  const t = tone || STATUS_TONE[status] || 'muted';
  return <span className={cx('badge', `badge-${t}`)} data-status={status || undefined}>{children ?? STATUS_LABEL[status] ?? (status ? status[0].toUpperCase() + status.slice(1) : '')}</span>;
}

export function Empty({ icon = 'file', title, children, action }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Segmented({ value, onChange, options, label, size }) {
  return (
    <div className={cx('segmented', size && `segmented-${size}`)} role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={cx(value === o.value && 'is-active')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count ? <span className="seg-count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('input, textarea, select, button')?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/* ---- Toasts and confirmation ---- */

const UiContext = createContext(null);

export function UiProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const toast = useCallback((message, tone = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'danger' ? 7000 : 3500);
  }, []);
  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setConfirmState({ ...opts, resolve });
      }),
    [],
  );
  const [typed, setTyped] = useState('');
  const close = (v) => {
    confirmState?.resolve(v);
    setConfirmState(null);
    setTyped('');
  };
  return (
    <UiContext.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.tone}`)}>
            {t.message}
          </div>
        ))}
      </div>
      {confirmState ? (
        <Modal
          title={confirmState.title}
          onClose={() => close(false)}
          footer={
            <>
              <Button onClick={() => close(false)}>Cancel</Button>
              <Button
                variant={confirmState.danger ? 'danger' : 'primary'}
                disabled={confirmState.typeToConfirm && typed !== confirmState.typeToConfirm}
                onClick={() => close(confirmState.typeToConfirm ? typed : true)}
              >
                {confirmState.confirmLabel || 'Confirm'}
              </Button>
            </>
          }
        >
          <p>{confirmState.message}</p>
          {confirmState.typeToConfirm ? (
            <Field label={`Type “${confirmState.typeToConfirm}” to confirm`}>
              {(id) => <input id={id} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} />}
            </Field>
          ) : null}
        </Modal>
      ) : null}
    </UiContext.Provider>
  );
}

export function useUi() {
  return useContext(UiContext);
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <nav className="tabs" aria-label="Sections">
      {tabs.map((t) =>
        t.href ? (
          <a key={t.value} href={t.href} className={cx('tab', value === t.value && 'is-active')} aria-current={value === t.value ? 'page' : undefined}>
            {t.label}
            {t.count ? <span className="tab-count">{t.count}</span> : null}
          </a>
        ) : (
          <button key={t.value} type="button" className={cx('tab', value === t.value && 'is-active')} aria-pressed={value === t.value} onClick={() => onChange?.(t.value)}>
            {t.label}
            {t.count ? <span className="tab-count">{t.count}</span> : null}
          </button>
        ),
      )}
    </nav>
  );
}

export function PageHeader({ title, sub, actions, children }) {
  return (
    <header className="page-head">
      <div className="page-head-main">
        <h1>{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
      {children}
    </header>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <label className={cx('toggle', disabled && 'is-disabled')}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      {label ? <span className="toggle-label">{label}</span> : null}
    </label>
  );
}

export function Progress({ value, label }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="progress-bar" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
