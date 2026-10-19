/**
 * Deterministic, offline stand-ins for model output. Demo mode uses them so every
 * feature works without an API key; the review rules are also useful on their own.
 */
import { sha256 } from '../util.ts';

/* ------------------------------------------------------------------ */
/* Unified diff parsing                                                */
/* ------------------------------------------------------------------ */

export interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  hunks: { header: string; lines: DiffLine[] }[];
  additions: number;
  deletions: number;
}

export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffFile['hunks'][number] | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = { oldPath: m?.[1] ?? '', newPath: m?.[2] ?? '', status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.newPath = line.slice(10);
    } else if (line.startsWith('Binary files')) file.binary = true;
    else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      /* path lines already captured */
    } else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = Number(m?.[1] ?? 1);
      newNo = Number(m?.[2] ?? 1);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ type: 'add', text: line.slice(1), oldLine: null, newLine: newNo++ });
        file.additions++;
      } else if (line.startsWith('-')) {
        hunk.lines.push({ type: 'del', text: line.slice(1), oldLine: oldNo++, newLine: null });
        file.deletions++;
      } else if (line.startsWith(' ')) {
        hunk.lines.push({ type: 'ctx', text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
      }
    }
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* Rule-based reviewer                                                 */
/* ------------------------------------------------------------------ */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
  file: string;
  line: number | null;
  severity: Severity;
  category: string;
  message: string;
  suggestion?: string;
}

interface Rule {
  re: RegExp;
  severity: Severity;
  category: string;
  message: string;
  suggestion: string;
  skipIf?: RegExp;
}

