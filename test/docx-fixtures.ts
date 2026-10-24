/** A small but structurally real Word template, built in memory for tests: A4, Georgia, a header with a logo and `{{title}}`, a footer with a page number, named styles. */
import JSZip from 'jszip';
import { PNG_1X1 } from './pptx-fixtures.ts';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const RELNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface WordTemplateOptions {
  /** Make a .dotx (template) rather than a .docx; the main content type differs. */
  dotx?: boolean;
  /** Leave out the Heading 3 style, the Title style and the table style, to test the fallbacks. */
  sparse?: boolean;
  /** Leave out the numbering part. */
  noNumbering?: boolean;
  /** Add a macro project, to test that it is refused. */
  macro?: boolean;
}

const pStyle = (id: string, name: string, body: string, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"${extra}><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>${body}</w:style>`;

export async function makeWordTemplate(o: WordTemplateOptions = {}): Promise<Buffer> {
  const z = new JSZip();
  const ct = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${o.dotx ? 'template' : 'document'}.main+xml"/>`,
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    ...(o.noNumbering ? [] : ['<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>']),
    '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>',
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    ...(o.macro ? ['<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>'] : []),
  ].join('');
  z.file('[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct}</Types>`);
  z.file('_rels/.rels', `${HEAD}<Relationships xmlns="${RELNS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`);
  z.file('docProps/core.xml', `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Template title</dc:title><dc:creator>Brand team</dc:creator></cp:coreProperties>`);
  z.file(
    'word/document.xml',
    `${HEAD}<w:document ${W}><w:body><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>SAMPLE COVER TEXT TO DROP</w:t></w:r></w:p>` +
      `<w:sectPr><w:headerReference w:type="default" r:id="rId10"/><w:footerReference w:type="default" r:id="rId11"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1134" w:bottom="1417" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  z.file(
    'word/_rels/document.xml.rels',
    `${HEAD}<Relationships xmlns="${RELNS}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
      (o.noNumbering ? '' : `<Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>`) +
      `<Relationship Id="rId10" Type="${R}/header" Target="header1.xml"/><Relationship Id="rId11" Type="${R}/footer" Target="footer1.xml"/></Relationships>`,
  );
  const styles =
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="160"/></w:pPr></w:style>` +
    (o.sparse ? '' : pStyle('Title', 'Title', '<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:b/><w:color w:val="C0392B"/><w:sz w:val="56"/></w:rPr>')) +
    pStyle('Heading1', 'heading 1', '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="C0392B"/><w:sz w:val="36"/></w:rPr>') +
    pStyle('Heading2', 'heading 2', '<w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="2980B9"/><w:sz w:val="28"/></w:rPr>') +
    (o.sparse ? '' : pStyle('Heading3', 'heading 3', '<w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr>')) +
    pStyle('ListBullet', 'List Bullet', '<w:pPr><w:numPr><w:numId w:val="1"/></w:numPr><w:contextualSpacing/></w:pPr>') +
    pStyle('ListNumber', 'List Number', '<w:pPr><w:contextualSpacing/></w:pPr>') +
    pStyle('Caption', 'caption', '<w:rPr><w:i/><w:color w:val="8E44AD"/></w:rPr>') +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="C0392B"/><w:u w:val="single"/></w:rPr></w:style>' +
    (o.sparse ? '' : '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="C0392B"/><w:bottom w:val="single" w:sz="4" w:color="C0392B"/><w:insideH w:val="single" w:sz="4" w:color="C0392B"/></w:tblBorders></w:tblPr></w:style>');
  z.file('word/styles.xml', `${HEAD}<w:styles ${W}>${styles}</w:styles>`);
  if (!o.noNumbering) {
    z.file(
      'word/numbering.xml',
      `${HEAD}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#9632;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
    );
  }
  z.file(
    'word/header1.xml',
    `${HEAD}<w:hdr ${W} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:p><w:r><w:t>ACME Corp | {{title}}</w:t></w:r>` +
      `<w:r><w:drawing><wp:inline><wp:extent cx="300000" cy="300000"/><wp:docPr id="77" name="Logo" descr="Brand logo"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="300000" cy="300000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:hdr>`,
  );
  z.file('word/_rels/header1.xml.rels', `${HEAD}<Relationships xmlns="${RELNS}"><Relationship Id="rId1" Type="${R}/image" Target="media/logo.png"/></Relationships>`);
  z.file('word/media/logo.png', PNG_1X1);
  z.file(
    'word/footer1.xml',
    `${HEAD}<w:ftr ${W}><w:p><w:r><w:t xml:space="preserve">Confidential - page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> | {{date}}</w:t></w:r></w:p></w:ftr>`,
  );
  if (o.macro) z.file('word/vbaProject.bin', 'not really a macro');
  return Buffer.from(await z.generateAsync({ type: 'uint8array' }));
}
