/**
 * `make-doc <spec.json | ->`: create a Word, Excel, CSV or PowerPoint file from a JSON description.
 * Prints one JSON line on success. Output paths must stay inside the current folder.
 * See the make-documents skill (server/skills.ts) for the spec format.
 */
import fs from 'node:fs';
import { DocError, generate, type DocSpec } from './docgen.ts';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) throw new DocError('Usage: make-doc <spec.json | ->   (use - to read the JSON from stdin)');
  const raw = arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8');
  let spec: DocSpec;
  try {
    spec = JSON.parse(raw);
  } catch (e: any) {
    throw new DocError(`The spec is not valid JSON: ${e.message}`);
  }
  const r = await generate(spec);
  process.stdout.write(JSON.stringify({ ok: true, ...r }) + '\n');
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ ok: false, error: e instanceof DocError ? e.message : `Unexpected error: ${e?.message ?? e}` }) + '\n');
  process.exit(1);
});
