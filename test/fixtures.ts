import JSZip from 'jszip';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const FSD_MD = `# Refunds FSD

## Overview

The Refund Service lets Customer Support return money to a customer after a failed delivery.
A refund always goes back to the original Payment Method. Partial refunds are allowed.

## Refund rules

A refund must be requested within 30 days of the original payment.
The refund amount cannot exceed the captured amount of the Payment Method.
Refunds above 500 USD need approval from a Finance Manager before they are sent.
Each refund gets a Refund Reference that support staff can quote to the customer.

## API

The Refund Service exposes POST /v1/refunds to create a refund and GET /v1/refunds/{id} to read its status.
A refund moves through the statuses \`requested\`, \`approved\`, \`sent\` and \`failed\`.
The Payment Gateway sends a webhook to POST /v1/refunds/webhook when the bank confirms the refund.

## Notifications

The customer receives an email when the Refund Reference is created and again when the refund is sent.
Customer Support can see every refund for a customer on the Refund History screen.
`;

export const FSD_MD_V2 = FSD_MD.replace('within 30 days', 'within 45 days');

export async function makeDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0"?><w:styles xmlns:w="w"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
  );
  const p = (text: string, style?: string) =>
    `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const bullet = (text: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const cell = (text: string) => `<w:tc><w:tcPr/>${p(text)}</w:tc>`;
  const body = [
    p('Refunds TSD', 'Heading1'),
    p('The refund-service is a Spring Boot application that stores refunds in the refunds table.'),
    p('Components', 'Heading2'),
    bullet('RefundController handles POST /v1/refunds &amp; GET /v1/refunds/{id}.'),
    bullet('RefundRepository writes to PostgreSQL.'),
    `<w:tbl><w:tr>${cell('Field')}${cell('Type')}</w:tr><w:tr>${cell('amount')}${cell('decimal(12,2)')}</w:tr></w:tbl>`,
    p('Error handling', 'Heading2'),
    p('Calls to the Payment Gateway time out after 10 seconds and are retried three times.'),
  ].join('');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Limits" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/sharedStrings.xml', '<sst><si><t>Rule</t></si><si><t>Limit</t></si><si><t>Max refund without approval</t></si></sst>');
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>500</v></c></row></sheetData></worksheet>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

export async function makePdf(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const lines = ['1 Meeting notes', 'The team agreed that refunds are processed every hour by a batch job.', '2 Action items', 'QA will test the Finance Manager approval flow.'];
  lines.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 24, size: 12, font }));
  return Buffer.from(await doc.save());
}

/** A local git repository with a main branch and a feature branch that adds risky code. */
export function makeRepo(root: string): string {
  const work = path.join(root, 'repo-src');
  const bare = path.join(root, 'repo.git');
  fs.mkdirSync(work, { recursive: true });
  const g = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: work,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'src', 'refunds.ts'), 'export function refund(amount: number) {\n  return amount;\n}\n');
  fs.writeFileSync(path.join(work, 'README.md'), '# Refund service\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'feature/refund-api');
  fs.writeFileSync(
    path.join(work, 'src', 'api.ts'),
    [
      "const apiKey = 'sk_live_1234567890abcdef';",
      'export async function find(db: any, id: string) {',
      "  console.log('finding', id);",
      '  return db.query("SELECT * FROM refunds WHERE id = \'" + id);',
      '}',
      'export function parse(s: string) {',
      '  try { return JSON.parse(s); } catch (e) {}',
      '}',
      '// TODO: add retries',
      ...Array.from({ length: 10 }, (_, i) => `export const limit${i} = ${i * 100};`),
    ].join('\n') + '\n',
  );
  g('add', '-A');
  g('commit', '-q', '-m', 'Add refund API');
  g('checkout', '-q', 'main');
  execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  return bare;
}
