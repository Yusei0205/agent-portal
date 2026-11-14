/**
 * A zip attached to a session: unpacked for the agent (zips inside it too), every file kept, and nothing that leaves the folder,
 * is a link, is password protected or goes over the limits written.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { unpackInputZips, writeInputFilesAsync, listZipEntries, readZipEntry, zipEntryPath, ZIP_LIMITS, INPUT_FILE_EXTS } from '../server/agent/runner-files.ts';

async function zipOf(files: Record<string, string | Buffer>, opts: { store?: boolean } = {}): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, data] of Object.entries(files)) z.file(name, data, { createFolders: false });
  return z.generateAsync({ type: 'nodebuffer', compression: opts.store ? 'STORE' : 'DEFLATE' });
}

describe('zip attachments', () => {
  let dir: string;
  const saved = { ...ZIP_LIMITS };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-att-')); fs.mkdirSync(path.join(dir, 'attachments')); });
  afterEach(() => { Object.assign(ZIP_LIMITS, saved); fs.rmSync(dir, { recursive: true, force: true }); });
  const put = (name: string, data: Buffer): void => fs.writeFileSync(path.join(dir, 'attachments', name), data);
  const read = (...p: string[]): string => fs.readFileSync(path.join(dir, 'attachments', ...p), 'utf8');
  const exists = (...p: string[]): boolean => fs.existsSync(path.join(dir, 'attachments', ...p));

  it('is an input file type', () => { assert.ok(INPUT_FILE_EXTS.has('.zip')); });

  it('unpacks a zip of zips: every file kept (the PDF too), listed in _unpacked.txt, the zip removed', async () => {
    const inner = async (n: number): Promise<Buffer> => zipOf({
      'open_findings.csv': `key,severity\nA${n},HIGH\n`, 'quality_gate.csv': 'status\nOK\n', 'report.pdf': Buffer.from('%PDF-1.4 fake'),
    });
    put('abc123.zip', await zipOf({ 'PO4 - FlashRouter - main - regulatory report.zip': await inner(1), 'PO4 - BaseLayer - main - regulatory report.zip': await inner(2) }, { store: true }));
    const emitted: string[] = [];
    assert.equal(unpackInputZips(dir, (e) => emitted.push(e.text)), 1);
    assert.equal(read('abc123', 'PO4 - FlashRouter - main - regulatory report', 'open_findings.csv'), 'key,severity\nA1,HIGH\n');
    assert.equal(read('abc123', 'PO4 - BaseLayer - main - regulatory report', 'open_findings.csv'), 'key,severity\nA2,HIGH\n');
    assert.ok(exists('abc123', 'PO4 - BaseLayer - main - regulatory report', 'report.pdf'), 'the PDF is kept');
    assert.equal(exists('abc123.zip'), false);
    const index = read('abc123', '_unpacked.txt');
    assert.match(index, /6 files/);
    assert.match(index, /PO4 - FlashRouter - main - regulatory report\/report\.pdf/);
    assert.doesNotMatch(index, /NOT unpacked/);
    assert.match(emitted.join('\n'), /Unpacked attachments\/abc123\/: 6 files/);
  });

  it('is done by writeInputFilesAsync, the way every runner receives its files', async () => {
    const data = (await zipOf({ 'a/b.txt': 'hello' })).toString('base64');
    const n = await writeInputFilesAsync(dir, [{ path: 'attachments/x1.zip', data }]);
    assert.equal(n, 1);
    assert.equal(read('x1', 'a', 'b.txt'), 'hello');
    assert.equal(exists('x1.zip'), false);
  });

  it('does not unpack twice: a folder already unpacked only has its zip removed', async () => {
    put('abc.zip', await zipOf({ 'one.txt': '1' }));
    unpackInputZips(dir);
    fs.writeFileSync(path.join(dir, 'attachments', 'abc', 'one.txt'), 'edited');
    put('abc.zip', await zipOf({ 'one.txt': '1' }));
    assert.equal(unpackInputZips(dir), 0);
    assert.equal(read('abc', 'one.txt'), 'edited');
    assert.equal(exists('abc.zip'), false);
  });

  it('refuses paths that leave the folder, links and password protected entries, and says so', async () => {
    const z = new JSZip();
    z.file('ok.txt', 'fine');
    z.file('../escape.txt', 'no');
    z.file('/abs.txt', 'x');
    z.file('sub/../../up.txt', 'no');
    z.file('link', '/etc/passwd', { unixPermissions: 0o120777 });
    z.file('__MACOSX/._ok.txt', 'junk');
    put('evil.zip', await z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
    unpackInputZips(dir);
    assert.equal(read('evil', 'ok.txt'), 'fine');
    assert.equal(fs.existsSync(path.join(dir, 'escape.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, 'attachments', 'escape.txt')), false);
    assert.equal(exists('evil', 'link'), false);
    assert.equal(exists('evil', '__MACOSX'), false);
    const index = read('evil', '_unpacked.txt');
    assert.match(index, /\.\.\/escape\.txt: its path is not allowed/);
    assert.match(index, /link: it is a link/);
  });

  it('stops an entry over the size limit, and a zip that claims less than it holds', async () => {
    ZIP_LIMITS.fileBytes = 1000;
    put('big.zip', await zipOf({ 'small.txt': 'ok', 'big.txt': 'x'.repeat(5000) }));
    unpackInputZips(dir);
    assert.equal(read('big', 'small.txt'), 'ok');
    assert.equal(exists('big', 'big.txt'), false);
    assert.match(read('big', '_unpacked.txt'), /big\.txt: it is too large/);

    Object.assign(ZIP_LIMITS, saved);
    // The entry says 10 bytes but holds 100000: the unpacker must not write what it was not told about.
    const liar = await zipOf({ 'liar.txt': 'y'.repeat(100000) });
    const entry = listZipEntries(liar)[0];
    const cd = liar.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    liar.writeUInt32LE(10, cd + 24);
    put('liar.zip', liar);
    unpackInputZips(dir);
    assert.equal(exists('liar', 'liar.txt'), false);
    assert.match(read('liar', '_unpacked.txt'), /liar\.txt: it is (too large|damaged)/);
    assert.throws(() => readZipEntry(liar, { ...entry, usize: 10 }, 50), /too large|damaged/);
  });

  it('stops at the file count and keeps a zip nested deeper than the limit as a file', async () => {
    ZIP_LIMITS.files = 3;
    put('many.zip', await zipOf({ '1.txt': 'a', '2.txt': 'b', '3.txt': 'c', '4.txt': 'd', '5.txt': 'e' }));
    unpackInputZips(dir);
    assert.match(read('many', '_unpacked.txt'), /3 files/);
    assert.match(read('many', '_unpacked.txt'), /more than 3 files/);

    Object.assign(ZIP_LIMITS, saved);
    ZIP_LIMITS.depth = 2;
    const deep = await zipOf({ 'in.zip': await zipOf({ 'deeper.zip': await zipOf({ 'x.txt': 'x' }), 'y.txt': 'y' }) });
    put('deep.zip', deep);
    unpackInputZips(dir);
    assert.equal(read('deep', 'in', 'y.txt'), 'y');
    assert.ok(exists('deep', 'in', 'deeper.zip'), 'a zip below the depth limit stays a file');
  });

  it('leaves a zip that cannot be read where it is and says so', () => {
    put('broken.zip', Buffer.from('this is not a zip file at all'));
    const emitted: string[] = [];
    assert.equal(unpackInputZips(dir, (e) => emitted.push(e.text)), 0);
    assert.ok(exists('broken.zip'));
    assert.match(emitted.join('\n'), /broken\.zip could not be unpacked: it is not a readable zip file/);
  });

  it('does not touch .docx, .xlsx or .pptx (they are zips inside, but they are documents)', async () => {
    put('doc.docx', await zipOf({ 'word/document.xml': '<w/>' }));
    assert.equal(unpackInputZips(dir), 0);
    assert.ok(exists('doc.docx'));
  });

  it('names entries safely', () => {
    assert.deepEqual(zipEntryPath('a\\b/c.txt'), ['a', 'b', 'c.txt']);
    assert.deepEqual(zipEntryPath('./a//b.csv'), ['a', 'b.csv']);
    assert.equal(zipEntryPath('../x'), null);
    assert.equal(zipEntryPath('a/../../x'), null);
    assert.equal(zipEntryPath(''), null);
    assert.deepEqual(zipEntryPath('we:ird?.txt'), ['we_ird_.txt']);
  });
});
