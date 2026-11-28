import { useState } from 'react';

/**
 * @param {{
 *   data: { name: string, email: string, password: string },
 *   onChange: (patch: object) => void,
 *   onNext: () => void,
 *   onBack: () => void,
 * }} props
 */
export function AdminAccount({ data, onChange, onNext, onBack }) {
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState({});

  const touch = (field) => setTouched((t) => ({ ...t, [field]: true }));

  const errors = {
    name: touched.name && !data.name.trim() ? 'Name is required' : null,
    email: touched.email && !data.email.trim() ? 'Email is required' : null,
    password:
      touched.password && data.password.length < 10
        ? 'Password must be at least 10 characters'
        : null,
    confirm:
      touched.confirm && data.password !== confirm
        ? 'Passwords do not match'
        : null,
  };

  const valid =
    data.name.trim() &&
    data.email.trim() &&
    data.password.length >= 10 &&
    data.password === confirm;

  const submit = (e) => {
    e.preventDefault();
    setTouched({ name: true, email: true, password: true, confirm: true });
    if (valid) onNext();
  };

  return (
    <div>
      <div className="wizard-heading">
        <h1>Create the admin account</h1>
        <p>
          This is the first account. It manages settings, users, and projects.
        </p>
      </div>

      <form onSubmit={submit} className="stack" noValidate>
        <div className="field">
          <label htmlFor="setup-name">Your name</label>
          <input
            id="setup-name"
            type="text"
            value={data.name}
            onChange={(e) => onChange({ name: e.target.value })}
            onBlur={() => touch('name')}
            required
            autoComplete="name"
            autoFocus
            aria-describedby={errors.name ? 'setup-name-error' : undefined}
            aria-invalid={errors.name ? 'true' : undefined}
          />
          {errors.name && (
            <span id="setup-name-error" className="field-error" role="alert">
              {errors.name}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="setup-email">Email</label>
          <input
            id="setup-email"
            type="email"
            value={data.email}
            onChange={(e) => onChange({ email: e.target.value })}
            onBlur={() => touch('email')}
            required
            autoComplete="username"
            aria-describedby={errors.email ? 'setup-email-error' : undefined}
            aria-invalid={errors.email ? 'true' : undefined}
          />
          {errors.email && (
            <span id="setup-email-error" className="field-error" role="alert">
              {errors.email}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="setup-password">Password</label>
          <input
            id="setup-password"
            type="password"
            value={data.password}
            onChange={(e) => onChange({ password: e.target.value })}
            onBlur={() => touch('password')}
            required
            minLength={10}
            autoComplete="new-password"
            aria-describedby="setup-password-hint setup-password-error"
            aria-invalid={errors.password ? 'true' : undefined}
          />
          <span id="setup-password-hint" className="field-hint">
            At least 10 characters.
          </span>
          {errors.password && (
            <span id="setup-password-error" className="field-error" role="alert">
              {errors.password}
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="setup-confirm">Confirm password</label>
          <input
            id="setup-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => touch('confirm')}
            required
            autoComplete="new-password"
            aria-describedby={errors.confirm ? 'setup-confirm-error' : undefined}
            aria-invalid={errors.confirm ? 'true' : undefined}
          />
          {errors.confirm && (
            <span id="setup-confirm-error" className="field-error" role="alert">
              {errors.confirm}
            </span>
          )}
        </div>

        <div className="wizard-actions">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            Back
          </button>
          <button type="submit" className="btn btn-primary" disabled={!valid}>
            Next
          </button>
        </div>
      </form>
    </div>
  );
}
