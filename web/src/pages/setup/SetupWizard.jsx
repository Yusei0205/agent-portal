import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { WizardProgress } from '../../components/WizardProgress.jsx';
import { DeployTarget } from './DeployTarget.jsx';
import { AdminAccount } from './AdminAccount.jsx';
import { ModelProvider } from './ModelProvider.jsx';
import { CloudSecurity } from './CloudSecurity.jsx';
import { CloudStorage } from './CloudStorage.jsx';
import { ConfirmStep } from './ConfirmStep.jsx';

const CLOUD_STEPS = ['target', 'account', 'provider', 'security', 'storage', 'confirm'];
const LOCAL_STEPS = ['target', 'account', 'provider', 'confirm'];

const STEP_LABELS = {
  target:   'Deploy',
  account:  'Account',
  provider: 'Provider',
  security: 'Security',
  storage:  'Storage',
  confirm:  'Confirm',
};

/**
 * @param {{ onDone: () => void }} props
 */
export default function SetupWizard({ onDone }) {
  const [step, setStep] = useState('target');
  const [data, setData] = useState({
    target: 'local',
    name: '',
    email: '',
    password: '',
    provider: 'demo',
    apiKey: '',
    region: '',
    authMethod: 'instance',
    secretsArn: '',
    s3Enabled: false,
    s3Bucket: '',
    s3Region: '',
    s3Prefix: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Detect platform on mount
  useEffect(() => {
    api.get('/api/auth/detect-platform')
      .then((r) => {
        if (r.platform === 'cloud') {
          setData((d) => ({ ...d, target: 'cloud' }));
          setStep('target');
        }
      })
      .catch(() => {});
  }, []);

  const steps = data.target === 'cloud' ? CLOUD_STEPS : LOCAL_STEPS;

  const update = (patch) => setData((d) => ({ ...d, ...patch }));

  const next = () => {
    const idx = steps.indexOf(step);
    if (idx < steps.length - 1) setStep(steps[idx + 1]);
  };

  const back = () => {
    const idx = steps.indexOf(step);
    if (idx > 0) setStep(steps[idx - 1]);
  };

  const finish = async (finalData) => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/setup', {
        name: finalData.name,
        email: finalData.email,
        password: finalData.password,
        provider: finalData.provider,
        apiKey: finalData.apiKey || undefined,
        region: finalData.region || undefined,
        authMethod: finalData.authMethod || undefined,
      });
      onDone();
    } catch (err) {
      setError(err.message || 'Setup failed');
      setBusy(false);
    }
  };

  return (
    <div className="wizard-outer">
      <div className="wizard-card">
        <div className="wizard-brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>Agent Portal Setup</span>
        </div>

        <WizardProgress steps={steps} current={step} labels={STEP_LABELS} />

        {error && (
          <div className="error-note" role="alert" style={{ marginBottom: '16px' }}>
            {error}
          </div>
        )}

        {step === 'target' && (
          <DeployTarget
            value={data.target}
            onChange={(target) => {
              update({ target });
              next();
            }}
          />
        )}

        {step === 'account' && (
          <AdminAccount
            data={data}
            onChange={update}
            onNext={next}
            onBack={back}
          />
        )}

        {step === 'provider' && (
          <ModelProvider
            data={data}
            onChange={update}
            onNext={next}
            onBack={back}
          />
        )}

        {step === 'security' && (
          <CloudSecurity
            data={data}
            onChange={update}
            onNext={next}
            onBack={back}
          />
        )}

        {step === 'storage' && (
          <CloudStorage
            data={data}
            onChange={update}
            onNext={next}
            onBack={back}
          />
        )}

        {step === 'confirm' && (
          <ConfirmStep
            data={data}
            onFinish={finish}
            onBack={back}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
}
