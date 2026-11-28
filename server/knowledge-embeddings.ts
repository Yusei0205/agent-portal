/**
 * Knowledge: the portal's own meaning-based index.
 *
 * Each passage of a document is turned into a vector with a Bedrock embedding model (Cohere Embed Multilingual v3,
 * which also reads Malay, Chinese and other languages) when the document is indexed. A question is turned into a
 * vector the same way, and the closest passages win. Vectors are stored per document next to the document
 * (projects/<slug>/docs/vec/<docId>.json, mirrored to S3), so there is no extra database to run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { persistFile, restoreFile, forgetFile, existsDurable } from './durable-files.ts';
import { splitPassages, type Passage } from './knowledge-answer.ts';

export const EMBED_MODEL = 'cohere.embed-multilingual-v3';
const DIM = 1024;
/** Cohere accepts at most 96 texts per call. */
const BATCH = 96;
/** A document is indexed up to this many passages (about 400 pages of text), which bounds the cost of one document. */
const MAX_PASSAGES = 400;

interface StoredPassage { h: string; t: string; e: string }
interface StoredIndex { v: 1; model: string; dim: number; name: string; passages: StoredPassage[] }

export function vecPath(slug: string, docId: string): string {
  return path.join(config.dataDir, 'projects', slug, 'docs', 'vec', `${docId}.json`);
}

// ── Bedrock call ──────────────────────────────────────────────────────────────

let _invoke: ((texts: string[], inputType: string) => Promise<number[][]>) | null = null;
/** Replace the Bedrock call (tests). Pass null to restore. */
export function setEmbedOverride(fn: typeof _invoke): void { _invoke = fn; }

async function callBedrock(texts: string[], inputType: string): Promise<number[][]> {
  if (_invoke) return _invoke(texts, inputType);
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-southeast-1' });
  const res = await client.send(new InvokeModelCommand({
    modelId: EMBED_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ texts, input_type: inputType, truncate: 'END' }),
  }));
  const out = JSON.parse(new TextDecoder().decode(res.body)) as { embeddings?: number[][] | { float?: number[][] } };
  const list = Array.isArray(out.embeddings) ? out.embeddings : out.embeddings?.float;
  if (!list || list.length !== texts.length) throw new Error('The embedding model returned an unexpected answer.');
  return list;
}

function normalise(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Unit-length vectors for the texts (in batches). */
export async function embedTexts(texts: string[], inputType: 'search_document' | 'search_query'): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const part = await callBedrock(texts.slice(i, i + BATCH), inputType);
    for (const v of part) out.push(normalise(v));
  }
  return out;
}

const toB64 = (v: Float32Array): string => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
function fromB64(s: string): Float32Array {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

// ── Indexing ──────────────────────────────────────────────────────────────────

/** Embed a document's passages and store them. Returns how many passages were indexed. */
export async function indexDocument(slug: string, docId: string, name: string, markdown: string): Promise<number> {
  const passages = splitPassages(docId, name, markdown).slice(0, MAX_PASSAGES);
  const abs = vecPath(slug, docId);
  if (!passages.length) {
    await forgetEmbeddings(slug, docId);
    return 0;
  }
  // The heading goes in front so a short passage still carries its topic.
  const vectors = await embedTexts(passages.map((p) => (p.heading ? `${p.heading}\n${p.text}` : p.text)), 'search_document');
  const stored: StoredIndex = {
    v: 1, model: EMBED_MODEL, dim: DIM, name,
    passages: passages.map((p, i) => ({ h: p.heading, t: p.text, e: toB64(vectors[i]) })),
  };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(stored), 'utf8');
  await persistFile(abs, 'application/json');
  cache.delete(abs);
  return passages.length;
}

export async function forgetEmbeddings(slug: string, docId: string): Promise<void> {
  const abs = vecPath(slug, docId);
  cache.delete(abs);
  try { fs.rmSync(abs, { force: true }); } catch { /* none */ }
  await forgetFile(abs).catch(() => {});
}

// ── Searching ─────────────────────────────────────────────────────────────────

interface Loaded { passages: Array<Passage & { vec: Float32Array }>; mtime: number }
const cache = new Map<string, Loaded>();

async function load(slug: string, docId: string, fallbackName: string): Promise<Loaded | null> {
  const abs = vecPath(slug, docId);
  if (!(await restoreFile(abs))) return null;
  const mtime = fs.statSync(abs).mtimeMs;
  const hit = cache.get(abs);
  if (hit && hit.mtime === mtime) return hit;
  try {
    const s = JSON.parse(fs.readFileSync(abs, 'utf8')) as StoredIndex;
    if (s.model !== EMBED_MODEL) return null;
    const loaded: Loaded = {
      mtime,
      passages: s.passages.map((p) => ({ docId, docName: s.name || fallbackName, heading: p.h, text: p.t, vec: fromB64(p.e) })),
    };
    cache.set(abs, loaded);
    return loaded;
  } catch {
    return null;
  }
}

/** The passages closest in meaning to the question, best first, across the given documents. */
export async function searchEmbeddings(
  slug: string,
  docs: Array<{ docId: string; name: string }>,
  question: string,
  limit: number,
): Promise<Array<Passage & { score: number }>> {
  const [q] = await embedTexts([question], 'search_query');
  const scored: Array<Passage & { score: number }> = [];
  for (const d of docs) {
    const idx = await load(slug, d.docId, d.name);
    if (!idx) continue;
    for (const p of idx.passages) {
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * p.vec[i];
      scored.push({ docId: p.docId, docName: p.docName, heading: p.heading, text: p.text, score: dot });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** How many of the documents already have a stored index. */
export async function countIndexed(slug: string, docIds: string[]): Promise<number> {
  let n = 0;
  for (const id of docIds) {
    const abs = vecPath(slug, id);
    if (await existsDurable(abs).catch(() => false)) n++;
  }
  return n;
}
