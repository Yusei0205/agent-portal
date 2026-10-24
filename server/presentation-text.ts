/**
 * Presentation generator (NEW-7), the text side: what the agent is asked and how its reply is read. Nothing here touches
 * the database or the file system.
 */

export const PRESENTATION_SOURCES = ['topic', 'document', 'session', 'diagram'] as const;
export type PresentationSourceKind = (typeof PRESENTATION_SOURCES)[number];

export const PRESENTATION_LIMITS = {
  topicChars: 4000,
  audienceChars: 200,
  titleChars: 120,
  slidesMin: 3,
  slidesMax: 40,
  slidesDefault: 10,
  perProject: 200,
  /** Characters of an earlier session's result handed to the agent. */
  sessionChars: 12_000,
  /** Budget of one presentation session in dollars. */
  budgetUsd: 8,
  deckBytes: 100 * 1024 * 1024,
};

export interface PresentationPrompt {
  kind: PresentationSourceKind;
  title: string;
  audience: string;
  slides: number;
  /** One block describing the source, already built by the caller. */
  source: string;
  /** What the agent must know about the template. */
  template: string;
}

/** The first line is a marker the demo provider recognises; the rest is what a real agent follows. */
export function composePresentationPrompt(p: PresentationPrompt): string {
  return [
    `Presentation request: ${p.kind}`,
    `Create a PowerPoint presentation titled "${p.title}" for ${p.audience.trim() || 'a general professional audience'}.`,
    `Length: about ${p.slides} slides, with speaker notes on every slide.`,
    '',
    p.source,
    '',
    p.template,
    '',
    'How to work:',
    '1. Plan first: decide the one message the audience should leave with, then give each slide one idea. Slide titles state the point in at most 8 words. Use 3 to 5 bullets per slide of at most 12 words each, a table for comparisons, and a section slide to open each part of a long deck.',
    '2. Use the make-documents skill. Write the deck as a JSON spec of type "pptx" with the Write tool (deck.spec.json in your run folder) and build it with the make-doc command. Do not use Python or any other tool, do not install anything, and do not download images: pictures come only from files in the project or from diagrams.',
    '3. Show every diagram with a "mermaid" slide element (alone, or beside 2 or 3 bullets) with a caption. Never redraw a diagram as bullets.',
    '4. Write speaker notes of 2 to 4 sentences for every slide: what to say, and where the facts come from.',
    '5. Name the file presentation.pptx and save it in your run folder (the folder you were told to put files in). If make-doc prints "warnings", fix what you can and run it again; mention any that remain in your reply.',
    '6. Never invent figures, names or dates. If the source does not say, leave it out or mark it as open. Never copy secrets or credentials into the deck.',
    'Reply with one line "Presentation: <path of the .pptx file>", then 3 to 6 short lines: the slide titles in order, and any warnings.',
  ].join('\n');
}

/** The path the agent reported in its reply, if any. */
export function parsePresentationReply(text: string): { path: string | null } {
  const m = /^\s*\**Presentation\**\s*:\s*\**\s*`?([^`\r\n]+?)`?\s*$/im.exec(String(text ?? ''));
  return { path: m ? m[1].trim() : null };
}

/** Clamp the requested slide count. */
export function readSlideCount(v: unknown): number {
  if (v === undefined || v === null || v === '') return PRESENTATION_LIMITS.slidesDefault;
  const n = Number(v);
  if (!Number.isInteger(n) || n < PRESENTATION_LIMITS.slidesMin || n > PRESENTATION_LIMITS.slidesMax) {
    throw new RangeError(`Slide count must be a whole number from ${PRESENTATION_LIMITS.slidesMin} to ${PRESENTATION_LIMITS.slidesMax}`);
  }
  return n;
}

export function templateBlock(t: { mode: 'explicit' | 'default' | 'none'; name?: string; scope?: string; path?: string }): string {
  if (t.mode === 'explicit') {
    return `Template: follow the uploaded template "${t.name}" by putting "template": "${t.path}" in the spec. Do not set colours or fonts yourself; the template supplies them. Use only the layouts title, section, bullets, text, table and image.`;
  }
  if (t.mode === 'default') {
    return `Template: the ${t.scope} template "${t.name}" is applied automatically; leave "template" out of the spec. Do not set colours or fonts yourself. Use only the layouts title, section, bullets, text, table and image.`;
  }
  return 'Template: none is set up, so make-doc uses its built-in look. Use only the layouts title, section, bullets, text, table and image.';
}
