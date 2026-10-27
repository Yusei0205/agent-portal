/**
 * Document generation helpers for P9.
 *
 * Provides TEMPLATE_MAX_BYTES, TEMPLATE_DIR, TEMPLATE_DEFAULTS constants
 * and buildDocx / buildXlsx / buildPptx helpers used by the document/presentation APIs.
 *
 * The full agent make-doc CLI integration (docgen-cli.ts) uses the complete docgen
 * pipeline from the reference branch. This file provides what the API layer needs.
 */
import { requireDocxCapability, requireExcelCapability, requirePptxCapability } from './docs-pack.ts';

export const TEMPLATE_DIR = '.portal/templates';
export const TEMPLATE_DEFAULTS = `${TEMPLATE_DIR}/defaults.json`;
export const TEMPLATE_MAX_BYTES = 25 * 1024 * 1024;

export class DocError extends Error {}

/** Slide data for buildPptx. */
export interface SlideData {
  layout?: 'title' | 'bullets' | 'text' | 'table' | 'section' | 'image';
  title?: string;
  subtitle?: string;
  bullets?: string[];
  text?: string;
  table?: { header?: string[]; rows: string[][] };
  notes?: string;
}

/**
 * Build a .docx from markdown content, optionally using a Word template.
 * Requires the docx package.
 */
export async function buildDocx(content: string, templatePath?: string): Promise<Buffer> {
  requireDocxCapability();
  try {
    const { Document, Paragraph, TextRun, HeadingLevel, Packer } = await import('docx');
    // Simple paragraph-per-line rendering for basic usage
    const lines = content.split('\n');
    const children: InstanceType<typeof Paragraph>[] = [];
    for (const line of lines) {
      if (line.startsWith('# ')) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(line.slice(2))] }));
      } else if (line.startsWith('## ')) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(line.slice(3))] }));
      } else if (line.startsWith('### ')) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(line.slice(4))] }));
      } else {
        children.push(new Paragraph({ children: [new TextRun(line)] }));
      }
    }
    const doc = new Document({ sections: [{ children }] });
    const buf = await Packer.toBuffer(doc);
    if (templatePath) {
      // Template application via docx-template.ts
      const { openWordTemplate } = await import('./docx-template.ts');
      const fs = await import('node:fs');
      const tplBuf = fs.readFileSync(templatePath);
      const tpl = await openWordTemplate(tplBuf);
      const result = await tpl.apply(buf, {});
      return result.buffer;
    }
    return buf;
  } catch (e: any) {
    if (e instanceof DocError) throw e;
    throw new DocError(`Failed to build Word document: ${String(e?.message ?? e)}`);
  }
}

/**
 * Build an .xlsx spreadsheet from row data.
 * Requires the exceljs package.
 */
export async function buildXlsx(data: unknown[][]): Promise<Buffer> {
  requireExcelCapability();
  try {
    const ExcelJS = await import('exceljs');
    const wb = new ExcelJS.default.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    for (const row of data) {
      ws.addRow(row as (string | number | boolean | null)[]);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  } catch (e: any) {
    throw new DocError(`Failed to build Excel file: ${String(e?.message ?? e)}`);
  }
}

/**
 * Build a .pptx from slide data, optionally using a PowerPoint template.
 * Requires the pptxgenjs package.
 */
export async function buildPptx(slides: SlideData[], templatePath?: string): Promise<Buffer> {
  requirePptxCapability();
  try {
    if (templatePath) {
      const { buildFromTemplate } = await import('./pptx-template.ts');
      const fs = await import('node:fs');
      const tplBuf = fs.readFileSync(templatePath);
      const result = await buildFromTemplate(tplBuf, slides as any);
      return result.buffer;
    }
    const PptxGenJS = await import('pptxgenjs');
    const Pptx: any = (PptxGenJS as any).default ?? PptxGenJS;
    const pptx: any = new Pptx();
    pptx.layout = 'LAYOUT_WIDE';
    for (const s of slides) {
      const slide = pptx.addSlide();
      if (s.title) {
        slide.addText(s.title, { x: 0.5, y: 0.3, w: 12, h: 1, fontSize: 28, bold: true });
      }
      if (s.bullets?.length) {
        slide.addText(
          s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
          { x: 0.5, y: 1.5, w: 12, h: 5, fontSize: 18 },
        );
      } else if (s.text) {
        slide.addText(s.text, { x: 0.5, y: 1.5, w: 12, h: 5, fontSize: 18 });
      }
      if (s.notes) slide.addNotes(s.notes);
    }
    return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  } catch (e: any) {
    if (e instanceof DocError) throw e;
    throw new DocError(`Failed to build PowerPoint: ${String(e?.message ?? e)}`);
  }
}