const RULES: Rule[] = [
  {
    re: /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][^'"\s]{6,}['"]/i,
    severity: 'critical',
    category: 'security',
    message: 'Looks like a hard-coded secret.',
    suggestion: 'Load it from an environment variable or a secrets manager, and rotate the exposed value.',
    skipIf: /process\.env|os\.environ|getenv|example|placeholder|changeme|<.*>/i,
  },
  {
    re: /AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}/,
    severity: 'critical',
    category: 'security',
    message: 'A credential or private key is committed in the code.',
    suggestion: 'Remove it from the repository history and rotate it immediately.',
  },
  {
    re: /(["'`])\s*(?:SELECT|INSERT|UPDATE|DELETE)\b.*?\1\s*\+|(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|f["'](?:SELECT|INSERT|UPDATE|DELETE)\b.*\{/i,
    severity: 'high',
    category: 'security',
    message: 'SQL is built by joining strings, which allows SQL injection.',
    suggestion: 'Use parameterised queries or the query builder instead of string concatenation.',
  },
  {
    re: /\beval\s*\(|new Function\s*\(|child_process.*exec\(|subprocess\.(?:call|run|Popen)\([^)]*shell\s*=\s*True/,
    severity: 'high',
    category: 'security',
    message: 'Dynamic code or shell execution with possible untrusted input.',
    suggestion: 'Avoid eval and shell=True; pass arguments as a list and validate inputs.',
  },
  {
    re: /rejectUnauthorized\s*:\s*false|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED/,
    severity: 'high',
    category: 'security',
    message: 'TLS certificate checks are turned off.',
    suggestion: 'Keep certificate verification on; trust a custom CA bundle if needed.',
  },
  {
    re: /catch\s*(?:\([^)]*\))?\s*\{\s*\}|except\s*:\s*pass|except Exception:\s*pass/,
    severity: 'medium',
    category: 'reliability',
    message: 'Errors are caught and silently ignored.',
    suggestion: 'Log the error or handle it explicitly so failures are visible.',
  },
  {
    re: /\bconsole\.(log|debug)\(|System\.out\.println\(|fmt\.Println\(|\bdebugger;|\bprint\(/,
    severity: 'low',
    category: 'maintainability',
    message: 'Debug output left in the change.',
    suggestion: 'Remove it or use the project logger with an appropriate level.',
    skipIf: /^\s*(\/\/|#)/,
  },
  {
    re: /:\s*any\b|as any\b/,
    severity: 'low',
    category: 'maintainability',
    message: 'Uses the `any` type, which turns off type checking here.',
    suggestion: 'Give the value a specific type or `unknown` with a type guard.',
  },
  {
    re: /http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[a-z0-9.-]+/i,
    severity: 'low',
    category: 'security',
    message: 'Plain HTTP URL; traffic would not be encrypted.',
    suggestion: 'Use https:// unless this is a local-only address.',
  },
  {
    re: /\b(TODO|FIXME|HACK|XXX)\b/,
    severity: 'info',
    category: 'maintainability',
    message: 'Unfinished work marker in new code.',
    suggestion: 'Resolve it before merging or link it to a ticket.',
  },
];

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|cs|rb|php|rs|scala|swift)$/;
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|Test\.java$/;

export function reviewDiff(diff: string): Finding[] {
  const files = parseUnifiedDiff(diff);
  const out: Finding[] = [];
  for (const f of files) {
    if (f.binary || f.status === 'deleted') continue;
    const perRule = new Map<Rule, number>();
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type !== 'add') continue;
        if (l.text.length > 160 && SOURCE_EXT.test(f.newPath)) {
          out.push({ file: f.newPath, line: l.newLine, severity: 'info', category: 'style', message: `Very long line (${l.text.length} characters).`, suggestion: 'Wrap it to keep diffs and reviews readable.' });
        }
        for (const r of RULES) {
          if (!r.re.test(l.text) || r.skipIf?.test(l.text)) continue;
          const n = perRule.get(r) ?? 0;
          if (n >= 5) continue;
          perRule.set(r, n + 1);
          out.push({ file: f.newPath, line: l.newLine, severity: r.severity, category: r.category, message: r.message, suggestion: r.suggestion });
        }
      }
    }
  }
  const changedSource = files.filter((f) => SOURCE_EXT.test(f.newPath) && !TEST_PATH.test(f.newPath) && f.additions > 10);
  const changedTests = files.some((f) => TEST_PATH.test(f.newPath));
  if (changedSource.length && !changedTests) {
    out.push({
      file: changedSource[0].newPath,
      line: null,
      severity: 'medium',
      category: 'testing',
      message: `${changedSource.length} source file(s) changed with no test changes.`,
      suggestion: 'Add or update tests that cover the new behaviour.',
    });
  }
  const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
  return out.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

/* ------------------------------------------------------------------ */
/* Text helpers for learning content                                   */
/* ------------------------------------------------------------------ */

export interface SourceSection {
  docId: string;
  docName: string;
  sectionId: number;
  heading: string;
  anchor: string;
  content: string;
}

function rng(seed: string) {
  let a = parseInt(sha256(seed).slice(0, 8), 16);
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Prose without code blocks, tables or markdown syntax. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\|.*\|$/gm, ' ')
    .replace(/^#+\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sentences(md: string): string[] {
  return plainText(md)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 240 && /[a-z]/.test(s));
}

const STOP = new Set(
  'the a an and or of to in on for with by from at is are was were be this that these those it its as not no yes can will may must should into out up down over under about after before when where which who whom what why how all any each other such only own same so than too very just also our your their his her they them we you i'.split(
    ' ',
  ),
);

export function keywords(text: string, max = 6): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w);
}

/** Candidate glossary terms: acronyms, `code`, and repeated Capitalised Phrases. */
export function extractTerms(sections: SourceSection[], max = 12): string[] {
  const counts = new Map<string, number>();
  const bump = (t: string, by = 1) => {
    const term = t.trim();
    if (term.length < 2 || term.length > 40) return;
    if (STOP.has(term.toLowerCase())) return;
    counts.set(term, (counts.get(term) ?? 0) + by);
  };
  for (const s of sections) {
    for (const m of s.content.matchAll(/`([^`\n]{2,40})`/g)) if (/[A-Z_./(]|[a-z][A-Z]/.test(m[1])) bump(m[1], 2);
    const text = plainText(s.content);
    for (const m of text.matchAll(/\b[A-Z]{2,6}s?\b/g)) bump(m[0].replace(/s$/, ''));
    for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)) bump(m[1]);
  }
  return [...counts.entries()]
    .filter(([t, n]) => n >= 2 || /^[A-Z]{2,6}$/.test(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t);
}

function definitionFor(term: string, sections: SourceSection[]): { business: string; technical: string; source: SourceSection | null } {
  for (const s of sections) {
    const sent = sentences(s.content).find((x) => x.includes(term));
    if (sent) {
      const ids = [...s.content.matchAll(/`([^`\n]{2,60})`/g)].map((m) => m[1]).filter((x) => x !== term).slice(0, 3);
      return {
        business: sent,
        technical: ids.length ? `Appears with ${ids.map((i) => `\`${i}\``).join(', ')} in “${s.heading}”.` : `Described in “${s.heading}” (${s.docName}).`,
        source: s,
      };
    }
  }
  return { business: `Used in the project documents.`, technical: `See the project documents.`, source: null };
}

const ENDPOINT_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_\-/{}:.]*)/g;

function endpoints(sections: SourceSection[]): { method: string; path: string; heading: string }[] {
  const seen = new Set<string>();
  const out: { method: string; path: string; heading: string }[] = [];
  for (const s of sections) {
    for (const m of s.content.matchAll(ENDPOINT_RE)) {
      const key = `${m[1]} ${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ method: m[1], path: m[2], heading: s.heading });
    }
  }
  return out.slice(0, 12);
}

