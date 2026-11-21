import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PROVIDERS = ['aws', 'azure', 'gcp', 'custom'] as const;
export type Provider = typeof PROVIDERS[number];
export interface ChecklistTarget { id: string; provider: Provider; name: string }
export interface ChecklistItem {
  id: string; kind: 'deployment' | 'security'; targetId: string;
  category: string; resource: string; requirement: string;
  evidence: string[]; status: 'pending' | 'in_progress' | 'approved' | 'blocked' | 'not_applicable';
  notes: string; reviewedBy: string | null; reviewedAt: string | null;
}
export interface RepoAnalysis {
  repoId: string; name: string; status: string; files: number; languages: string[];
  evidence: string[]; providers: Provider[]; resources: { provider: Provider; name: string; evidence: string }[];
  configurationKeys: { name: string; evidence: string }[];
  warnings: string[];
}
export interface Checklist {
  version: 1; revision: number; generatedAt: string | null; updatedAt: string;
  targets: ChecklistTarget[]; items: ChecklistItem[]; suppressed: string[]; analysis: RepoAnalysis[];
}
const ignored = new Set(['.git', '.claude', '.codex', 'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build', 'target', 'bin', 'obj', '.terraform']);
const languages: Record<string, string> = { '.js': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.fs': 'F#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.c': 'C', '.cpp': 'C++', '.scala': 'Scala', '.ex': 'Elixir', '.dart': 'Dart', '.sh': 'Shell', '.r': 'R', '.lua': 'Lua' };
const stableId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/** Bounded static analysis: never executes repository code or returns file contents.
 * All file types contribute to inventory; unknown languages still get full reviews. */
export async function analyzeRepository(root: string, repo: { id: string; name: string; status: string }): Promise<RepoAnalysis> {
  const result: RepoAnalysis = { repoId: repo.id, name: repo.name, status: repo.status, files: 0, languages: [], evidence: [], providers: [], resources: [], configurationKeys: [], warnings: [] };
  if (repo.status !== 'ready') { result.warnings.push(`Repository is ${repo.status}; sync it and regenerate to analyze source.`); return result; }
  const foundLanguages = new Set<string>();
  const providers = new Set<Provider>();
  let bytes = 0, entries = 0, truncated = false;
  const rootPath = path.resolve(root);
  const identify = (provider: Provider, reference: string) => {
    providers.add(provider);
    if (!result.evidence.includes(reference) && result.evidence.length < 80) result.evidence.push(reference);
  };
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 24) { truncated = true; return; }
    const dirEntries = await fs.readdir(dir, { withFileTypes: true });
    dirEntries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of dirEntries) {
      if (++entries > 12000) { truncated = true; return; }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!ignored.has(entry.name)) await walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      result.files++;
      const ext = path.extname(entry.name).toLowerCase();
      if (languages[ext]) foundLanguages.add(languages[ext]);
      const relative = path.relative(rootPath, full).split(path.sep).join('/');
      // Do not read secrets, private keys, lockfiles, or binary files.
      if (/^\.env($|\.(?!example$|sample$))|credentials|secrets?\.|\.pem$|\.key$|lock$|lock\.json$/i.test(entry.name)) continue;
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink() || stat.size > 128000 || bytes + stat.size > 4_000_000) { truncated = true; continue; }
      const content = await fs.readFile(full);
      bytes += content.length;
      if (content.includes(0)) continue;
      const source = content.toString('utf8');
      const ref = `${repo.name}/${relative}`;
      for (const match of source.matchAll(/(?:process\.env\.|\b(?:getenv|env|var|GetEnvironmentVariable)\s*\(\s*["']|\b(?:environ|ENV|env)\s*\[\s*["'])([A-Z][A-Z0-9_]{1,100})/g)) {
        if (result.configurationKeys.length < 30 && !result.configurationKeys.some((key) => key.name === match[1])) {
          result.configurationKeys.push({ name: match[1], evidence: `${ref}:${source.slice(0, match.index).split('\n').length}` });
        }
      }
      if (/dockerfile|compose|\.tf$|\.bicep$|\.ya?ml$|\.json$|\.toml$|\.csproj$|\.xml$|readme|requirements|gemfile|procfile|makefile/i.test(entry.name) && result.evidence.length < 80) result.evidence.push(ref);
      if (result.evidence.length < 6 && !result.evidence.includes(ref)) result.evidence.push(ref);
      if (/\baws[_-]|amazonaws\.com|@aws-sdk|\bAWS::/.test(source)) identify('aws', ref);
      if (/\bazurerm_|Microsoft\.[A-Za-z]+\/|@azure\/|azure\.com/.test(source)) identify('azure', ref);
      if (/\bgoogle_|@google-cloud|googleapis\.com|\bgcloud\b/.test(source)) identify('gcp', ref);
      // Terraform resource labels are configuration identifiers, never secret values.
      for (const match of source.matchAll(/resource\s+"((aws|azurerm|google)_[\w]{1,100})"\s+"([\w-]{1,100})"/g)) {
        const provider: Provider = match[2] === 'aws' ? 'aws' : match[2] === 'azurerm' ? 'azure' : 'gcp';
        if (result.resources.length < 80) result.resources.push({ provider, name: `${match[1]}.${match[3]}`, evidence: `${ref}:${source.slice(0, match.index).split('\n').length}` });
      }
    }
  }
  try {
    // A clone root may itself be a symlink; do not follow it.
    const stat = await fs.lstat(rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe clone root');
    await walk(rootPath, 0);
  } catch { result.warnings.push('Source could not be fully read on this server. Sync the repository here and regenerate.'); }
  if (truncated) result.warnings.push('Analysis limits reached (12,000 entries, 24 levels, 128 KB per file, 4 MB total). Review unscanned files manually.');
  result.languages = [...foundLanguages].sort();
  result.providers = [...providers].sort();
  return result;
}

const templates: [ChecklistItem['kind'], string, string][] = [
  ['deployment', 'Build & runtime', 'Document build, test and start commands, runtime versions, dependencies and release artifact for this repository.'],
  ['deployment', 'Configuration', 'List required environment variables and configuration keys, defaults, secret references and environment-specific values.'],
  ['deployment', 'Networking', 'Confirm region/location, endpoints, DNS, TLS, ingress/egress rules and service connectivity.'],
  ['deployment', 'Operations', 'Verify health checks, logs, metrics, alerts, backups, rollback and recovery procedures.'],
  ['security', 'Identity & access', 'Review authentication, authorization, least-privilege service identities and administrative access.'],
  ['security', 'Secrets & data', 'Verify secret storage and rotation, encryption in transit/at rest, data retention and sensitive log redaction.'],
  ['security', 'Supply chain', 'Review dependencies, vulnerability scanning, pinned artifacts and CI/CD permissions before release.'],
  ['security', 'Application security', 'Review input validation, injection risks, session handling and public endpoints for this repository.'],
];
const providerRequirements: Record<Provider, string> = {
  aws: 'Confirm account, region, IAM role/policy, VPC/security groups, encryption and CloudWatch monitoring for this resource.',
  azure: 'Confirm subscription, tenant, resource group, location, managed identity/RBAC, network rules, Key Vault and Azure Monitor for this resource.',
  gcp: 'Confirm project, region/zone, enabled APIs, service account/IAM, VPC/firewall, Secret Manager and Cloud Monitoring for this resource.',
  custom: 'Document service owner, endpoint, credentials reference, network access, configuration, deployment procedure and monitoring for this resource.',
};

export function generateChecklist(previous: Checklist | null, analysis: RepoAnalysis[]): Checklist {
  const timestamp = new Date().toISOString();
  const detected = [...new Set(analysis.flatMap((r) => r.providers))];
  const targets = previous ? previous.targets : (detected.length ? detected : ['custom'] as Provider[]).map((provider) => ({ id: `detected-${provider}`, provider, name: provider === 'custom' ? 'Custom services' : provider.toUpperCase() }));
  const generated: ChecklistItem[] = [];
  const add = (key: string, targetId: string, kind: ChecklistItem['kind'], category: string, resource: string, requirement: string, evidence: string[]) => {
    generated.push({ id: stableId(key), targetId, kind, category, resource, requirement, evidence: [...new Set(evidence)].slice(0, 80), status: 'pending', notes: '', reviewedBy: null, reviewedAt: null });
  };
  for (const repo of analysis) {
    for (const [kind, category, requirement] of templates) add(`${repo.repoId}:${kind}:${category}`, '', kind, category, repo.name, requirement, repo.evidence.slice(0, 12));
    if (repo.configurationKeys.length) add(`${repo.repoId}:configuration-keys`, '', 'deployment', 'Required configuration', repo.name,
      `Verify the required values, defaults and secret references for configuration keys detected in source: ${repo.configurationKeys.map((key) => key.name).join(', ')}. Confirm which keys are mandatory in each environment.`, repo.configurationKeys.map((key) => key.evidence));
    for (const target of targets) {
      const resources = repo.resources.filter((r) => r.provider === target.provider);
      for (const resource of resources.length ? resources : [{ name: `${repo.name} service`, evidence: '' }]) {
        add(`${repo.repoId}:${target.id}:${resource.name}:deploy`, target.id, 'deployment', 'Provider configuration', resource.name, providerRequirements[target.provider], resource.evidence ? [resource.evidence] : repo.evidence.slice(0, 12));
        add(`${repo.repoId}:${target.id}:${resource.name}:security`, target.id, 'security', 'Provider security', resource.name, `Review least privilege, public exposure, encryption, audit logging and recovery for ${target.name}: ${resource.name}.`, resource.evidence ? [resource.evidence] : repo.evidence.slice(0, 12));
      }
    }
  }
  const suppressed = previous?.suppressed ?? [];
  const existing = new Map(previous?.items.map((item) => [item.id, item]) ?? []);
  // Existing documents win in their entirety, including manual rows and evidence edits.
  for (const item of generated) {
    if (existing.has(item.id) || suppressed.includes(item.id)) continue;
    if (existing.size >= 600) {
      if (analysis[0]) analysis[0].warnings.push('Checklist limit of 600 items reached. Split large deployments into separate projects or review additional resources manually.');
      break;
    }
    existing.set(item.id, item);
  }
  return { version: 1, revision: (previous?.revision ?? 0) + 1, generatedAt: timestamp, updatedAt: timestamp, targets, items: [...existing.values()], suppressed, analysis };
}

export function checklistMarkdown(doc: Checklist): string {
  const clean = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
  const lines = ['# Deployment and security checklist', '', `Generated: ${doc.generatedAt ?? 'Not generated'} · Revision: ${doc.revision}`, '', 'Static repository analysis provides review prompts, not a security certification.', ''];
  for (const repo of doc.analysis) lines.push(`## Repository: ${clean(repo.name)}`, '', `Languages: ${repo.languages.join(', ') || 'Unclassified'}; files: ${repo.files}`, ...repo.warnings.map((w) => `- ${clean(w)}`), '');
  for (const kind of ['deployment', 'security']) {
    lines.push(`## ${kind === 'deployment' ? 'Deployment' : 'Security'}`, '');
    for (const item of doc.items.filter((i) => i.kind === kind)) {
      const target = doc.targets.find((t) => t.id === item.targetId);
      lines.push(`- [${item.status === 'approved' ? 'x' : ' '}] ${clean(item.category)} / ${clean(item.resource)}${target ? ` (${clean(target.name)} / ${target.provider})` : ''}: ${clean(item.requirement)}`, `  - Status: ${item.status}`, `  - Notes: ${clean(item.notes)}`, `  - Evidence: ${item.evidence.map(clean).join(', ') || 'None'}`, `  - Reviewed: ${clean(item.reviewedBy ?? 'Not reviewed')} ${item.reviewedAt ?? ''}`, '');
    }
  }
  return lines.join('\n');
}
