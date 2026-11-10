/**
 * Reads a Word, Excel or PDF document as the portal's API-simulation importer does, so an agent can work from the same
 * text: converted to markdown, cleaned of spreadsheet noise, and cut into numbered sections at its headings.
 *
 *   node --import tsx scripts/api-spec/doc-to-markdown.mts <file> [--outline | --sections 3,4,5 | --all]
 *
 *   --outline   (default) one line per section: id, heading level, title, size and the start of its text
 *   --sections  the full text of the listed section ids (comma separated), in document order
 *   --all       the whole cleaned document
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const load = <T,>(rel: string): Promise<T> => import(pathToFileURL(path.join(root, rel)).href) as Promise<T>;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^[\d,]+$/.test(a));
if (!file) {
  console.error('Usage: node --import tsx scripts/api-spec/doc-to-markdown.mts <file.docx|.xlsx|.pdf> [--outline | --sections 3,4,5 | --all]');
  process.exit(2);
}

const { convertToMarkdown } = await load<{ convertToMarkdown: (p: string, mime: string) => Promise<string> }>('server/convert.ts');
const x = await load<{
  compactMarkdown: (s: string) => string;
  splitSections: (s: string) => Array<{ id: number; level: number; title: string; body: string }>;
  outlineUser: (sections: Array<{ id: number; level: number; title: string; body: string }>) => string;
}>('server/api-sim/ai-extract.ts');

const markdown = x.compactMarkdown(await convertToMarkdown(path.resolve(file), ''));
const sections = x.splitSections(markdown);

if (args.includes('--all')) {
  console.log(markdown);
} else if (args.includes('--sections')) {
  const ids = new Set((args[args.indexOf('--sections') + 1] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n)));
  if (ids.size === 0) { console.error('--sections needs section ids, for example --sections 2,3,4'); process.exit(2); }
  const missing = [...ids].filter((i) => !sections[i]);
  if (missing.length) { console.error(`No such section: ${missing.join(', ')} (the document has ${sections.length}, numbered from 0)`); process.exit(2); }
  for (const s of sections.filter((s) => ids.has(s.id))) console.log(`${s.level > 0 ? `${'#'.repeat(s.level)} ${s.title}\n` : ''}${s.body}\n`);
} else {
  console.log(x.outlineUser(sections));
}
