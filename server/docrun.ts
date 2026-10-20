/** The "Document a repository" run: builds the prompt that sends an agent through the document-code skill. */
import { badRequest } from './util.ts';

export type DocOutput = 'markdown' | 'word' | 'markdown-word' | 'slides';

const OUTPUTS: Record<DocOutput, string> = {
  markdown: 'Markdown files in the run folder, under docs/.',
  word: 'One Word document (.docx), built with the make-documents skill from your Markdown.',
  'markdown-word': 'Markdown files in the run folder under docs/, and also one combined Word document (.docx) built with the make-documents skill.',
  slides: 'A PowerPoint overview of 6 to 10 slides (.pptx) built with the make-documents skill, plus the Markdown it came from under docs/.',
};

export function checkDocOutput(v: unknown): DocOutput {
  if (typeof v !== 'string' || !(v in OUTPUTS)) throw badRequest('Output must be markdown, word, markdown-word or slides');
  return v as DocOutput;
}

export function composeDocumentPrompt(repo: { name: string; slug: string; default_branch: string }, opts: { scope?: string; output: DocOutput }): string {
  const scope = (opts.scope ?? '').trim();
  return [
    `Document the code of the repository "${repo.name}". A read-only copy of the ${repo.default_branch} branch is in repos/${repo.slug}/.`,
    'Use the document-code skill: explore selectively, write the structured documentation, and cite file and line for every claim.',
    scope ? `Focus on: ${scope}` : 'Cover the whole repository, concentrating on what a new developer needs first.',
    `Deliver: ${OUTPUTS[opts.output]}`,
    'Do not change anything inside repos/. Never copy secrets or credentials into the documents.',
  ].join('\n');
}
