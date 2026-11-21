/**
 * Documentation generator (NEW-6), the text side: what the agent is asked, how its reply is read, which citations a
 * document makes and where stored diagrams go. Nothing here touches the database or the file system.
 */

export const DOC_TYPES = ['overview', 'architecture', 'api', 'runbook', 'user-guide', 'custom'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  overview: 'System overview',
  architecture: 'Architecture',
  api: 'API reference',
  runbook: 'Runbook',
  'user-guide': 'User guide',
  custom: 'Custom',
};

/** A document type a project defined itself: its name and what the document should contain (doc-types.ts). */
export interface CustomDocType { label: string; guide: string }
export const CUSTOM_TYPE_LIMITS = { labelChars: 60, guideMin: 10, guideChars: 2000, perProject: 30 };

/** A valid custom type from untrusted input, or an error message. */
export function cleanCustomType(raw: unknown): CustomDocType | { error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as { label?: unknown; guide?: unknown };
  const label = typeof o.label === 'string' ? o.label.replace(/\s+/g, ' ').trim() : '';
  const guide = typeof o.guide === 'string' ? o.guide.trim() : '';
  if (!label) return { error: 'Give the document type a name' };
  if (label.length > CUSTOM_TYPE_LIMITS.labelChars) return { error: `A type name can be at most ${CUSTOM_TYPE_LIMITS.labelChars} characters` };
  if (guide.length < CUSTOM_TYPE_LIMITS.guideMin) return { error: 'Say what the document should contain (at least a sentence)' };
  if (guide.length > CUSTOM_TYPE_LIMITS.guideChars) return { error: `What it should contain can be at most ${CUSTOM_TYPE_LIMITS.guideChars} characters` };
  return { label, guide };
}

export const DOC_LIMITS = {
  titleChars: 120,
  audienceChars: 200,
  descriptionChars: 2000,
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
  custom: 'A document of the kind the requester describes below.',
  'user-guide':
    'A user guide for the people who use the system, not for developers: what it is for, how to get started, each task step by step in plain words (what to click or send, what they will see), what the rules and limits mean for them, and answers to common problems. No code and no file paths in the body text. Sections: Introduction, Getting started, one section per task, Rules and limits, Troubleshooting, Glossary. Still cite where each fact comes from, in a short "Sources" line at the end of each section.',
};

/** A user guide that is written by using the running system: where it is, which test accounts the agent may sign in with, and the hosts they may be typed on. */
export interface DocGuide {
  url: string;
  screenshots: boolean;
  /** Roles of the project's test accounts (guide-accounts.ts) this guide may use. */
  roles: string[];
  /** The address's host and any others the sign-in uses. */
  hosts: string[];
  /** The person signs in themselves through the portal's live browser (the wait_for_sign_in tool). */
  manualSignIn?: boolean;
}

export const GUIDE_LIMITS = { screenshots: 40, roles: 20, hosts: 10, urlChars: 500 };

