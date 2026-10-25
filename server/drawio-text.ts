/**
 * Icon diagrams (draw.io, FR-DIAG-9), the text side: what the agent is asked and told, and how its reply is read.
 * Nothing here touches the database or the file system.
 *
 * The agent has two read-only lookup tools from the draw.io MCP server (search_shapes, get_drawio_reference) and its
 * normal file tools. It writes the diagram as a plain `diagram.drawio` file in its run folder; the portal checks and
 * stores that file (drawio.ts) and reads the reply for the description and the cited source files.
 */
import { CLOUD_LABELS, DRAWIO_LIMITS, READABLE_ICONS, type Cloud } from './drawio.ts';
import { DIAGRAM_LIMITS, type DiagramKind } from './diagram-text.ts';

export const DRAWIO_FILE = 'diagram.drawio';

const ICON_KIND_GUIDE: Record<DiagramKind, string> = {
  system_context:
    'A system context diagram: the system as one group box in the middle, the people and clients who use it on the left, and the external systems, managed services, data stores and queues it talks to, with the direction and purpose of each connection.',
  components:
    'A component diagram: the main building blocks inside the system (functions, services, containers, APIs, jobs, data stores) as icons, grouped by account, region, network or namespace boundary, and the calls between them.',
  data_flow:
    'A data flow diagram: how the main requests or records move through the system from entry point to storage and out again, as numbered steps along labelled arrows.',
};

/** Where each cloud draws its boundaries: the names to search for. */
const GROUP_HINTS: Record<Cloud, string> = {
  aws: 'search "aws cloud", "aws account", "region", "vpc", "private subnet", "public subnet", "availability zone", "auto scaling group" for the group boxes (shape=mxgraph.aws4.group with a grIcon), and "user", "client", "internet" for the people and devices',
  azure: 'search "azure subscription", "resource group", "virtual network", "subnet" for the boundary boxes (plain dashed rectangles labelled with the boundary name are fine when no group shape exists), and "user" for the people',
  gcp: 'search "gcp project", "region", "zone", "vpc network", "subnet" for the boundary boxes (the gcp group shapes), and "user" for the people',
  kubernetes: 'search "kubernetes cluster", "namespace", "node" for the boundary boxes, and "pod", "deployment", "service", "ingress", "config map", "secret", "persistent volume" for the objects',
  generic: 'use plain rounded group rectangles labelled with the boundary (environment, network, trust zone); search "user", "database", "server", "cloud", "queue" for generic icons',
};

/** The rules for drawing one icon diagram, as lines the prompts of diagrams, documents and decks share. */
export function iconDrawingRules(cloud: Cloud, file = DRAWIO_FILE): string[] {
  const label = CLOUD_LABELS[cloud];
  return [
    `Read the infrastructure code first (CDK, SAM and CloudFormation templates, Terraform, Serverless, Bicep or ARM, Helm, Kustomize and Kubernetes manifests, compose files) and the README. Every icon and arrow must come from something you read; name the real resources (function, table and queue names) in the labels.`,
    `Look shapes up with the draw.io tool search_shapes (for example "${cloud === 'kubernetes' ? 'kubernetes pod' : cloud === 'azure' ? 'azure functions' : cloud === 'gcp' ? 'gcp cloud run' : cloud === 'generic' ? 'database' : 'aws lambda'}") and use the style string it returns exactly as it is; never guess a shape or write a style string from memory. Prefer the current libraries (aws4 resource icons, azure2 icons, gcp2/gcp3, kubernetes icon2) over legacy ones (aws3, azure). If nothing fits, use a rounded rectangle with a label. get_drawio_reference with format "xml" explains containers, edges and layers; read it once if you need it. The other draw.io tools are not available in this session.`,
    `Boundaries: ${GROUP_HINTS[cloud]}. Make each boundary a container and put the icons inside it (set the icon's parent to the container's id and give its coordinates relative to the container), so the box and its contents belong together. Nest ${label} boundaries the way the real ones nest.`,
    'Layout: left to right. People and clients first, then entry points (CDN, gateway, load balancer), then compute, then data stores and external services. Icons about 60 to 78 pixels, on a 10 pixel grid, at least 50 pixels apart, icon labels below the icon. Use orthogonal edges (edgeStyle=orthogonalEdgeStyle) with an arrowhead, and label every edge with what it does ("HTTPS", "invoke", "reads orders"). Avoid crossing lines.',
    'Numbered steps: when the diagram shows a flow, put a small numbered badge (an ellipse of about 24 by 24 pixels, dark fill, white bold number) on each step in order, and add a legend (a text box at the bottom or right listing "1  What happens first", "2  ..."). Icon and group labels stay short (about 60 characters); a legend text box may hold up to 2000 characters, so split a longer legend into two or three text boxes.',
    `Size: at most about ${READABLE_ICONS} icons per diagram (the portal refuses more than ${DRAWIO_LIMITS.icons} icons or ${DRAWIO_LIMITS.cells} cells). If the system is bigger, draw the main path and say in the Description which part to draw next as a separate diagram.`,
    'No external resources: no URLs or links, no images except the library icons that search_shapes returns (image=img/lib/...), no data: images, no HTML in labels other than b, i, br, span or font. Do not use shapes whose search result is an embedded data: image.',
    `Write the diagram as plain, uncompressed XML (<mxfile><diagram><mxGraphModel><root>...), one page, with the Write tool to ${file} in your run folder (the folder you were told to put files in). Do not write it compressed or base64 encoded.`,
  ];
}

