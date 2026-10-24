/**
 * `make-doc <spec.json | -> [--template <file>] [--no-template]`: create a Word, Excel, CSV or PowerPoint
 * file from a JSON description. Prints one JSON line on success. Output paths must stay inside the current folder.
 * A Word document or PowerPoint deck follows the project's template automatically (the portal leaves it under
 * .portal/templates); --template names another one inside the folder (.docx/.dotx for Word, .pptx/.potx for
 * PowerPoint) and --no-template uses the built-in look.
 * See the make-documents skill (server/skills.ts) for the spec format.
 */
import fs from 'node:fs';
import { DocError, generate, type DocSpec } from './docgen.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let template: string | false | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-template') template = false;
    else if (args[i] === '--template') {
      template = args[++i];
      if (!template) throw new DocError('--template needs the path of a template file (.docx, .dotx, .pptx or .potx)');
    } else rest.push(args[i]);
  }
  const arg = rest[0];
  if (!arg) throw new DocError('Usage: make-doc <spec.json | -> [--template <file.docx|.dotx|.pptx|.potx>] [--no-template]   (use - to read the JSON from stdin)');
  const raw = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
  let spec: DocSpec;
  try {
    spec = JSON.parse(raw);
  } catch (e: any) {
    throw new DocError(`The spec is not valid JSON: ${e.message}`);
  }
  if (template !== undefined) {
    if (spec?.type !== 'pptx' && spec?.type !== 'docx') throw new DocError('--template and --no-template apply to Word and PowerPoint files only');
    spec.template = template;
  }
  const r = await generate(spec);
  process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ ok: false, error: e instanceof DocError ? e.message : `Unexpected error: ${e?.message ?? e}` }) + '\n');
  process.exit(1);
});