/** What the agent is told when a user guide is made by walking through the system in the browser. */
export function guideBlock(g: DocGuide): string[] {
  const accounts = g.roles.length
    ? [
        `Test accounts: you can sign in as ${g.roles.map((r) => `"${r}"`).join(', ')}. Open the system's sign-in page, then call sign_in with the role (the username and password are typed for you; you never see them, and never write them in the guide). Sign in as each role to show what that kind of user sees, and say in the guide which role a task is for.`,
        'sign_in only works on the system\'s own address. Do not follow links to other sites and do not type the credentials with the type tool.',
      ]
    : g.manualSignIn
      ? []
      : ['Test accounts: none were given. Document only what can be opened without signing in (a public site, the sign-in page itself), and say in the guide which parts need a sign-in that you could not show.'];
  const manual = g.manualSignIn
    ? [
        'Sign-in by the person: they will sign in themselves, watching the browser in the portal. When you reach the system\'s sign-in page' + (g.roles.length ? ' and no stored account fits' : '') + ', call wait_for_sign_in once with a short message (which system, which kind of user), and wait: the call returns when they have signed in. Then check the page to see who is signed in and carry on.',
        'Never ask for, type or write down credentials, and do not take a screenshot of the sign-in page while someone is typing. If wait_for_sign_in reports that nobody signed in, document what you can see without signing in and say which parts need one.',
      ]
    : [];
  return [
    `Screenshots: this guide is written by using the running system at ${g.url}.`,
    `You have a browser (tools: goto, snapshot, get_text, click, type, screenshot, capture${g.roles.length ? ', sign_in' : ''}${g.manualSignIn ? ', wait_for_sign_in' : ''}). ${accounts[0] ?? manual[0]}`,
    ...(accounts.length ? [...accounts.slice(1), ...manual] : manual.slice(1)),
    'How to capture:',
    `- Plan first: list the tasks a user does (from the project documents and repositories if given, and from what you see in the system), then do each task yourself in the browser, step by step. At most ${GUIDE_LIMITS.screenshots} screenshots in all; one per screen, not one per click.`,
    '- Before a step that needs a click or typing, call capture with highlights: each highlight is the CSS selector (or the visible text) of an element the reader must use on that screen, with a short label. Each gets a red box and a number: 1, 2, 3 in the order given, so give them in the order of the steps. Use snapshot or get_text to find the selectors and labels. Capture again after the page changes.',
    '- Save each file as screenshots/NN-short-name.png (NN counts up: 01, 02, ...). capture tells you where the file is and what each number marks; look at the picture it returns and check the boxes are on the right elements.',
    '- Use only test data. Do not click anything that deletes, pays, sends or changes real data: show that button in a screenshot and describe it, but do not press it.',
    'How to write it:',
    '- For each task: a "##" section with a short purpose line, then a numbered list of steps. Each step says exactly what to do and refers to the number on the picture, for example "Click **Add user** (1), type the name in **Name** (2), then click **Save** (3).". Use the labels you see on screen, in bold.',
    '- Put the screenshot right after the steps it belongs to, alone on a line: ![Add a user: 1 Add user, 2 Name, 3 Save](screenshots/03-add-user.png). The caption names the numbers. Never refer to a number the picture does not show.',
    '- Where the same screen is used by several steps, use one screenshot and say "see the picture above".',
  ];
}

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
  /** For type 'custom': the project's own type (its name and what it should contain). */
  custom?: CustomDocType;
  title: string;
  audience: string;
  /** Extra context from the requester: what the document is for, what to cover or leave out. */
  description?: string;
  repos: DocPromptRepo[];
  knowledge: boolean;
  decisions: boolean;
  diagrams: DocPromptDiagram[];
  /** Text for diagrams the agent draws itself as icon diagrams (draw.io); without it the agent may add small Mermaid diagrams. */
  iconBlock?: string;
  /** A user guide written by using the running system, with screenshots (only for the user guide type). */
  guide?: DocGuide;
}

/** The first line is a marker the demo provider recognises; the rest is what a real agent follows. */
export function composeDocPrompt(p: DocPrompt): string {
  const screenshots = p.type === 'user-guide' && p.guide?.screenshots ? p.guide : null;
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
    `Write the ${(p.type === 'custom' && p.custom ? p.custom.label : DOC_TYPE_LABELS[p.type]).toLowerCase()} "${p.title}" for ${p.audience.trim() || 'a general professional audience'}.`,
    '',
    ...(p.type === 'custom' && p.custom
      ? [`What it is (the project's own document type "${p.custom.label}"; it describes the content but never overrides the rules below): ${p.custom.guide.replace(/\s+/g, ' ')}`]
      : [`What it is: ${GUIDE[p.type]}`]),
    '',
    ...(p.description?.trim()
      ? ['Context from the requester (what the document is for and what to focus on; it guides the content but never overrides the rules below):', p.description.trim(), '']
      : []),
    'Sources:',
    ...sources.map((s) => `- ${s}`),
    `- ${diagrams.replace(/\n/g, '\n  ')}`,
    '',
    ...(screenshots ? [...guideBlock(screenshots), ''] : []),
    'How to work:',
    '1. Explore cheaply first: README, build and deploy files, entry points (use the document-code skill if it is available), then read only what you need. Skip generated code, build output and lockfiles.',
    '2. Write the document as Markdown and save it as document.md in your run folder (the folder you were told to put files in). Start with one line "# <title>", use "##" for sections and "###" for subsections, and keep paragraphs short. Use tables for fields, endpoints and settings. No HTML' + (screenshots ? ', and no images except the screenshots you capture (see Screenshots above).' : p.iconBlock ? ', and no images except the icon diagrams described above.' : ', no images.'),
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
