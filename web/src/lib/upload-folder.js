/**
 * Uploading folders into a session's uploads (IdeExplorer.jsx). Pure helpers, plus readDroppedItems for drag and drop.
 * Each file is sent to POST /api/workflows/:id/ide/upload?dir=<its folder>, so the folder's structure is kept.
 */

/** Folders that are never uploaded (the explorer hides them too): dependencies, version control, caches. */
export const SKIP_FOLDERS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.cache']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
export const MAX_FOLDER_FILES = 1000;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The folder part of a relative path ('a/b/c.txt' → 'a/b', 'c.txt' → ''). */
export function dirOf(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/**
 * Which files to send, from [{ file, relPath }]: skips dependency and version-control folders and system files, files over 50 MB,
 * and anything past the first 1,000 files. Returns { items: [{ file, dir }], skipped, tooBig: [names], overLimit }.
 */
export function planFolderUpload(entries) {
  const items = [];
  const tooBig = [];
  let skipped = 0;
  let overLimit = 0;
  for (const e of entries ?? []) {
    const rel = String(e?.relPath || e?.file?.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = rel.split('/');
    const name = parts[parts.length - 1];
    if (!e?.file || parts.slice(0, -1).some((p) => SKIP_FOLDERS.has(p)) || SKIP_FILES.has(name)) { skipped++; continue; }
    if ((e.file.size ?? 0) > MAX_FILE_BYTES) { tooBig.push(rel); continue; }
    if (items.length >= MAX_FOLDER_FILES) { overLimit++; continue; }
    items.push({ file: e.file, dir: dirOf(rel) });
  }
  return { items, skipped, tooBig, overLimit };
}

/** A short sentence about what was left out, or '' when nothing was. */
export function skippedNote({ skipped, tooBig, overLimit }) {
  const parts = [];
  if (skipped) parts.push(`${skipped} file${skipped === 1 ? '' : 's'} in dependency, version-control or system folders`);
  if (tooBig?.length) parts.push(`${tooBig.length} over 50 MB (${tooBig.slice(0, 3).join(', ')}${tooBig.length > 3 ? ', …' : ''})`);
  if (overLimit) parts.push(`${overLimit} past the first ${MAX_FOLDER_FILES} files`);
  return parts.length ? `Not uploaded: ${parts.join('; ')}.` : '';
}

/** Run `task` over `list` with at most `limit` at a time; `onDone(doneCount)` after each. Resolves to the errors (strings). */
export async function runLimited(list, limit, task, onDone) {
  const errors = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < list.length) {
      const item = list[next++];
      try { await task(item); } catch (e) { errors.push(e?.message || String(e)); }
      done++;
      onDone?.(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return errors;
}

/**
 * Files from a drop, with their paths inside any dropped folders ([{ file, relPath }]). Uses the browser's entry API so dropped
 * folders are walked; plain files keep their name. Browser only.
 */
export async function readDroppedItems(dataTransfer) {
  const items = Array.from(dataTransfer?.items ?? []);
  const entries = items.map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null));
  if (!entries.some((e) => e?.isDirectory)) {
    return Array.from(dataTransfer?.files ?? []).map((file) => ({ file, relPath: file.name }));
  }
  const out = [];
  const readAll = (reader) => new Promise((resolve, reject) => {
    const all = [];
    const step = () => reader.readEntries((batch) => { if (!batch.length) resolve(all); else { all.push(...batch); step(); } }, reject);
    step();
  });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, relPath: prefix + entry.name });
    } else if (entry.isDirectory) {
      if (SKIP_FOLDERS.has(entry.name)) { out.push({ file: null, relPath: `${prefix}${entry.name}/` }); return; }
      for (const child of await readAll(entry.createReader())) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const e of entries) if (e) await walk(e, '');
  return out;
}
