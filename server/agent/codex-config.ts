import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';

export interface CodexConfigFile { path: string; content: string }
export const CODEX_CONFIG_PATH = /^(AGENTS\.md|config\.toml|agents\/[A-Za-z0-9_-]+\.toml|skills\/[A-Za-z0-9_/-]+\/(SKILL\.md|[A-Za-z0-9_.-]+\.(md|txt|json|ya?ml)))$/;
const MODEL_KEYS = ['model_reasoning_effort', 'model_verbosity', 'personality'];
const ROLE_KEYS = ['name', 'description', 'developer_instructions', 'model', 'model_reasoning_effort'];
export function validateCodexFile(file: CodexConfigFile): void {
  if (!CODEX_CONFIG_PATH.test(file.path) || file.path.includes('..') || Buffer.byteLength(file.content) > 200_000) throw new Error('Unsupported Codex setup file. Use AGENTS.md, config.toml, agents/*.toml, or skill documents.');
  if (!file.path.endsWith('.toml')) return;
  const value = parse(file.content);
  const keys = file.path === 'config.toml' ? [...MODEL_KEYS, 'features'] : ROLE_KEYS;
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Codex setup cannot change authentication, providers, MCP servers, hooks, or sandbox permissions.');
  if (file.path === 'config.toml') {
    for (const key of MODEL_KEYS) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${key} must be a string`);
    if (value.features !== undefined && (!value.features || typeof value.features !== 'object' || Array.isArray(value.features)
      || Object.entries(value.features).some(([k, v]) => k !== 'multi_agent' || typeof v !== 'boolean'))) throw new Error('Only the multi_agent feature can be configured here.');
  } else {
    if (Object.values(value).some(v => typeof v !== 'string')) throw new Error('Codex agent fields must be strings');
    for (const key of ['name', 'description', 'developer_instructions']) if (typeof value[key] !== 'string' || !value[key]) throw new Error(`Codex agent requires ${key}`);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(value.name))) throw new Error('Invalid Codex agent name');
  }
}
export function parseCodexFiles(raw: unknown): CodexConfigFile[] {
  if (!Array.isArray(raw) || raw.length > 300) throw new Error('Invalid Codex setup bundle');
  let bytes = 0; const seen = new Set<string>(), names = new Set<string>();
  return raw.map(file => {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('Invalid Codex setup file');
    const value = { path: file.path, content: file.content }; validateCodexFile(value);
    bytes += Buffer.byteLength(value.content);
    if (bytes > 2_000_000 || seen.has(value.path.toLowerCase())) throw new Error('Oversized or duplicate Codex setup');
    seen.add(value.path.toLowerCase());
    if (value.path.startsWith('agents/')) {
      const name = String(parse(value.content).name);
      if (names.has(name)) throw new Error('Duplicate Codex agent name');
      names.add(name);
    }
    return value;
  });
}
export function codexAgents(files: CodexConfigFile[]): Array<{ name: string; description: string }> {
  return files.filter(f => f.path.startsWith('agents/')).map(f => {
    const role = parse(f.content); return { name: String(role.name), description: String(role.description) };
  });
}
/** Install only validated setup files. Credential and conversation files are never changed. */
export function applyCodexConfig(home: string, raw: unknown, lead?: string | null): { config: Record<string, unknown>; instructions: string } {
  const files = parseCodexFiles(raw), config: Record<string, unknown> = {}, roles: Record<string, unknown> = {};
  let instructions = files.find(f => f.path === 'AGENTS.md')?.content ?? '';
  let selected = !lead;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const manifest = path.join(home, '.portal-setup-files.json');
  let old: string[] = [];
  try { old = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { /* first install */ }
  const safeTarget = (rel: string) => {
    const full = path.join(home, rel);
    for (let p = full; p !== path.dirname(p) && p !== path.resolve(home); p = path.dirname(p)) {
      try {
        if (fs.lstatSync(p).isSymbolicLink()) throw new Error('Links are not allowed in Codex setup');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return full;
  };
  for (const rel of old) if (typeof rel === 'string' && CODEX_CONFIG_PATH.test(rel) && !rel.includes('..') && !files.some(f => f.path === rel)) fs.rmSync(safeTarget(rel), { force: true });
  for (const file of files) {
    if (file.path === 'config.toml') { Object.assign(config, parse(file.content)); continue; }
    const full = safeTarget(file.path); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, file.content, { mode: 0o600 });
    if (file.path.startsWith('agents/')) {
      const role = parse(file.content);
      roles[String(role.name)] = { description: role.description, config_file: full };
      if (role.name === lead) { selected = true; instructions += '\n\n' + role.developer_instructions; }
    }
  }
  if (!selected) throw new Error(`Codex agent "${lead}" is not in your Agent setup. Choose an installed agent.`);
  if (Object.keys(roles).length) config.agents = roles;
  fs.writeFileSync(manifest, JSON.stringify(files.filter(f => f.path !== 'config.toml').map(f => f.path)), { mode: 0o600 });
  return { config, instructions };
}
