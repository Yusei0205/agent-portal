/**
 * Documentation generator (NEW-6), the text side: what the agent is asked, how its reply is read, which citations a
 * document makes and where stored diagrams go. Nothing here touches the database or the file system.
 */

export const DOC_TYPES = ['overview', 'architecture', 'api', 'runbook', 'user-guide'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  overview: 'System overview',
  architecture: 'Architecture',
  api: 'API reference',
  runbook: 'Runbook',
  'user-guide': 'User guide',
};

export const DOC_LIMITS = {
  titleChars: 120,
  audienceChars: 200,
  repos: 8,
  diagrams: 10,
  perProject: 200,
  /** Budget of one documentation session in dollars. */
  budgetUsd: 10,
  /** Longest Markdown the portal accepts (the Word builder's own limit). */
  markdownChars: 190_000,
  /** Citations recorded per version. */
  citations: 500,
  /** Documents refreshed in one go by the loop action and the refresh-stale route. */
  refreshBatch: 5,
};

const GUIDE: Record<DocType, string> = {
  overview:
    'A system overview for someone new to the system: what it does and for whom, the main parts and how they fit together, the main flows end to end, where data lives, how to run and deploy it, and what to read next. Sections: Purpose, Users and context, Components, Key flows, Data, Running and deploying, Glossary, Open questions.',
  architecture:
    'An architecture document: the context and boundaries, the components and their responsibilities, how they communicate (APIs, queues, events, databases), data stores and their key structures, cross-cutting concerns (authentication, configuration, logging, error handling, deployment), design decisions and trade-offs, and known risks. Sections: Context, Components, Interfaces and data flow, Data stores, Cross-cutting concerns, Decisions, Risks and open questions.',
  api: 'An API reference: every endpoint, handler or public function that a client can call. For each: the method and path (or the name), what it does, the request (parameters, body fields, types, required or not), the response and status or error codes, authentication and permissions, and one example. Group them by area and use tables for fields. Sections: Overview and conventions, Authentication, one section per area, Errors, Open questions.',
  runbook:
    'An operations runbook: how to deploy, configure, monitor and troubleshoot the system. Sections: Service summary, Environments and configuration (variables, secrets by NAME only), Deploy and roll back, Health checks and monitoring, Common alerts with their first checks and fixes, Routine tasks, Recovery and escalation, Open questions. Write steps as numbered, copyable instructions.',
  'user-guide':
    'A user guide for the people who use the system, not for developers: what it is for, how to get started, each task step by step in plain words (what to click or send, what they will see), what the rules and limits mean for them, and answers to common problems. No code and no file paths in the body text. Sections: Introduction, Getting started, one section per task, Rules and limits, Troubleshooting, Glossary. Still cite where each fact comes from, in a short "Sources" line at the end of each section.',
};

export interface DocPromptRepo {
  name: string;
  slug: string;
  branch: string;
}

export interface DocPromptDiagram {
  slug: string;
  title: string;
  kind: string;
  description: string;
}

export interface DocPrompt {
  type: DocType;
  title: string;
  audience: string;
  repos: DocPromptRepo[];
  knowledge: boolean;
  decisions: boolean;
  diagrams: DocPromptDiagram[];
  /** Text for diagrams the agent draws itself as icon diagrams (draw.io); without it the agent may add small Mermaid diagrams. */
  iconBlock?: string;
}

