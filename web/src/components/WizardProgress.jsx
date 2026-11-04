/**
 * Step indicator for the setup wizard.
 *
 * @param {{
 *   steps: string[],
 *   current: string,
 *   labels?: Record<string, string>,
 * }} props
 */
export function WizardProgress({ steps, current, labels = {} }) {
  const currentIdx = steps.indexOf(current);

  return (
    <nav aria-label="Setup progress" className="wizard-progress">
      {steps.map((step, i) => {
        const isDone = i < currentIdx;
        const isActive = step === current;
        return (
          <div key={step} style={{ display: 'flex', alignItems: 'center', gap: 0, flex: 1 }}>
            <div
              className={`wizard-step${isActive ? ' is-active' : isDone ? ' is-done' : ''}`}
              aria-current={isActive ? 'step' : undefined}
            >
              <span className="wizard-step-dot" />
              <span>{labels[step] || step}</span>
            </div>
            {i < steps.length - 1 && (
              <div className="wizard-step-connector" />
            )}
          </div>
        );
      })}
    </nav>
  );
}
