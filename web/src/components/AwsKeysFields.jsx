/**
 * The three values of temporary AWS access (from the AWS access portal: pick the account and role, then
 * "Command line or programmatic access"). One box takes everything the portal copied and fills the fields.
 */
import { parseAwsPaste } from '../lib/aws-paste.js';

export function AwsKeysFields({ value, onChange, idPrefix = 'aws' }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-paste`}>Paste what the AWS portal copied (optional)</label>
        <textarea
          id={`${idPrefix}-paste`}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          placeholder={'export AWS_ACCESS_KEY_ID="ASIA…"\nexport AWS_SECRET_ACCESS_KEY="…"\nexport AWS_SESSION_TOKEN="…"'}
          onChange={(e) => set(parseAwsPaste(e.target.value))}
        />
        <span className="field-hint">In the AWS access portal choose your account and role, then <strong>Command line or programmatic access</strong>, and copy the block. The three fields below fill themselves.</span>
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-key-id`}>Access key ID <span aria-hidden="true">*</span></label>
        <input id={`${idPrefix}-key-id`} type="text" autoComplete="off" spellCheck={false} value={value.accessKeyId || ''} onChange={(e) => set({ accessKeyId: e.target.value })} placeholder="ASIA…" aria-required="true" />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-secret`}>Secret access key <span aria-hidden="true">*</span></label>
        <input id={`${idPrefix}-secret`} type="password" autoComplete="off" spellCheck={false} value={value.secretAccessKey || ''} onChange={(e) => set({ secretAccessKey: e.target.value })} aria-required="true" />
      </div>
      <div className="field">
        <label htmlFor={`${idPrefix}-token`}>Session token</label>
        <input id={`${idPrefix}-token`} type="password" autoComplete="off" spellCheck={false} value={value.sessionToken || ''} onChange={(e) => set({ sessionToken: e.target.value })} />
        <span className="field-hint">Needed for temporary keys (those starting with ASIA). They expire after a few hours: paste new ones with Replace keys.</span>
      </div>
    </>
  );
}

export default AwsKeysFields;
