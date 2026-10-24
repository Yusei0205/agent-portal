import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { cx } from '../../lib/util.js';
import { Button, ErrorNote, Field } from '../../components/ui.jsx';
import { useSave } from './useSave.js';
import { SecretRow } from './Secrets.jsx';
import { RegionSelect } from './regions.jsx';
import { SsoFlow } from './SsoFlow.jsx';

const PROVIDERS = [
  { value: 'demo', title: 'Demo', body: 'Simulated agents. Free, no key needed. Use it to try every feature.' },
  { value: 'anthropic', title: 'Anthropic API', body: 'Pay per token with an API key from the Claude Console.' },
  { value: 'bedrock', title: 'Amazon Bedrock', body: 'Claude through your AWS account, billed by AWS.' },
  { value: 'kiro', title: 'Kiro CLI', body: 'Runs through kiro-cli on this server with its Kiro sign-in. Billed as Kiro credits.' },
];

const AWS_AUTH = [
  { value: 'ambient', label: 'Server’s own AWS identity', hint: 'An EC2 instance role, ECS task role, or environment variables. Recommended on AWS.' },
  { value: 'profile', label: 'Named profile', hint: 'A profile from ~/.aws on the server, including SSO profiles.' },
  { value: 'keys', label: 'Access keys', hint: 'An access key and secret, optionally with a session token. Stored encrypted.' },
  { value: 'bedrock-key', label: 'Bedrock API key', hint: 'A Bedrock-only API key. Not used for CodeCommit.' },
  { value: 'sso', label: 'AWS SSO (IAM Identity Center)', hint: 'Sign in with your browser. Temporary credentials, no ~/.aws profiles needed.' },
];

export function ProviderSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  return (
    <section className="panel">
      <h2>Model provider</h2>
      <div className="provider-pick" role="radiogroup" aria-label="Model provider">
        {PROVIDERS.map((p) => (
          <button
            key={p.value}
            type="button"
            role="radio"
            aria-checked={s.provider.mode === p.value}
            className={cx('provider', s.provider.mode === p.value && 'is-on')}
            onClick={() => s.provider.mode !== p.value && save({ provider: { mode: p.value } }, `Switched to ${p.title}`)}
            disabled={busy}
          >
            <strong>{p.title}</strong>
            <span>{p.body}</span>
          </button>
        ))}
      </div>
      {s.provider.mode === 'anthropic' ? (
        <SecretRow
          inline
          title="Anthropic API key"
          desc="Create one at platform.claude.com under API keys. Stored encrypted; never shown again."
          name="anthropic.api_key"
          info={s.secretsInfo['anthropic.api_key']}
          reload={reload}
        />
      ) : null}
      {s.provider.mode === 'bedrock' ? <p className="muted small">Set the AWS region and sign-in below. Enable the Claude models in the Bedrock console for that region first.</p> : null}
      {s.provider.mode === 'kiro' ? <KiroPanel s={s} reload={reload} /> : null}
      <ErrorNote error={error} />
      <div className="row">
        <Button
          busy={testing}
          onClick={async () => {
            setTesting(true);
            setTest(null);
            try {
              setTest(await api.post('/api/settings/test'));
            } catch (e) {
              setTest({ ok: false, error: e.message });
            } finally {
              setTesting(false);
            }
          }}
        >
          Test connection
        </Button>
        {test ? (
          test.ok ? (
            <span className="ok small">Connected. {s.provider.mode === 'kiro' ? 'Kiro' : 'Claude'} replied in {Math.round(test.ms / 100) / 10}s.</span>
          ) : (
            <span className="danger small">{test.error || `Unexpected reply: ${test.reply}`}</span>
          )
        ) : null}
      </div>
    </section>
  );
}

function KiroPanel({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [command, setCommand] = useState(s.kiro?.command ?? '');
  useEffect(() => setCommand(s.kiro?.command ?? ''), [s.kiro?.command]);
  const dirty = command !== (s.kiro?.command ?? '');
  return (
    <div className="stack">
      <Field label="kiro-cli path" hint="Leave blank to find kiro-cli on the server's PATH.">
        {(id) => (
          <input
            id={id}
            className="input mono input-md"
            value={command}
            onChange={(e) => setCommand(e.target.value.trim())}
            placeholder="kiro-cli (found on PATH)"
            aria-describedby="kiro-path-hint"
          />
        )}
      </Field>
      <SecretRow
        inline
        title="Kiro API key (optional)"
        desc="Only needed on headless servers that have no interactive kiro-cli sign-in. Requires Kiro Pro or above."
        name="kiro.api_key"
        info={s.secretsInfo['kiro.api_key']}
        reload={reload}
      />
      <ErrorNote error={error} />
      <div className="row">
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => save({ kiro: { command, models: s.kiro?.models ?? { sonnet: '', haiku: '', opus: '' } } })}>
          Save Kiro settings
        </Button>
      </div>
      <p className="muted small">
        Portal runs use their own Kiro agent profile — no MCP servers; file writes and shell commands ask for your approval. Each run signs in as the Kiro account the server is running as.
      </p>
    </div>
  );
}

export function AwsSection({ s, reload }) {
  const { busy, error, save } = useSave(reload);
  const [aws, setAws] = useState(s.aws);
  useEffect(() => setAws(s.aws), [s.aws]);
  const dirty = JSON.stringify(aws) !== JSON.stringify(s.aws);
  return (
    <section className="panel">
      <h2>AWS credentials for Bedrock</h2>
      <p className="muted small">Used only for the Amazon Bedrock model. A project can connect to its own AWS account under Project setup › Connection & provider.</p>
      <div className="stack">
        <Field label="Region">{(id) => <RegionSelect id={id} value={aws.region} onChange={(v) => setAws({ ...aws, region: v })} />}</Field>
        <Field label="How the server signs in" hint={AWS_AUTH.find((a) => a.value === aws.auth)?.hint}>
          {(id) => (
            <select id={id} className="input" value={aws.auth} onChange={(e) => setAws({ ...aws, auth: e.target.value })}>
              {AWS_AUTH.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {aws.auth === 'profile' ? (
          <Field label="Profile name">{(id) => <input id={id} className="input input-md" value={aws.profile} onChange={(e) => setAws({ ...aws, profile: e.target.value })} placeholder="dev-sso" />}</Field>
        ) : null}
        <ErrorNote error={error} />
        <div className="row">
          <Button variant="primary" disabled={!dirty} busy={busy} onClick={() => save({ aws })}>
            Save AWS settings
          </Button>
        </div>
        {aws.auth === 'keys' ? (
          <>
            <SecretRow inline title="Access key ID" name="aws.access_key_id" info={s.secretsInfo['aws.access_key_id']} reload={reload} />
            <SecretRow inline title="Secret access key" name="aws.secret_access_key" info={s.secretsInfo['aws.secret_access_key']} reload={reload} />
            <SecretRow inline title="Session token (optional)" desc="Only for temporary credentials. Replace it when it expires." name="aws.session_token" info={s.secretsInfo['aws.session_token']} reload={reload} />
          </>
        ) : null}
        {aws.auth === 'bedrock-key' ? <SecretRow inline title="Bedrock API key" name="aws.bedrock_api_key" info={s.secretsInfo['aws.bedrock_api_key']} reload={reload} /> : null}
        {aws.auth === 'sso' ? <SsoFlow s={s} reload={reload} /> : null}
      </div>
    </section>
  );
}
