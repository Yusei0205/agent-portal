import { api } from '../lib/api.js';
import { useApp } from '../lib/context.js';
import { useLoad } from '../lib/useAsync.js';
import { ErrorNote, PageHeader, Spinner } from '../components/ui.jsx';
import { AwsSection, ProviderSection } from './settings/Providers.jsx';
import { AdvancedSection, AgentsSection, BudgetSection, DelegationSection, ExtraModelsSection, ModelsSection } from './settings/Limits.jsx';
import { SecretRow, SecretsSection, ToolsSection } from './settings/Secrets.jsx';
import { Users } from './settings/Users.jsx';

export { AWS_REGIONS, RegionSelect } from './settings/regions.jsx';

export function Settings() {
  const { user, reloadMeta } = useApp();
  const s = useLoad(() => api.get('/api/settings'), []);
  const usage = useLoad(() => api.get('/api/usage'), []);
  if (!user.is_admin) return <div className="page"><p>Only admins can change settings.</p></div>;
  if (s.error) return <div className="page"><ErrorNote error={s.error} /></div>;
  if (!s.data) return <div className="page"><Spinner /></div>;
  const reload = async () => {
    await s.reload(true);
    reloadMeta();
  };
  return (
    <div className="page">
      <PageHeader title="Settings" sub="How agents reach Claude, what they may spend, and who can sign in." />
      <div className="settings">
        <ProviderSection s={s.data} reload={reload} />
        <AwsSection s={s.data} reload={reload} />
        <ModelsSection s={s.data} reload={reload} />
        <SecretRow
          title="GitHub token"
          desc="Default token for GitHub repositories that have no token of their own. Fine-grained, with Contents and Pull requests read and write."
          name="github.token"
          info={s.data.secretsInfo['github.token']}
          reload={reload}
        />
        <BudgetSection s={s.data} usage={usage.data} reload={reload} />
        <AgentsSection s={s.data} reload={reload} />
        <DelegationSection s={s.data} reload={reload} />
        <ExtraModelsSection s={s.data} reload={reload} />
        <SecretsSection s={s.data} reload={reload} />
        <ToolsSection />
        <Users />
        <AdvancedSection s={s.data} reload={reload} />
      </div>
    </div>
  );
}
