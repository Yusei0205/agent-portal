/**
 * Kyuubit brand tests: every template carries the Kyuubit brand, the Kyuubit
 * template is valid and readable, it is the default, and the one-time default
 * switch for installs still on the old default is idempotent.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { validateTemplate, applyKyuubitDefaultOnce } from '../server/themes.ts';
import { getDb } from '../server/db.ts';
import { getSetting, setSetting } from '../server/settings.ts';
import { getSettingsRepository } from '../server/repositories/settings.ts';

const root = path.resolve(import.meta.dirname, '..');
const themesDir = path.join(root, 'shared/themes');
const LOGO = fs.readFileSync(path.join(root, 'docs/superpowers/assets/kyuubit-logo.svg'), 'utf8').trim();
const TAGLINE = 'Lucky agents. Nine lives.';
const MARKER = 'theme.kyuubit_default_applied';

function loadThemes(): Array<{ file: string; json: any }> {
  return fs.readdirSync(themesDir).filter((f) => f.endsWith('.json')).map((file) => ({
    file,
    json: JSON.parse(fs.readFileSync(path.join(themesDir, file), 'utf8')),
  }));
}

function lum(hex: string): number {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

describe('Kyuubit brand in every template', () => {
  for (const { file, json } of loadThemes()) {
    it(`${file} carries the Kyuubit brand`, () => {
      assert.equal(json.brand.productName, 'Kyuubit');
      assert.equal(json.brand.tagline, TAGLINE);
      assert.equal(json.brand.logoSvg, LOGO);
    });
  }
});

describe('Kyuubit template', () => {
  const kyuubit = () => JSON.parse(fs.readFileSync(path.join(themesDir, 'kyuubit.json'), 'utf8'));

  it('passes the theme validator', () => {
    const r = validateTemplate(kyuubit());
    assert.ok(r.ok, JSON.stringify(r.errors));
  });

  for (const mode of ['dark', 'light'] as const) {
    it(`${mode}: ink on canvas and accent-ink on accent are at least 4.5:1`, () => {
      const m = kyuubit().modes[mode];
      assert.ok(contrast(m.ink, m.canvas) >= 4.5, `ink/canvas ${contrast(m.ink, m.canvas)}`);
      assert.ok(contrast(m['accent-ink'], m.accent) >= 4.5, `accent-ink/accent ${contrast(m['accent-ink'], m.accent)}`);
    });
  }
});

describe('Kyuubit default', () => {
  let baseUrl = '';
  before(async () => { baseUrl = (await createTestServer()).baseUrl; });
  after(cleanup);

  it('a fresh server serves kyuubit', async () => {
    const r = await fetchJson(baseUrl, '/api/theme');
    assert.equal((r.body as { template: { id: string } }).template.id, 'kyuubit');
  });

  async function reset(active: string, marker: boolean): Promise<void> {
    const repo = getSettingsRepository();
    await setSetting(getDb(), 'theme.active', JSON.stringify(active));
    if (marker) await setSetting(getDb(), MARKER, '"1"');
    else await repo!.deleteKey(MARKER);
  }
  const active = () => JSON.parse(getSetting(getDb(), 'theme.active')!);

  it('switches aethrix-night to kyuubit once and sets the marker', async () => {
    await reset('aethrix-night', false);
    await applyKyuubitDefaultOnce();
    assert.equal(active(), 'kyuubit');
    assert.ok(getSetting(getDb(), MARKER));
  });

  it('keeps another chosen template and still sets the marker', async () => {
    await reset('nebula', false);
    await applyKyuubitDefaultOnce();
    assert.equal(active(), 'nebula');
    assert.ok(getSetting(getDb(), MARKER));
  });

  it('does not switch back when the marker is set', async () => {
    await reset('aethrix-night', true);
    await applyKyuubitDefaultOnce();
    assert.equal(active(), 'aethrix-night');
  });

  it('a failing settings repository does not propagate and leaves the marker unset', async () => {
    await reset('aethrix-night', false);
    const repo = getSettingsRepository() as any;
    const orig = { getKey: repo.getKey, setKeys: repo.setKeys };
    const warn = console.warn;
    console.warn = () => {};
    try {
      repo.setKeys = async () => { throw new Error('transient'); };
      await assert.doesNotReject(applyKyuubitDefaultOnce());
      repo.getKey = async () => { throw new Error('transient'); };
      await assert.doesNotReject(applyKyuubitDefaultOnce());
    } finally {
      console.warn = warn;
      repo.getKey = orig.getKey;
      repo.setKeys = orig.setKeys;
    }
    assert.equal(active(), 'aethrix-night');
    assert.equal(getSetting(getDb(), MARKER), null);
  });
});