/** The first line is a marker the demo provider recognises; the rest is what a real agent follows. */
export function composeIconDiagramPrompt(kind: DiagramKind, title: string, repos: { name: string; slug: string; default_branch: string }[], cloud: Cloud, focus = ''): string {
  const where = repos.map((r) => `- "${r.name}": a read-only copy of the ${r.default_branch} branch is in repos/${r.slug}/`).join('\n');
  return [
    `Architecture diagram request: ${kind}`,
    `Style: icon diagram (draw.io), cloud: ${cloud}`,
    `Draw the architecture diagram "${title}" from the code of ${repos.length === 1 ? 'this repository' : 'these repositories'}, as an icon diagram in the style of the official ${CLOUD_LABELS[cloud]} reference architectures (official service icons, nested boundary boxes, numbered steps, labelled arrows):`,
    where,
    `Diagram type: ${ICON_KIND_GUIDE[kind]}`,
    focus.trim() ? `Focus on: ${focus.trim()}` : 'Cover the whole system, concentrating on what a new developer needs to understand first.',
    'Use the document-code skill: explore selectively (manifests, entry points, route and handler registrations, configuration, infrastructure code) and base every icon and arrow on code you read.',
    'How to draw it:',
    ...iconDrawingRules(cloud).map((r, i) => `${i + 1}. ${r}`),
    'When the file is written, reply with exactly two parts and nothing else:',
    `1. A line "Diagram file: <path of the .drawio file>".`,
    '2. A line "Description:" followed by 2 to 5 sentences that say what the diagram shows and cite the source files it is based on as `repo-name/path/to/file.ext:line`.',
    'Do not change anything inside repos/, and never copy secrets or credentials into the diagram or the description.',
  ].join('\n');
}

/** What the session is told every time it runs, including follow-up messages. */
export function iconDiagramRules(title: string): string {
  return [
    'Write only inside your run folder. Do not create, edit or delete anything inside repos/.',
    `The portal checks and stores the diagram from the file ${DRAWIO_FILE} in your run folder by itself: it appears as "${title}" on the Create page (Diagrams tab) and as files in the project Vault (generated/diagrams/). Never say that no file was written or that the diagram was not saved.`,
    `If you are asked to fix, shrink, split or redraw it, write the complete new ${DRAWIO_FILE} again and reply in the same format ("Diagram file:", then "Description:"); a reply without a new file changes nothing. If you are asked where the diagram is, say where it is stored, and do not draw it again.`,
    `Keep every diagram readable: at most about ${READABLE_ICONS} icons. The portal refuses more than ${DRAWIO_LIMITS.icons} icons, ${DRAWIO_LIMITS.cells} cells or ${Math.round(DRAWIO_LIMITS.bytes / 1000)} KB. Only the draw.io tools search_shapes and get_drawio_reference may be used; the portal blocks the rest.`,
  ].join(' ');
}

/** The path the agent reported in its reply, if any. */
export function parseDiagramFileReply(text: string): { path: string | null } {
  const m = /^\s*\**Diagram file\**\s*:\s*\**\s*`?([^`\r\n]+?)`?\s*$/im.exec(String(text ?? ''));
  return { path: m ? m[1].trim() : null };
}

/** The block a documentation prompt carries when the agent may draw its own icon diagrams. */
export function docIconDiagramBlock(cloud: Cloud): string {
  return [
    `Diagrams you draw yourself: you may add up to 2 icon diagrams (official ${CLOUD_LABELS[cloud]} style) where they clarify the architecture or a flow. Draw each as a draw.io file saved in your run folder (for example flow.drawio) and insert it with an image line alone on its own line, \`![short caption](<path of the file, the same path you gave the Write tool>)\`. Do not write Mermaid for them. How to draw:`,
    ...iconDrawingRules(cloud, 'a .drawio file').map((r, i) => `    ${i + 1}) ${r}`),
  ].join('\n');
}

/** The block a presentation prompt carries when the agent may draw its own icon diagrams. */
export function deckIconDiagramBlock(cloud: Cloud): string {
  return [
    `Diagrams you draw yourself: you may draw up to 2 icon diagrams (official ${CLOUD_LABELS[cloud]} style) for slides. Draw each as a draw.io file saved in your run folder (for example flow.drawio) and put it on a slide with the "image" element whose "path" is that file (make-doc draws .drawio files as pictures). How to draw:`,
    ...iconDrawingRules(cloud, 'a .drawio file').map((r, i) => `    ${i + 1}) ${r}`),
  ].join('\n');
}

/** Markdown for a stored icon diagram: an image line that make-doc draws from the project file. */
export function iconImageMarkdown(title: string, path: string, description: string | null, heading = false): string {
  const alt = title.replace(/[\[\]\r\n]+/g, ' ').slice(0, 120);
  const parts: string[] = [];
  if (heading) parts.push(`## ${title}`);
  parts.push(`![${alt}](${path.replace(/ /g, '%20').replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'))})`);
  if (description) parts.push(description);
  return parts.join('\n\n') + '\n';
}

export const ICON_DESCRIPTION_LIMIT = DIAGRAM_LIMITS.descriptionChars;
