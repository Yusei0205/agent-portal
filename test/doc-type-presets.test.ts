/** Ready-made document types: each is a valid custom type for the server, and saved ones are not offered again. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { DOC_TYPE_PRESETS, unsavedPresets } from '../web/src/lib/doc-type-presets.js';
import { cleanCustomType } from '../server/generated-doc-text.ts';

type Preset = { key: string; label: string; guide: string };

describe('document type presets', () => {
  it('offers the nine developer documents, each accepted by the server unchanged', () => {
    assert.deepEqual((DOC_TYPE_PRESETS as Preset[]).map((p) => p.label), [
      'Technical design document', 'Deployment guide', 'Developer onboarding guide', 'Configuration reference', 'Data model and dictionary',
      'Integration specification', 'Testing strategy', 'Security overview', 'Architecture decision records',
    ]);
    for (const p of DOC_TYPE_PRESETS as Preset[]) {
      const c = cleanCustomType(p);
      assert.ok(!('error' in c), `${p.label}: ${JSON.stringify(c)}`);
      assert.deepEqual(c, { label: p.label, guide: p.guide });
    }
    assert.equal(new Set((DOC_TYPE_PRESETS as Preset[]).map((p) => p.key)).size, DOC_TYPE_PRESETS.length);
  });

  it('the deployment guide asks for the resource relationships and backups', () => {
    const d = (DOC_TYPE_PRESETS as Preset[]).find((p) => p.key === 'deployment-guide')!;
    assert.match(d.guide, /Resource relationships/);
    assert.match(d.guide, /Backup/);
  });

  it('leaves out presets the project already saved, by name, ignoring case', () => {
    const rest = unsavedPresets([{ label: 'deployment GUIDE' }, { label: 'Something else' }]) as Preset[];
    assert.equal(rest.length, DOC_TYPE_PRESETS.length - 1);
    assert.ok(!rest.some((p) => p.key === 'deployment-guide'));
    assert.equal(unsavedPresets(undefined).length, DOC_TYPE_PRESETS.length);
  });
});
