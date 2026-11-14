/**
 * A user guide made by using the running system: the options are checked and stored without secrets, the agent is told how to capture
 * numbered screenshots, the Word file shows the pictures, and the zip download carries the Markdown with its screenshots.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { createTestServer, cleanup, fetchJson } from './fixtures.ts';
import { one } from '../server/db.ts';
import type { Row } from '../server/db.ts';
import { parseGuide, processDocOutput } from '../server/generated-docs.ts';
import { composeDocPrompt, guideBlock, type DocGuide } from '../server/generated-doc-text.ts';
import { guideRunPayload } from '../server/guide-accounts.ts';

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 180)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

const guideOf = (over: Partial<DocGuide> = {}): DocGuide => ({ url: 'https://app.example.com/', screenshots: true, roles: ['Admin'], hosts: ['app.example.com'], ...over });

describe('the prompt for a user guide with screenshots', () => {
  const base = { type: 'user-guide' as const, title: 'Guide', audience: 'clerks', repos: [], knowledge: false, decisions: false, diagrams: [] };

  it('tells the agent how to capture and write, names the roles, and never a password', () => {
    const goal = composeDocPrompt({ ...base, guide: guideOf({ roles: ['Admin', 'Clerk'] }) });
    assert.match(goal, /written by using the running system at https:\/\/app\.example\.com\//);
    assert.match(goal, /call capture with highlights/);
    assert.match(goal, /screenshots\/NN-short-name\.png/);
    assert.match(goal, /sign in as "Admin", "Clerk"/);
    assert.match(goal, /you never see them/);
    assert.match(goal, /no images except the screenshots you capture/);
    assert.doesNotMatch(goal, /no images\.$/m);
  });

  it('says what to do without accounts, and adds nothing for other document types or when screenshots are off', () => {
    const none = composeDocPrompt({ ...base, guide: guideOf({ roles: [] }) });
    assert.match(none, /Test accounts: none were given/);
    assert.doesNotMatch(none, /sign_in/);
    assert.doesNotMatch(composeDocPrompt({ ...base, type: 'api', guide: guideOf() }), /Screenshots:/);
    assert.doesNotMatch(composeDocPrompt({ ...base, guide: guideOf({ screenshots: false }) }), /Screenshots:/);
    assert.match(composeDocPrompt({ ...base }), /no images\./);
    assert.ok(guideBlock(guideOf()).length > 8);
  });

  it('tells the agent to wait for the person when they sign in themselves', () => {
    const manual = guideBlock(guideOf({ roles: [], manualSignIn: true })).join(' ');
    assert.match(manual, /wait_for_sign_in/);
    assert.match(manual, /Never ask for, type or write down credentials/);
    assert.doesNotMatch(manual, /none were given/);
    assert.doesNotMatch(guideBlock(guideOf()).join(' '), /wait_for_sign_in/);
  });
});

describe('user guide requests', () => {
  let baseUrl = '';
  let cookie = '';
  let projectId = '';
  const post = (body: Record<string, unknown>) => fetchJson(baseUrl, `/api/projects/${projectId}/generated-docs`, { method: 'POST', cookie, body: { name: 'Guide', docType: 'user-guide', sources: {}, ...body } });

  before(async () => {
    const srv = await createTestServer();
    baseUrl = srv.baseUrl;
    const setup = await fetchJson(baseUrl, '/api/auth/setup', { method: 'POST', body: { email: `ug-${Date.now()}@example.com`, name: 'Admin', password: 'password1234', provider: 'demo' } });
    cookie = setup.cookie ?? '';
    const p = await fetchJson(baseUrl, '/api/projects', { method: 'POST', body: { name: 'User guide' }, cookie });
    projectId = ((p.body as any).project as any).id as string;
    const accounts = await fetchJson(baseUrl, `/api/projects/${projectId}/guide-accounts`, { method: 'PUT', cookie, body: { accounts: [{ role: 'Admin', username: 'admin@t.example', password: 'S3cret-Admin!' }, { role: 'Clerk', username: 'clerk@t.example', password: 'Clerk-Pw-1' }] } });
    assert.equal(accounts.status, 200);
  });
  after(cleanup);

  it('keeps "I sign in myself" with the run, and needs no stored account for it', async () => {
    const r = await post({ guide: { screenshots: true, url: 'https://93.184.216.34/app', manualSignIn: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { doc, workflowId } = r.body as { doc: any; workflowId: string };
    assert.equal(doc.sources.guide.manualSignIn, true);
    assert.deepEqual(doc.sources.guide.roles, []);
    const run = await guideRunPayload(projectId, workflowId);
    assert.equal(run?.manualSignIn, true);
    assert.deepEqual(run?.accounts, []);
  });

  it('stores the options without a secret, tells the agent, and gives the run only the chosen accounts', async () => {
    const r = await post({ guide: { screenshots: true, url: 'https://93.184.216.34/app', roles: ['clerk'], hosts: ['login.example.com'] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const { doc, workflowId } = r.body as { doc: any; workflowId: string };
    assert.deepEqual(doc.sources.guide, { url: 'https://93.184.216.34/app', screenshots: true, roles: ['Clerk'], hosts: ['93.184.216.34', 'login.example.com'] });
    assert.doesNotMatch(JSON.stringify(r.body), /Clerk-Pw-1|S3cret/);
    const wf = one<Row>('SELECT goal FROM p6_workflows WHERE id = ?', workflowId);
    assert.match(String(wf!.goal), /written by using the running system at https:\/\/93\.184\.216\.34\/app/);
    assert.match(String(wf!.goal), /"Clerk"/);
    assert.doesNotMatch(String(wf!.goal), /Clerk-Pw-1|clerk@t\.example/);
    assert.deepEqual(await guideRunPayload(projectId, workflowId), { accounts: [{ role: 'Clerk', username: 'clerk@t.example', password: 'Clerk-Pw-1' }], hosts: ['93.184.216.34', 'login.example.com'], missing: [], manualSignIn: false });
  });

  it('refuses a missing or unusable address, an unknown account, a bad host', async () => {
    for (const bad of [
      { screenshots: true, url: '' },
      { screenshots: true, url: 'ftp://example.com' },
      { screenshots: true, url: 'http://localhost:3000/' },
      { screenshots: true, url: 'http://10.0.0.5/' },
      { screenshots: true, url: 'https://user:pw@example.com/' },
      { screenshots: true, url: 'https://93.184.216.34/', roles: ['Ghost'] },
      { screenshots: true, url: 'https://93.184.216.34/', hosts: ['not a host!'] },
    ]) {
      const r = await post({ guide: bad });
      assert.equal(r.status, 400, JSON.stringify(bad) + ' ' + JSON.stringify(r.body));
    }
  });

  it('ignores the options for other document types and when screenshots are off', async () => {
    const api = await post({ docType: 'api', guide: { screenshots: true, url: 'https://93.184.216.34/' } });
    assert.equal(api.status, 200);
    assert.equal((api.body as any).doc.sources.guide, undefined);
    const off = await post({ guide: { screenshots: false, url: 'https://93.184.216.34/' } });
    assert.equal(off.status, 200);
    assert.equal((off.body as any).doc.sources.guide, undefined);
    assert.equal(await guideRunPayload(projectId, (off.body as any).workflowId), null);
  });

  it('needs the cloud browser and a Kiro or Claude model', async () => {
    const was = process.env.PORTAL_AGENTCORE_BROWSER;
    try {
      delete process.env.PORTAL_AGENTCORE_BROWSER;
      await assert.rejects(parseGuide({ screenshots: true, url: 'https://93.184.216.34/' }, 'user-guide', projectId, 'kiro'), /not turned on/);
      process.env.PORTAL_AGENTCORE_BROWSER = '1';
      assert.ok(await parseGuide({ screenshots: true, url: 'https://93.184.216.34/' }, 'user-guide', projectId, 'kiro'));
      assert.ok(await parseGuide({ screenshots: true, url: 'https://93.184.216.34/' }, 'user-guide', projectId, 'claude-code'));
      await assert.rejects(parseGuide({ screenshots: true, url: 'https://93.184.216.34/' }, 'user-guide', projectId, 'codex'), /Kiro or Claude/);
    } finally {
      if (was === undefined) delete process.env.PORTAL_AGENTCORE_BROWSER; else process.env.PORTAL_AGENTCORE_BROWSER = was;
    }
  });

  it('builds the Word file with the screenshots, and the zip carries the Markdown, the pictures and the Word file', async () => {
    const r = await post({});
    const { doc, workflowId } = r.body as { doc: any; workflowId: string };
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-test-guide-'));
    try {
      fs.mkdirSync(path.join(workDir, 'screenshots'));
      fs.writeFileSync(path.join(workDir, 'screenshots', '01-login.png'), png(1280, 720));
      fs.writeFileSync(path.join(workDir, 'document.md'), '# Guide\n\n## Sign in\n\n1. Type your email (1).\n2. Click **Sign in** (2).\n\n![Sign in: 1 Email, 2 Sign in](screenshots/01-login.png)\n\n![Missing](screenshots/02-missing.png)\n');
      await processDocOutput(workflowId, 'run-1', workDir);

      const version = one<Row>('SELECT * FROM generated_doc_versions WHERE doc_id = ?', doc.id as string)!;
      const word = await JSZip.loadAsync(fs.readFileSync(String(version.docx_path)));
      assert.equal(Object.keys(word.files).filter((n) => n.startsWith('word/media/') && !n.endsWith('/')).length, 1, 'the one picture that exists');
      assert.match(String(version.warnings), /02-missing\.png/, 'the missing one is reported');

      const dl = await fetch(`${baseUrl}/api/projects/${projectId}/generated-docs/${doc.id}/download?format=zip`, { headers: { cookie, 'x-requested-with': 'agent-portal' } });
      assert.equal(dl.status, 200);
      assert.equal(dl.headers.get('content-type'), 'application/zip');
      const zip = await JSZip.loadAsync(Buffer.from(await dl.arrayBuffer()));
      assert.deepEqual(Object.keys(zip.files).sort(), ['document.docx', 'document.md', 'screenshots/01-login.png']);
      assert.match(await zip.file('document.md')!.async('string'), /!\[Sign in: 1 Email, 2 Sign in\]\(screenshots\/01-login\.png\)/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
