/**
 * Architecture diagrams (NEW-1), the text side: what the agent is asked, how its reply is read, and the checks a Mermaid
 * diagram must pass before it is stored. Nothing here touches the database or the file system.
 */
import { checkMermaidSource, IMAGE_LIMITS, ImageError } from './docimage.ts';

export const DIAGRAM_KINDS = ['system_context', 'components', 'data_flow'] as const;
export type DiagramKind = (typeof DIAGRAM_KINDS)[number];

export const KIND_LABELS: Record<DiagramKind, string> = {
  system_context: 'System context',
  components: 'Components',
  data_flow: 'Data flow',
};

export const DIAGRAM_LIMITS = {
  /** Same ceiling as every Mermaid diagram in a document (NEW-8). */
  mermaidChars: IMAGE_LIMITS.mermaidChars,
  lines: 600,
  descriptionChars: 4000,
  citations: 30,
  titleChars: 120,
  focusChars: 1000,
  repos: 8,
  perProject: 100,
  /** Stale diagrams one "refresh diagrams" action starts at a time. */
  refreshBatch: 5,
};

/** The reply could not be turned into a stored diagram; the message says why and goes to the person. */
export class DiagramError extends Error {}

/** The reply held no Mermaid diagram at all (as opposed to an invalid one). */
export class NoDiagramError extends DiagramError {}

/** Past this many nodes (about) a diagram stops being readable on a screen; the prompt asks for fewer, the UI warns. */
export const READABLE_NODES = 40;

/**
 * What the session is told every time it runs, including follow-up messages. The portal stores the diagram itself, so the
 * agent must not say that nothing was saved, and a request to fix or shrink it is answered with a whole new diagram.
 */
export function diagramRules(title: string): string {
  return [
    'This is a read-only task. Do not create, edit or delete any file.',
    `The portal stores the diagram from your reply by itself: it appears as "${title}" on the Create page (Diagrams tab) and as a file in the project Vault (generated/diagrams/). Never say that no file was written or that the diagram was not saved.`,
    'If you are asked to fix, shrink, split or redraw it, reply again in the same format with the complete new diagram (one mermaid block, then "Description:"); a reply without a diagram changes nothing. If you are asked where the diagram is, say where it is stored, and do not draw it again.',
    `Keep every diagram readable: at most about ${READABLE_NODES} nodes. The portal refuses more than ${DIAGRAM_LIMITS.lines} lines or ${DIAGRAM_LIMITS.mermaidChars} characters.`,
  ].join(' ');
}

export interface Density {
  nodes: number;
  lines: number;
  chars: number;
  /** Too big to read comfortably: the UI says so and suggests splitting it. */
  dense: boolean;
}

const KEYWORDS = new Set(['flowchart', 'graph', 'subgraph', 'end', 'direction', 'style', 'class', 'classDef', 'linkStyle', 'click', 'TB', 'TD', 'BT', 'RL', 'LR', 'elk', 'default']);