function mermaidLabel(s: string): string {
  return s.replace(/["\[\]{}()<>|#;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Step';
}

export interface LearnDraft {
  business_md: string;
  technical_md: string;
  glossary: { term: string; business: string; technical: string }[];
}

export function demoLearnDoc(title: string, kind: string, sections: SourceSection[]): LearnDraft {
  const terms = extractTerms(sections);
  const glossary = terms.map((t) => {
    const d = definitionFor(t, sections);
    return { term: t, business: d.business, technical: d.technical };
  });
  const firsts = sections.map((s) => ({ s, first: sentences(s.content)[0] })).filter((x) => x.first);
  const eps = endpoints(sections);
  const sourcesList = [...new Map(sections.map((s) => [s.docName, s])).values()].map((s) => `- ${s.docName}`).join('\n');

  if (kind === 'glossary') {
    return {
      business_md: `# ${title}\n\nPlain-language meanings of the terms used across this project.\n\n| Term | What it means |\n| --- | --- |\n${glossary.map((g) => `| ${g.term} | ${g.business.replace(/\|/g, '/')} |`).join('\n')}\n`,
      technical_md: `# ${title} (technical)\n\nWhere each term shows up in the specifications.\n\n| Term | Technical reference |\n| --- | --- |\n${glossary.map((g) => `| \`${g.term}\` | ${g.technical.replace(/\|/g, '/')} |`).join('\n')}\n\n## Sources\n\n${sourcesList}\n`,
      glossary,
    };
  }

  if (kind === 'faq') {
    const qa = firsts.slice(0, 10);
    return {
      business_md: `# ${title}\n\n${qa.map(({ s, first }) => `### What does “${s.heading}” cover?\n\n${first}`).join('\n\n')}\n`,
      technical_md: `# ${title} (technical)\n\n${qa
        .map(({ s }) => {
          const detail = sentences(s.content).slice(0, 3).join(' ');
          const ids = [...s.content.matchAll(/`([^`\n]{2,60})`/g)].map((m) => `\`${m[1]}\``).slice(0, 4);
          return `### How is “${s.heading}” implemented?\n\n${detail}${ids.length ? `\n\nRelated identifiers: ${ids.join(', ')}.` : ''}\n\n_Source: ${s.docName} › ${s.heading}_`;
        })
        .join('\n\n')}\n`,
      glossary,
    };
  }

  const steps = firsts.slice(0, 7);
  const flow = steps.length >= 2
    ? '```mermaid\nflowchart LR\n' + steps.map(({ s }, i) => `  S${i}["${mermaidLabel(s.heading)}"]`).join('\n') + '\n  ' + steps.map((_x, i) => `S${i}`).join(' --> ') + '\n```'
    : '';
  const seq = eps.length
    ? '```mermaid\nsequenceDiagram\n  participant User\n  participant App\n  participant API\n' +
      eps.slice(0, 6).map((e) => `  App->>API: ${e.method} ${e.path.replace(/[;#]/g, '')}\n  API-->>App: response`).join('\n') +
      '\n```'
    : '';

  const business_md = `# ${title}

${firsts[0]?.first ?? 'This guide explains the topic in plain language.'}

## In short

${firsts.slice(0, 3).map(({ first }) => `- ${first}`).join('\n')}

## How it works, step by step

${steps.map(({ s, first }, i) => `${i + 1}. **${s.heading}.** ${first}`).join('\n')}

${flow}

## Words you will see

${glossary.slice(0, 8).map((g) => `- **${g.term}**: ${g.business}`).join('\n') || '- No special terms found.'}
`;

  const technical_md = `# ${title} (technical)

${sections.length} source section(s) from ${new Set(sections.map((s) => s.docName)).size} document(s).

## Components and responsibilities

| Section | Source | Key point |
| --- | --- | --- |
${sections.slice(0, 15).map((s) => `| ${s.heading.replace(/\|/g, '/')} | ${s.docName} | ${(sentences(s.content)[0] ?? '').replace(/\|/g, '/').slice(0, 140)} |`).join('\n')}

${eps.length ? `## Interfaces\n\n| Method | Path | Described in |\n| --- | --- | --- |\n${eps.map((e) => `| ${e.method} | \`${e.path}\` | ${e.heading} |`).join('\n')}\n\n${seq}\n` : ''}
## Details

${sections
  .slice(0, 8)
  .map((s) => `### ${s.heading}\n\n${s.content.slice(0, 900).trim()}${s.content.length > 900 ? '\n\n…' : ''}`)
  .join('\n\n')}

## Sources