/** The first line is a marker the demo provider recognises; the rest is what a real agent follows. */
export function composeDocPrompt(p: DocPrompt): string {
  const sources: string[] = [];
  if (p.repos.length) {
    sources.push(
      'Repositories (read-only copies; use Glob, Grep and Read, never change them):\n' + p.repos.map((r) => `  - "${r.name}" (branch ${r.branch}) in repos/${r.slug}/`).join('\n'),
    );
  } else sources.push('Repositories: none are included. Write from the project documents only.');
  sources.push(
    p.knowledge
      ? 'Project documents: converted to Markdown under docs/md/. Grep there first with a few key terms, then Read the sections you need.'
      : 'Project documents: do not use docs/md/; the requester left them out.',
  );
  sources.push(p.decisions ? 'Decisions log: docs/decisions.md. Read it; a decision recorded there is final.' : 'Decisions log: do not use docs/decisions.md; the requester left it out.');
  const diagrams = p.diagrams.length
    ? [
        'Stored diagrams: the portal inserts these for you. Where a diagram belongs, put its marker alone on a line, exactly as written, and explain it in the text around it. Do not redraw them or write your own Mermaid for the same thing.',
        ...p.diagrams.map((d) => `  - {{diagram:${d.slug}}}  "${d.title}" (${d.kind.replace('_', ' ')}): ${d.description.replace(/\s+/g, ' ').slice(0, 240) || 'no description'}`),
      ].join('\n')
    : p.iconBlock
      ? 'Stored diagrams: none were chosen. ' + p.iconBlock
      : 'Stored diagrams: none were chosen. You may add up to 2 small Mermaid diagrams (a fenced mermaid block) where they clarify a flow.';
  return [
    `Documentation request: ${p.type}`,
    `Write the ${DOC_TYPE_LABELS[p.type].toLowerCase()} "${p.title}" for ${p.audience.trim() || 'a general professional audience'}.`,
    '',
    `What it is: ${GUIDE[p.type]}`,
    '',
    'Sources:',
    ...sources.map((s) => `- ${s}`),
    `- ${diagrams.replace(/\n/g, '\n  ')}`,
    '',
    'How to work:',
    '1. Explore cheaply first: README, build and deploy files, entry points (use the document-code skill if it is available), then read only what you need. Skip generated code, build output and lockfiles.',
    '2. Write the document as Markdown and save it as document.md in your run folder (the folder you were told to put files in). Start with one line "# <title>", use "##" for sections and "###" for subsections, and keep paragraphs short. Use tables for fields, endpoints and settings. No HTML' + (p.iconBlock ? ', and no images except the icon diagrams described above.' : ', no images.'),
    '3. Cite your sources. Every statement about the code names where it comes from, as an inline code span: `<repository folder>/<path>:<line>` or `<repository folder>/<path>:<first line>-<last line>` (for example `payments/src/app.py:42` or `payments/src/app.py:10-30`), where the repository folder is the name after repos/. Cite project documents as `docs/md/<file>.md › <heading>`. Cite only files you actually opened or listed; never guess a path or a line number.',
    '4. Never invent names, figures, endpoints or dates. Where the sources do not say, write "Open question: ..." in the text and list it in the closing section. Never copy secrets, tokens, passwords or keys into the document; name the variable or secret store instead.',
    '5. Do not build a Word file; the portal does that from your Markdown with the project template.',
    'Reply with one line "Document: <path of the .md file>", then 3 to 6 short lines: the section titles in order, and anything you could not find.',
  ].join('\n');
}