/** A rough size of a diagram: the number of distinct nodes (flowcharts) or lines (others). Good enough for a warning. */
export function diagramDensity(src: string): Density {
  const text = String(src ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n').length;
  let nodes = 0;
  if (/^\s*(?:---[\s\S]*?---\s*)?(?:%%[^\n]*\n\s*)*(?:flowchart|graph)\b/.test(text)) {
    const ids = new Set<string>();
    for (const raw of text.split('\n').slice(1)) {
      const l = raw
        .replace(/%%.*$/, '')
        .replace(/"[^"]*"/g, ' ')
        .replace(/\|[^|]*\|/g, ' ')
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
        .replace(/--\s*[^->=.]+?\s*(?:-->|---)/g, ' --> ');
      if (/^\s*(?:subgraph|style|classDef|class|linkStyle|click|direction)\b/.test(l)) continue;
      for (const m of l.matchAll(/[A-Za-z_]\w*/g)) if (!KEYWORDS.has(m[0])) ids.add(m[0]);
    }
    nodes = ids.size;
  } else {
    nodes = lines;
  }
  return { nodes, lines, chars: text.length, dense: nodes > READABLE_NODES || lines > 150 || text.length > 10_000 };
}

const KIND_GUIDE: Record<DiagramKind, string> = {
  system_context:
    'A system context diagram: the system as one box in the middle, the people and roles who use it, and the external systems, services, data stores and queues it talks to, with the direction and purpose of each connection. Prefer "flowchart LR" (or C4Context).',
  components:
    'A component diagram: the main building blocks inside the system (modules, services, handlers, jobs, data stores) grouped by layer or deployable with subgraphs, and the dependencies between them. Prefer "flowchart TB" (or C4Component or classDiagram).',
  data_flow:
    'A data flow diagram: how the main requests or records move through the system from entry point to storage and out again, naming each hop and what is carried. Prefer "flowchart LR" or "sequenceDiagram".',
};

export interface PromptRepo {
  name: string;
  slug: string;
  default_branch: string;
}

/** The first line is a marker the demo provider recognises; the rest is what a real agent follows. */
export function composeDiagramPrompt(kind: DiagramKind, title: string, repos: PromptRepo[], focus = ''): string {
  const where = repos.map((r) => `- "${r.name}": a read-only copy of the ${r.default_branch} branch is in repos/${r.slug}/`).join('\n');
  return [
    `Architecture diagram request: ${kind}`,
    `Draw the architecture diagram "${title}" from the code of ${repos.length === 1 ? 'this repository' : 'these repositories'}:`,
    where,
    `Diagram type: ${KIND_GUIDE[kind]}`,
    focus.trim() ? `Focus on: ${focus.trim()}` : 'Cover the whole system, concentrating on what a new developer needs to understand first.',
    `Keep the picture readable: at most about ${READABLE_NODES} nodes. If the system is bigger, group related things into subgraphs, show only the main path, and say in the Description which part to draw next as a separate diagram. One huge graph is not useful; a clear one is.`,
    'Use the document-code skill: explore selectively (manifests, entry points, route and handler registrations, configuration, infrastructure code) and base every box and arrow on code you read.',
    'Reply with exactly two parts and nothing else:',
    `1. One fenced block that starts with \`\`\`mermaid and holds a single valid Mermaid diagram. Keep it readable: at most about ${READABLE_NODES} nodes (never more than ${DIAGRAM_LIMITS.lines} lines), short plain-text labels (quote labels that contain punctuation), at most ${DIAGRAM_LIMITS.mermaidChars} characters. No HTML, no click or href directives, no %%{init} directives.`,
    '2. A line "Description:" followed by 2 to 5 sentences that say what the diagram shows and cite the source files it is based on as `repo-name/path/to/file.ext:line`.',
    'Do not create, edit or delete any file, and do not change anything inside repos/. Never copy secrets or credentials into the diagram or the description.',
  ].join('\n');
}

export interface ParsedReply {
  mermaid: string;
  description: string;
  citations: string[];
}

/** Take the first mermaid fence of the agent's reply as the diagram and the rest as its description. */
export function parseDiagramReply(text: string): ParsedReply {
  const reply = String(text ?? '');
  const m = /```mermaid[^\S\r\n]*\r?\n([\s\S]*?)```/i.exec(reply);
  if (!m) throw new NoDiagramError('The agent did not return a Mermaid diagram (a fenced ```mermaid block). The previous version, if any, was kept.');
  const mermaid = m[1].replace(/\s+$/, '');
  const rest = (reply.slice(0, m.index) + '\n' + reply.slice(m.index + m[0].length))
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*(?:#+\s*)?\**description\**:?\**[^\S\r\n]*/im, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cites = new Set<string>();
  for (const c of rest.matchAll(/`([^`\s]+\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?)`|(?<![\w`/.])([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?)?)/g)) {
    cites.add(c[1] ?? c[2]);
    if (cites.size >= DIAGRAM_LIMITS.citations) break;
  }
  return { mermaid, description: rest.slice(0, DIAGRAM_LIMITS.descriptionChars), citations: [...cites] };
}

