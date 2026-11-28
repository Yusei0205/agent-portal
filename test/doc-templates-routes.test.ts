/**
 * Doc template routes: upload, list, make default, delete (repository-backed).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { buildDocx } from '../server/docgen.ts';

let baseUrl = '';
let cookie = '';
let projectId = '';
let docx: Buffer;

async function upload(path: string, filename: string, extra = ''): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(`${baseUrl}${path}?filename=${encodeURIComponent(filename)}${extra}`, {
    method: 'POST',
    headers: { cookie, 'x-requested-with': 'agent-portal', 'content-type': 'application/octet-stream' },
    body: new Uint8Array(docx),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('doc template routes', () => {
  before(async () => {
    const srv = await createTestServer();
    baseUrl = srv.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', {
      method: 'POST',
      body: { email: `tpl-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' },
    });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'Templates' }, cookie });
    projectId = ((p.body as any).project as any).id as string;
    docx = await buildDocx('# Template\n\nBody');
  });
  after(cleanup);

  it('first upload becomes the default, second does not, switching default works, delete removes', async () => {
    const a = await upload(`/api/projects/${projectId}/templates/upload`, 'a.docx', '&name=First');
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.template.name, 'First');
    assert.equal(a.body.template.is_default, true);

    const b = await upload(`/api/projects/${projectId}/templates/upload`, 'b.docx', '&name=Second');
    assert.equal(b.status, 200);
    assert.equal(b.body.template.is_default, false);

    const list1 = await fetchJson(baseUrl, `/api/projects/${projectId}/templates`, { cookie });
    assert.equal(((list1.body as any).templates as any[]).length, 2);

    const put = await fetchJson(baseUrl, `/api/projects/${projectId}/templates/${b.body.template.id}/default`, { method: 'PUT', body: {}, cookie });
    assert.equal(put.status, 200);
    const list2 = (await fetchJson(baseUrl, `/api/projects/${projectId}/templates`, { cookie })).body as any;
    const byName = Object.fromEntries(list2.templates.map((t: any) => [t.name, t.is_default]));
    assert.deepEqual(byName, { First: false, Second: true });

    const del = await fetchJson(baseUrl, `/api/projects/${projectId}/templates/${a.body.template.id}`, { method: 'DELETE', cookie });
    assert.equal(del.status, 200);
    const list3 = (await fetchJson(baseUrl, `/api/projects/${projectId}/templates`, { cookie })).body as any;
    assert.equal(list3.templates.length, 1);
    const gone = await fetchJson(baseUrl, `/api/projects/${projectId}/templates/${a.body.template.id}`, { method: 'DELETE', cookie });
    assert.equal(gone.status, 404);
  });

  it('portal templates are admin managed', async () => {
    const up = await upload('/api/settings/templates/upload', 'portal.docx', '&name=Portal');
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const list = (await fetchJson(baseUrl, '/api/settings/templates', { cookie })).body as any;
    assert.equal(list.templates.length, 1);
    const del = await fetchJson(baseUrl, `/api/settings/templates/${up.body.template.id}`, { method: 'DELETE', cookie });
    assert.equal(del.status, 200);
  });
});
