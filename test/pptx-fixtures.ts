/** A small but structurally real PowerPoint template, built in memory for tests: 4:3 slides, Georgia/Verdana, a logo on the master. */
import JSZip from 'jszip';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const TREE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** A 1x1 PNG. */
export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const ph = (id: number, name: string, phXml: string, box: [number, number, number, number], text = 'Click to edit') =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${phXml}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

const layout = (type: string, name: string, shapes: string) =>
  `${HEAD}<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${TREE}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const THEME = `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture"><a:themeElements><a:clrScheme name="Fixture"><a:dk1><a:srgbClr val="112233"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="334455"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="C0392B"/></a:accent1><a:accent2><a:srgbClr val="2980B9"/></a:accent2><a:accent3><a:srgbClr val="27AE60"/></a:accent3><a:accent4><a:srgbClr val="F39C12"/></a:accent4><a:accent5><a:srgbClr val="8E44AD"/></a:accent5><a:accent6><a:srgbClr val="16A085"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Fixture"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

export interface TemplateOptions {
  /** Which layouts to include; default all four. */
  layouts?: ('title' | 'obj' | 'titleOnly' | 'secHead')[];
  /** Add a macro project, to test that it is refused. */
  macro?: boolean;
  /** Make a .potx (template) rather than a .pptx; the main content type differs. */
  potx?: boolean;
}

export async function makeTemplate(o: TemplateOptions = {}): Promise<Buffer> {
  const want = o.layouts ?? ['title', 'obj', 'titleOnly', 'secHead'];
  const defs: Record<string, string> = {
    title: layout('title', 'Title Slide', ph(2, 'Title', '<p:ph type="ctrTitle"/>', [685800, 2130425, 7772400, 1470025]) + ph(3, 'Subtitle', '<p:ph type="subTitle" idx="1"/>', [1371600, 3886200, 6400800, 1752600])),
    obj: layout(
      'obj',
      'Title and Content',
      ph(2, 'Title', '<p:ph type="title"/>', [457200, 274638, 8229600, 1143000]) +
        ph(3, 'Content', '<p:ph idx="1"/>', [457200, 1600200, 8229600, 4525963]) +
        ph(4, 'Slide Number', '<p:ph type="sldNum" sz="quarter" idx="12"/>', [6553200, 6356350, 2133600, 365125], '‹#›'),
    ),
    titleOnly: layout('titleOnly', 'Title Only', ph(2, 'Title', '<p:ph type="title"/>', [457200, 274638, 8229600, 1143000])),
    secHead: layout('secHead', 'Section Header', ph(2, 'Title', '<p:ph type="title"/>', [722313, 4406900, 7772400, 1362075]) + ph(3, 'Text', '<p:ph type="body" idx="1"/>', [722313, 2906713, 7772400, 1500187])),
  };
  const files: Record<string, string | Buffer> = {};
  const ids = want.map((_, i) => i + 1);
  const ct = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${o.potx ? 'template' : 'presentation'}.main+xml"/>`,
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    ...want.map((_, i) => `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`),
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    ...(o.macro ? ['<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>'] : []),
  ].join('');
  files['[Content_Types].xml'] = `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${ct}</Types>`;
  files['_rels/.rels'] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>`;
  files['docProps/core.xml'] = `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Fixture template</dc:title><dc:creator>Brand team</dc:creator></cp:coreProperties>`;
  files['docProps/thumbnail.jpeg'] = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  files['ppt/presentation.xml'] = `${HEAD}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  files['ppt/_rels/presentation.xml.rels'] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`;
  files['ppt/theme/theme1.xml'] = THEME;
  files['ppt/media/logo.png'] = PNG_1X1;
  files['ppt/media/sample-only.png'] = PNG_1X1;
  files['ppt/slideMasters/slideMaster1.xml'] =
    `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${TREE}` +
    ph(2, 'Title Placeholder', '<p:ph type="title"/>', [457200, 274638, 8229600, 1143000]) +
    ph(3, 'Text Placeholder', '<p:ph type="body" idx="1"/>', [457200, 1600200, 8229600, 4525963]) +
    `<p:pic><p:nvPicPr><p:cNvPr id="9" name="Logo" descr="Brand logo"/><p:cNvPicPr/><p:nvPr userDrawn="1"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId20"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="8000000" y="100000"/><a:ext cx="800000" cy="400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>` +
    `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${ids.map((i) => `<p:sldLayoutId id="${2147483648 + i}" r:id="rId${i}"/>`).join('')}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="3200"><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="2400"><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
  files['ppt/slideMasters/_rels/slideMaster1.xml.rels'] =
    `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${ids.map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${i}.xml"/>`).join('')}<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/><Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/logo.png"/></Relationships>`;
  want.forEach((k, i) => {
    files[`ppt/slideLayouts/slideLayout${i + 1}.xml`] = defs[k];
    files[`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  });
  files['ppt/slides/slide1.xml'] = `${HEAD}<p:sld ${NS}><p:cSld><p:spTree>${TREE}${ph(2, 'Title', '<p:ph type="title"/>', [457200, 274638, 8229600, 1143000], 'SAMPLE SLIDE TO DROP')}<p:pic><p:nvPicPr><p:cNvPr id="5" name="Pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr/></p:pic></p:spTree></p:cSld></p:sld>`;
  files['ppt/slides/_rels/slide1.xml.rels'] = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${want.indexOf('obj') + 1 || 1}.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/sample-only.png"/></Relationships>`;
  if (o.macro) files['ppt/vbaProject.bin'] = Buffer.from('not really a macro');
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}