const TYPE_RE = /^(flowchart(?:-elk)?|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|architecture-beta|block-beta)\b/;

/** The diagram type line, after any front matter, comments and directives; null when there is none. */
export function diagramType(src: string): string | null {
  let text = src.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  text = text.replace(/^\s*---\n[\s\S]*?\n---[^\S\n]*(?:\n|$)/, '');
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('%%')) continue;
    return TYPE_RE.exec(l)?.[1] ?? null;
  }
  return null;
}

/** Things a stored diagram must not contain: script hooks and anything that reaches outside the picture. */
const FORBIDDEN: [RegExp, string][] = [
  [/<\s*(?:script|iframe|object|embed|foreignObject)\b/i, 'HTML scripts or embedded objects'],
  [/javascript\s*:/i, 'javascript: links'],
  [/^\s*click\s/im, 'click directives'],
  [/securityLevel/i, 'security settings'],
  [/%%\{\s*(?:init|initialize)/i, 'init directives'],
];

/** Errors that come from running Mermaid without a browser, not from the diagram. */
const ENVIRONMENT = /DOMPurify|document is not defined|window is not defined|is not a function|Cannot find module|ERR_MODULE_NOT_FOUND/i;

type MermaidApi = { parse: (text: string, opts?: { suppressErrors?: boolean }) => Promise<unknown> };
let mermaidApi: Promise<MermaidApi | null> | null = null;

/**
 * Mermaid sanitises labels with DOMPurify, which has no DOM to work on in Node, so parsing a diagram with any label
 * fails before the syntax is checked. Parsing only reads the result (nothing is rendered or kept), so the sanitiser is
 * given do-nothing methods for the checker's sake, and only when it lacks them.
 */
async function prepareSanitizer(): Promise<void> {
  const purify: any = (await import('dompurify')).default;
  if (!purify || typeof purify.addHook === 'function') return;
  purify.addHook = () => undefined;
  purify.removeHook = () => undefined;
  purify.removeAllHooks = () => undefined;
  purify.sanitize = (s: unknown) => String(s);
}

function loadMermaid(): Promise<MermaidApi | null> {
  mermaidApi ??= prepareSanitizer()
    .then(() => import('mermaid'))
    .then((m: any) => (m.default ?? m) as MermaidApi)
    .catch(() => null);
  return mermaidApi;
}

export interface Validated {
  source: string;
  type: string;
  /** True when Mermaid's own parser accepted it; false when only the structural checks could run (Mermaid could not be loaded). */
  parsed: boolean;
}

/**
 * Size limits, an allowed diagram type, no active content, and a real parse by Mermaid. Throws DiagramError with a
 * message fit for the person who asked for the diagram.
 */
export async function validateMermaid(input: unknown): Promise<Validated> {
  let source: string;
  try {
    source = checkMermaidSource(input, 'The diagram');
  } catch (e) {
    throw new DiagramError(e instanceof ImageError ? e.message : String(e));
  }
  source = source.replace(/\r\n?/g, '\n').trim();
  const lines = source.split('\n').length;
  if (lines > DIAGRAM_LIMITS.lines) throw new DiagramError(`The diagram has ${lines} lines (max ${DIAGRAM_LIMITS.lines}).`);
  const type = diagramType(source);
  if (!type) throw new DiagramError('The diagram must start with a supported Mermaid type such as flowchart, sequenceDiagram, classDiagram, stateDiagram, erDiagram or C4Context.');
  for (const [re, what] of FORBIDDEN) if (re.test(source)) throw new DiagramError(`The diagram contains ${what}, which are not allowed.`);
  let parsed = false;
  const api = await loadMermaid();
  if (api) {
    try {
      await api.parse(source);
      parsed = true;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!ENVIRONMENT.test(msg)) {
        const brief = msg.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 300);
        throw new DiagramError(`Mermaid syntax error: ${brief}`);
      }
    }
  }
  return { source, type, parsed };
}