${sourcesList}
`;
  return { business_md, technical_md, glossary };
}

/* ------------------------------------------------------------------ */
/* Quizzes                                                             */
/* ------------------------------------------------------------------ */

export interface QuizQuestion {
  id: string;
  type: 'mcq' | 'truefalse' | 'short';
  question: string;
  options?: string[];
  answer: string;
  explanation: string;
  source: { docId: string; sectionId: number; heading: string; docName: string; anchor: string };
  verified?: boolean;
}

export function demoQuiz(sections: SourceSection[], audience: string, difficulty: string, count: number, seed: string): QuizQuestion[] {
  const rand = rng(seed + audience + difficulty);
  const terms = extractTerms(sections, 30);
  const out: QuizQuestion[] = [];
  const pool = shuffle(
    sections.flatMap((s) => sentences(s.content).map((sent) => ({ s, sent }))),
    rand,
  );
  const src = (s: SourceSection) => ({ docId: s.docId, sectionId: s.sectionId, heading: s.heading, docName: s.docName, anchor: s.anchor });
  const used = new Set<string>();

  // Multiple choice: fill the blank with the right term.
  for (const { s, sent } of pool) {
    if (out.length >= Math.ceil(count * (difficulty === 'easy' ? 0.5 : 0.7))) break;
    const term = terms.find((t) => sent.includes(t) && sent.replace(t, '').trim().length > 20);
    if (!term || used.has(sent)) continue;
    const distractors = shuffle(terms.filter((t) => t !== term && !sent.includes(t)), rand).slice(0, 3);
    if (distractors.length < 2) continue;
    used.add(sent);
    out.push({
      id: `q${out.length + 1}`,
      type: 'mcq',
      question: audience === 'technical' ? `Which term completes this statement from “${s.heading}”? ${sent.replace(term, '_____')}` : `Fill in the blank: ${sent.replace(term, '_____')}`,
      options: shuffle([term, ...distractors], rand),
      answer: term,
      explanation: sent,
      source: src(s),
    });
  }

  // True or false: keep the sentence, or swap one term for another.
  for (const { s, sent } of pool) {
    if (out.length >= count) break;
    if (used.has(sent)) continue;
    const term = terms.find((t) => sent.includes(t));
    const other = term ? terms.find((t) => t !== term && !sent.includes(t)) : undefined;
    const makeFalse = Boolean(term && other) && rand() < 0.5;
    used.add(sent);
    out.push({
      id: `q${out.length + 1}`,
      type: 'truefalse',
      question: `True or false: ${makeFalse ? sent.replace(term!, other!) : sent}`,
      options: ['True', 'False'],
      answer: makeFalse ? 'False' : 'True',
      explanation: makeFalse ? `False. The documents say: “${sent}”` : `True. The documents say: “${sent}”`,
      source: src(s),
    });
  }
  return out.slice(0, count).map((q, i) => ({ ...q, id: `q${i + 1}` }));
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Keep questions whose explanation is supported by the cited section. */
export function demoVerify(questions: QuizQuestion[], sections: SourceSection[]): QuizQuestion[] {
  const byId = new Map(sections.map((s) => [s.sectionId, norm(plainText(s.content))]));
  return questions.map((q) => {
    const text = byId.get(q.source.sectionId) ?? '';
    const quoted = q.explanation.match(/“([^”]+)”/)?.[1] ?? q.explanation;
    const ok = text.includes(norm(quoted).slice(0, 120));
    return { ...q, verified: ok };
  });
}

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

export interface Hit {
  docId: string;
  docName: string;
  sectionId: number;
  heading: string;
  anchor: string;
  content: string;
}

export function demoAnswer(question: string, allHits: Hit[]): { answer: string; citations: number[]; missing: boolean; suggestedQuestion: string } {
  // Keep only sections that mention most of the question's key terms, like a careful reader would.
  const kw = keywords(question, 8).filter((w) => !['which', 'what', 'who', 'how', 'does', 'when', 'where', 'there'].includes(w));
  const stem = (w: string) => w.slice(0, Math.max(4, Math.min(6, w.length - 1)));
  const need = Math.max(1, Math.ceil(kw.length * 0.6));
  const hits = allHits.filter((h) => {
    const text = (h.heading + ' ' + h.content).toLowerCase();
    return kw.filter((w) => text.includes(stem(w))).length >= need;
  });
  if (!hits.length) {
    return {
      answer: 'The project documents and decisions log do not answer this yet.',
      citations: [],
      missing: true,
      suggestedQuestion: question.endsWith('?') ? question : `${question}?`,
    };
  }
  const top = hits.slice(0, 3);
  const lines = top.map((h, i) => {
    const s = sentences(h.content).slice(0, 2).join(' ') || plainText(h.content).slice(0, 280);
    return `- ${s} [${i + 1}]`;
  });
  return {
    answer: `Here is what the project documents say:\n\n${lines.join('\n')}`,
    citations: top.map((h) => h.sectionId),
    missing: false,
    suggestedQuestion: '',
  };
}
