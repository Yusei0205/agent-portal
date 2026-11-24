/**
 * Skills loaded on demand by Claude agents (progressive disclosure).
 *
 * An agent file lists two kinds of skills: `skills:` are preloaded into its prompt (rules for every task), and
 * `on-demand-skills:` appear only as an index (name and "use when…" description). The agent reads one with the portal's
 * read_skill tool when the task needs it. The run's skill library (every skill in the run's skill folders) is held by the
 * portal or the cloud runner, so reading a skill works the same in both and needs no file access outside the work folder.
 *
 * Pure: shared with agent-runner (copied into its shared/ folder at build time).
 */

export const SKILL_SERVER = 'portal-skills';
export const SKILL_TOOL = 'read_skill';
/** How Claude sees the tool. Allowed by tool-policy without asking: it only returns text the portal supplied. */
export const SKILL_TOOL_FULL_NAME = `mcp__${SKILL_SERVER}__${SKILL_TOOL}`;

export const SKILL_LIBRARY_LIMITS = { skills: 80, bodyChars: 40_000, totalChars: 600_000, descriptionChars: 400 } as const;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type SkillLibrary = Record<string, string>;

/** A skill library from untrusted input (a run payload): valid names, string bodies, within the limits; anything else dropped. */
export function parseSkillLibrary(raw: unknown): SkillLibrary {
  const out: SkillLibrary = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let total = 0;
  for (const [name, body] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= SKILL_LIBRARY_LIMITS.skills) break;
    if (!SKILL_NAME_RE.test(name) || typeof body !== 'string' || !body.trim()) continue;
    const text = body.slice(0, SKILL_LIBRARY_LIMITS.bodyChars);
    if (total + text.length > SKILL_LIBRARY_LIMITS.totalChars) break;
    out[name] = text;
    total += text.length;
  }
  return out;
}

/** What read_skill returns for a name: the skill's instructions, or a short message naming the skills that exist. */
export function readSkillResult(library: SkillLibrary, name: unknown): { text: string; found: boolean } {
  const wanted = typeof name === 'string' ? name.trim().replace(/^\$/, '') : '';
  if (wanted && Object.prototype.hasOwnProperty.call(library, wanted)) {
    return { text: `# Skill: ${wanted}\n\n${library[wanted]}`, found: true };
  }
  const names = Object.keys(library).sort();
  return {
    text: `There is no skill named "${wanted}". Skills you can read: ${names.length ? names.join(', ') : 'none'}.`,
    found: false,
  };
}

/** The heading of the index; an agent whose prompt carries it loads some skills on demand. */
export const SKILL_INDEX_HEADING = '# Skills you can load';

/** True when any of the run's agents lists skills to load on demand (only then does a run need the library). */
export function usesOnDemandSkills(agents: Record<string, { prompt: string }> | undefined): boolean {
  return Object.values(agents ?? {}).some((a) => typeof a?.prompt === 'string' && a.prompt.includes(`\n${SKILL_INDEX_HEADING}\n`));
}

/** The index added to an agent's prompt for its on-demand skills. Empty when there are none. */
export function skillIndexSection(entries: ReadonlyArray<{ name: string; description: string }>): string {
  if (!entries.length) return '';
  const lines = entries.map((e) => `- ${e.name}: ${e.description.replace(/\s+/g, ' ').trim().slice(0, SKILL_LIBRARY_LIMITS.descriptionChars)}`);
  return [
    '',
    '',
    '---',
    SKILL_INDEX_HEADING,
    `These are not loaded yet. Before you work in an area one of them covers, call the ${SKILL_TOOL} tool with its name and follow what it returns. Load only what the task needs; load the matching language or platform skill before writing code.`,
    ...lines,
  ].join('\n');
}

/** read_skill's description and handler, shared by the local engine and the cloud runner (each wraps it with its SDK's tool()). */
export function skillToolSpec(library: SkillLibrary): {
  name: string;
  description: string;
  handler: (args: { name?: unknown }) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
} {
  return {
    name: SKILL_TOOL,
    description: 'Read one of your skills by name (the list is under "Skills you can load" in your instructions) and follow what it says.',
    handler: async (args) => {
      const r = readSkillResult(library, args?.name);
      return { content: [{ type: 'text', text: r.text }], ...(r.found ? {} : { isError: true }) };
    },
  };
}