/** The path the agent reported in its reply, if any. */
export function parseDocReply(text: string): { path: string | null } {
  const m = /^\s*\**Document\**\s*:\s*\**\s*`?([^`\r\n]+?)`?\s*$/im.exec(String(text ?? ''));
  return { path: m ? m[1].trim() : null };
}

/* ------------------------------------------------------------------ */
/* Diagrams                                                            */
/* ------------------------------------------------------------------ */

export function diagramMarker(slug: string): string {
  return `{{diagram:${slug}}}`;
}

export interface DiagramInsertion {
  slug: string;
  /** The Markdown to put in place of the marker (a mermaid fence, usually with the stored description). */
  markdown: string;
}

/**
 * Replace each marker line with the stored diagram. Diagrams the agent did not place are appended under "Diagrams" so a
 * chosen diagram is never lost. Markers for diagrams that were not chosen are removed. Fenced code is left alone.
 */
export function placeDiagrams(md: string, diagrams: DiagramInsertion[]): { markdown: string; placed: string[]; appended: string[]; unknown: string[] } {
  const bySlug = new Map(diagrams.map((d) => [d.slug, d]));
  const placed = new Set<string>();
  const unknown: string[] = [];
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const m = !fence ? /^\s*\{\{diagram:([\w.-]+)\}\}\s*$/.exec(line) : null;
    if (!m) {
      out.push(line);
      continue;
    }
    const d = bySlug.get(m[1]);
    if (!d) {
      unknown.push(m[1]);
      continue;
    }
    if (placed.has(d.slug)) continue;
    placed.add(d.slug);
    out.push('', d.markdown.trim(), '');
  }
  const appended = diagrams.filter((d) => !placed.has(d.slug));
  let markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
  if (appended.length) markdown += '\n## Diagrams\n\n' + appended.map((d) => d.markdown.trim()).join('\n\n') + '\n';
  return { markdown, placed: [...placed], appended: appended.map((d) => d.slug), unknown };
}

/* ------------------------------------------------------------------ */
/* Citations                                                           */
/* ------------------------------------------------------------------ */

export interface Citation {
  /** The text of the code span as written. */
  raw: string;
  /** The file path, relative to a repository root (or to the project folder for docs/...). */
  path: string;
  line: number | null;
  lineEnd: number | null;
}

const PATH_RE = /^((?:[\w@~+.-]+\/)*[\w@~+-][\w@~+.-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?::(\d+)(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)?$/;
const DOMAIN_ENDINGS = new Set(['com', 'org', 'net', 'io', 'dev', 'app', 'co', 'gov', 'edu', 'ai', 'cloud']);

/** The inline code spans of a document that look like a file (with or without a line), outside fenced code. */
export function extractCitations(md: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  let fence: string | null = null;
  for (const line of String(md).split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    for (const m of line.matchAll(/`([^`\n]{3,200})`/g)) {
      let raw = m[1].trim();
      const left = raw.split(/\s+[›>]\s+/)[0].trim();
      const p = PATH_RE.exec(left);
      if (!p || /^[a-z][a-z0-9+.-]*:\/\//i.test(left)) continue;
      const file = p[1].replace(/^\.\//, '');
      const lineNo = p[2] ?? p[4];
      const lineEnd = p[3] ?? p[5];
      const hasSlash = file.includes('/');
      if (!hasSlash && !lineNo) continue;
      const ext = file.split('.').pop()!.toLowerCase();
      if (!hasSlash && DOMAIN_ENDINGS.has(ext)) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      out.push({ raw, path: file, line: lineNo ? Number(lineNo) : null, lineEnd: lineEnd ? Number(lineEnd) : null });
    }
  }
  return out;
}

export interface ResolvedCitation extends Citation {
  repo: string | null;
  ok: boolean;
  reason: string | null;
}

/** One line for the warnings: "3 of 12 citations do not resolve: a, b, c (and 0 more)". */
export function citationWarning(cites: ResolvedCitation[]): string | null {
  const bad = cites.filter((c) => !c.ok);
  if (!bad.length) return null;
  const shown = bad.slice(0, 5).map((c) => `${c.raw}${c.reason ? ` (${c.reason})` : ''}`);
  return `${bad.length} of ${cites.length} cited ${cites.length === 1 ? 'location does' : 'locations do'} not resolve against the repository snapshot: ${shown.join('; ')}${bad.length > shown.length ? `; and ${bad.length - shown.length} more` : ''}.`;
}

/**
 * Make the Markdown start with exactly one "# title" line (Word turns it into the document title): a first heading is
 * kept, otherwise the requested title is added, and any later single-"#" headings become "##".
 */
export function normalizeMarkdown(md: string, title: string): string {
  const lines = String(md).replace(/^﻿/, '').split(/\r?\n/);
  let fence: string | null = null;
  let started = false;
  const out: string[] = [];
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    const wasFenced = fence !== null;
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    if (!started && !line.trim()) continue;
    const isH1 = !wasFenced && !f && /^#\s+\S/.test(line);
    if (!started) {
      started = true;
      if (!isH1) out.push(`# ${title}`, '');
      out.push(line);
      continue;
    }
    out.push(isH1 ? line.replace(/^#\s+/, '## ') : line);
  }
  return out.join('\n').replace(/\s+$/, '') + '\n';
}
