/**
 * docs-pack: optional heavy document libraries (pdfjs-dist, docx, exceljs, pptxgenjs).
 *
 * These packages are large (~42 MB combined in node_modules) and only needed for:
 *   - Uploading PDF files            (pdfjs-dist, convert.ts)
 *   - Generating Word documents      (docx, docgen.ts)
 *   - Generating Excel spreadsheets  (exceljs, docgen.ts)
 *   - Generating PowerPoint decks    (pptxgenjs, docgen.ts)
 *
 * When the docs pack is installed they are loaded lazily on first use. When not
 * installed a CapabilityError is thrown with a hint pointing the admin to Settings › Tools.
 *
 * Detection strategy: try to resolve each package via createRequire(import.meta.url).resolve().
 * If it throws the package is not installed. Results are cached for the process lifetime.
 *
 * The pack is "available" when all four packages are resolvable. Partial availability
 * (e.g. only docx installed manually) is reported as individual part states.
 */
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

export const DOCS_PACK_ID = 'docs';
export const DOCS_PACK_HINT = 'An admin can install the Documents pack under Settings › Tools';

export class CapabilityError extends Error {
  readonly packId: string;
  readonly hint: string;
  constructor(message: string, packId = DOCS_PACK_ID, hint = DOCS_PACK_HINT) {
    super(message);
    this.name = 'CapabilityError';
    this.packId = packId;
    this.hint = hint;
  }
}

/* ------------------------------------------------------------------ */
/* Package availability check (cached for process lifetime)           */
/* ------------------------------------------------------------------ */

interface PackPart {
  id: string;
  label: string;
  available: boolean;
  reason: string;
}

export interface DocsPackState {
  available: boolean;
  reason: string;
  parts: PackPart[];
}

let _cache: DocsPackState | null = null;

function tryResolve(pkg: string): boolean {
  try {
    _require.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

function checkPart(pkg: string, label: string): PackPart {
  const available = tryResolve(pkg);
  return { id: pkg, label, available, reason: available ? `${pkg} found` : `${pkg} not installed` };
}

export function docsPackState(): DocsPackState {
  if (_cache) return _cache;
  const parts: PackPart[] = [
    checkPart('pdfjs-dist', 'PDF conversion (pdfjs-dist)'),
    checkPart('docx', 'Word generation (docx)'),
    checkPart('exceljs', 'Excel generation (exceljs)'),
    checkPart('pptxgenjs', 'PowerPoint generation (pptxgenjs)'),
  ];
  const all = parts.every((p) => p.available);
  const some = parts.some((p) => p.available);
  const missing = parts.filter((p) => !p.available).map((p) => p.id);
  _cache = {
    available: all,
    reason: all
      ? 'All document packages are installed'
      : some
        ? `Some document packages are missing: ${missing.join(', ')}`
        : 'Document packages are not installed — install the Documents pack under Settings › Tools',
    parts,
  };
  return _cache;
}

/** Clear the detection cache (called after installing or removing the pack). */
export function clearDocsPackCache(): void {
  _cache = null;
}

/* ------------------------------------------------------------------ */
/* Per-feature capability guards                                       */
/* ------------------------------------------------------------------ */

export function requirePdfCapability(): void {
  if (!tryResolve('pdfjs-dist')) {
    throw new CapabilityError(
      'Uploading PDF files needs the Documents pack. An admin can install it under Settings › Tools.',
    );
  }
}

export function requireDocxCapability(): void {
  if (!tryResolve('docx')) {
    throw new CapabilityError(
      'Generating Word documents needs the Documents pack. An admin can install it under Settings › Tools.',
    );
  }
}

export function requireExcelCapability(): void {
  if (!tryResolve('exceljs')) {
    throw new CapabilityError(
      'Generating Excel spreadsheets needs the Documents pack. An admin can install it under Settings › Tools.',
    );
  }
}

export function requirePptxCapability(): void {
  if (!tryResolve('pptxgenjs')) {
    throw new CapabilityError(
      'Generating PowerPoint presentations needs the Documents pack. An admin can install it under Settings › Tools.',
    );
  }
}

/* ------------------------------------------------------------------ */
/* Lazy loaders — only called after the matching require* guard passes */
/* ------------------------------------------------------------------ */

export async function loadPdfJs(): Promise<any> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

export async function loadDocx(): Promise<typeof import('docx')> {
  return import('docx');
}

export async function loadExcelJs(): Promise<any> {
  return import('exceljs');
}

export async function loadPptxGen(): Promise<any> {
  return import('pptxgenjs');
}
