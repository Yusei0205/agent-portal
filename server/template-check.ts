/**
 * Checking an uploaded Word or PowerPoint template (D-13): a real Office Open XML zip, within 25 MB, the kind its
 * extension says, and no macros. Pure (no database, no files), so it can be tested and reused on its own.
 */
import path from 'node:path';
import { CT, OoxmlPackage, PackageError } from './ooxml.ts';
import { analyzeTemplate } from './pptx-template.ts';
import { analyzeWordTemplate } from './docx-template.ts';
import { TEMPLATE_MAX_BYTES } from './docgen.ts';

export type TemplateKind = 'docx' | 'pptx';
export type TemplateScope = 'project' | 'portal';

export const TEMPLATE_LIMITS = { bytes: TEMPLATE_MAX_BYTES, perProject: 20, portal: 50, nameChars: 80 };

export const KIND_OF_EXT: Record<string, TemplateKind> = { '.docx': 'docx', '.dotx': 'docx', '.pptx': 'pptx', '.potx': 'pptx' };
const MACRO_EXT = /\.(docm|dotm|pptm|potm|ppsm|ppam|xlsm|xltm|xlam|doc|dot|ppt|pot|pps|ppsx|xls)$/i;

export class TemplateError extends Error {}

export interface TemplateInfo {
  kind: TemplateKind;
  warnings: string[];
  /** PowerPoint only. */
  slideWidthIn?: number;
  slideHeightIn?: number;
  fonts?: { major: string; minor: string };
  colors?: Record<string, string>;
  layouts?: { name: string; type: string }[];
  /** Which of the template's layouts (PowerPoint) or styles (Word) plays each role (null when the template has none and a fallback is used). */
  mapping?: Record<string, string | null>;
  /** Word only. */
  pageWidthIn?: number;
  pageHeightIn?: number;
  header?: boolean;
  footer?: boolean;
}

/* ------------------------------------------------------------------ */
/* Checking an upload                                                  */
/* ------------------------------------------------------------------ */

export interface CheckedTemplate {
  kind: TemplateKind;
  ext: string;
  info: TemplateInfo;
}

/** Check an uploaded file and describe it. Throws TemplateError with a message fit for the person who uploaded it. */
export async function checkTemplateUpload(buf: Buffer, filename: string): Promise<CheckedTemplate> {
  const base = path.basename(String(filename || '')).trim();
  const ext = path.extname(base).toLowerCase();
  if (!base || !ext) throw new TemplateError('The file needs a name that ends in .docx, .dotx, .pptx or .potx');
  if (MACRO_EXT.test(base)) {
    throw new TemplateError(`${ext} files are not accepted: macro-enabled and old binary Office formats can run code. Save the template without macros as .docx or .dotx (Word) or .pptx or .potx (PowerPoint) and upload that.`);
  }
  const kind = KIND_OF_EXT[ext];
  if (!kind) throw new TemplateError('Only Word (.docx, .dotx) and PowerPoint (.pptx, .potx) templates can be uploaded');
  if (!buf.length) throw new TemplateError('The file is empty');
  if (buf.length > TEMPLATE_LIMITS.bytes) throw new TemplateError(`The file is larger than ${TEMPLATE_LIMITS.bytes / 1024 / 1024} MB`);
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) throw new TemplateError('The file is not a real Office file (it is not a zip archive)');

  try {
    const pkg = await OoxmlPackage.open(buf);
    const names = pkg.names();
    if (!pkg.has('[Content_Types].xml') || !pkg.has('_rels/.rels')) throw new TemplateError('The file is not an Office Open XML package ([Content_Types].xml is missing)');
    const ct = await pkg.contentTypes();
    const types = [...ct.defaults.values(), ...ct.overrides.values()];
    if (types.some((t) => /macroEnabled|vbaProject/i.test(t)) || names.some((n) => /(^|\/)(vbaProject\.bin|vbaData\.xml)$/i.test(n) || /(^|\/)activeX\//i.test(n) || /\/macrosheets\//i.test(n))) {
      throw new TemplateError('The template contains macros or ActiveX controls, which are not allowed. Remove them and save as a macro-free template.');
    }
    const main = await pkg.mainPart();
    const mainType = ct.overrides.get(main) ?? '';
    const warnings: string[] = [];
    if (kind === 'pptx') {
      if (mainType !== CT.pptxMain && mainType !== CT.potxMain) throw new TemplateError('The file is not a PowerPoint presentation or template');
      const a = await analyzeTemplate(pkg);
      const m = a.mapping;
      if (!m.title && !m.content && !m.titleOnly) throw new TemplateError('The template has no usable layouts. It needs at least a "Title and Content" or "Title Only" slide layout.');
      if (!m.title) warnings.push('No title-slide layout was found: title slides will use a content layout.');
      if (!m.content) warnings.push('No "Title and Content" layout was found: bullet slides will use another layout.');
      if (!m.titleOnly) warnings.push('No "Title Only" layout was found: tables and pictures will use the content layout.');
      return {
        kind,
        ext,
        info: {
          kind,
          warnings,
          slideWidthIn: Math.round((a.slideWidth / 914400) * 100) / 100,
          slideHeightIn: Math.round((a.slideHeight / 914400) * 100) / 100,
          fonts: a.fonts,
          colors: a.colors,
          layouts: a.layouts.map((l) => ({ name: l.name, type: l.type })),
          mapping: Object.fromEntries(Object.entries(m).map(([k, l]) => [k, l?.name ?? null])),
        },
      };
    }
    if (mainType !== CT.docxMain && mainType !== CT.dotxMain) throw new TemplateError('The file is not a Word document or template');
    if (!pkg.has(main)) throw new TemplateError('The Word file has no document part');
    await pkg.xml(main);
    if (!pkg.has('word/styles.xml')) warnings.push('The template has no styles part; generated documents will use Word defaults for headings.');
    const w = await analyzeWordTemplate(pkg);
    warnings.push(...w.warnings);
    return { kind, ext, info: { kind, warnings, pageWidthIn: w.pageWidthIn, pageHeightIn: w.pageHeightIn, fonts: w.fonts, mapping: w.mapping, header: w.header, footer: w.footer } };
  } catch (e) {
    if (e instanceof TemplateError) throw e;
    if (e instanceof PackageError) throw new TemplateError(e.message);
    throw new TemplateError(`The file could not be read as an Office file (${String((e as Error)?.message ?? e).slice(0, 120)})`);
  }
}

