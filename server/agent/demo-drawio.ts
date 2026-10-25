/**
 * Demo provider helpers for icon diagrams (FR-DIAG-9): a small valid draw.io file in the style of the chosen cloud, and
 * the broken variants the tests ask for with markers in the goal. Not used by real engines.
 */

export type DemoDrawioVariant = 'ok' | 'external' | 'invalid' | 'oversized' | 'toomany' | 'script' | 'multipage';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const POINTS = 'points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]]';

function groupStyle(cloud: string): string {
  if (cloud === 'aws') return `${POINTS};outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fillColor=none;verticalAlign=top;align=left;spacingLeft=30;fontColor=#232F3E;dashed=0;`;
  return 'rounded=0;whiteSpace=wrap;html=1;container=1;collapsible=0;dashed=1;fillColor=none;strokeColor=#5B6770;verticalAlign=top;align=left;spacingLeft=10;fontSize=12;';
}

function iconStyle(cloud: string, i: number): string {
  if (cloud === 'aws') {
    const icons = ['lambda', 'dynamodb', 's3', 'sqs', 'api_gateway', 'sns'];
    return `sketch=0;${POINTS};outlineConnect=0;fontColor=#232F3E;fillColor=#ED7100;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${icons[i % icons.length]};`;
  }
  if (cloud === 'azure') return 'image;aspect=fixed;html=1;align=center;fontSize=12;image=img/lib/azure2/compute/Function_Apps.svg;verticalLabelPosition=bottom;verticalAlign=top;';
  if (cloud === 'gcp') return 'sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=#4285F4;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;aspect=fixed;shape=mxgraph.gcp2.hexIcon;prIcon=cloud_run;';
  if (cloud === 'kubernetes') return 'aspect=fixed;sketch=0;html=1;dashed=0;whitespace=wrap;verticalLabelPosition=bottom;verticalAlign=top;fillColor=#2875E2;strokeColor=#ffffff;shape=mxgraph.kubernetes.icon2;prIcon=pod;';
  return 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;';
}

const userStyle = (cloud: string) => (cloud === 'aws' ? 'sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=#232F3E;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;aspect=fixed;shape=mxgraph.aws4.user;' : 'shape=actor;whiteSpace=wrap;html=1;verticalLabelPosition=bottom;verticalAlign=top;');

/** A draw.io file with a user, a boundary box and one icon per item, joined by numbered, labelled arrows, plus a legend. */
export function demoDrawio(o: { cloud: string; title: string; items: string[]; variant?: DemoDrawioVariant }): string {
  const variant = o.variant ?? 'ok';
  if (variant === 'invalid') return '<mxfile><diagram id="a" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></diagram></mxfile>';
  const items = (o.items.length ? o.items : ['service']).slice(0, 6);
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const w = 40 + items.length * 130;
  cells.push(`<mxCell id="grp" value="${esc(o.title.slice(0, 60))}" style="${groupStyle(o.cloud)}" vertex="1" parent="1"><mxGeometry x="200" y="40" width="${w}" height="200" as="geometry"/></mxCell>`);
  cells.push(`<mxCell id="user" value="Users" style="${userStyle(o.cloud)}" vertex="1" parent="1"><mxGeometry x="60" y="110" width="60" height="60" as="geometry"/></mxCell>`);
  items.forEach((name, i) => {
    cells.push(`<mxCell id="n${i}" value="${esc(name.slice(0, 40))}" style="${iconStyle(o.cloud, i)}" vertex="1" parent="grp"><mxGeometry x="${30 + i * 130}" y="60" width="64" height="64" as="geometry"/></mxCell>`);
  });
  cells.push(`<mxCell id="e0" value="HTTPS" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;" edge="1" parent="1" source="user" target="n0"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  cells.push('<mxCell id="b0" value="1" style="ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#232F3E;fontColor=#ffffff;fontStyle=1;strokeColor=none;" vertex="1" parent="1"><mxGeometry x="140" y="120" width="24" height="24" as="geometry"/></mxCell>');
  for (let i = 1; i < items.length; i++) {
    cells.push(`<mxCell id="e${i}" value="calls" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;" edge="1" parent="grp" source="n${i - 1}" target="n${i}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  }
  cells.push(`<mxCell id="legend" value="1  Request enters&lt;br&gt;2  Handlers call each other" style="text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=11;" vertex="1" parent="1"><mxGeometry x="200" y="260" width="240" height="40" as="geometry"/></mxCell>`);
  if (variant === 'external') {
    cells.push('<mxCell id="bad" value="Outside" style="shape=image;image=https://evil.example/logo.png;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="40" height="40" as="geometry"/></mxCell>');
  }
  if (variant === 'script') {
    cells.push('<mxCell id="bad" value="&lt;img src=x onerror=alert(1)&gt;" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="40" height="40" as="geometry"/></mxCell>');
  }
  if (variant === 'toomany') {
    for (let i = 0; i < 400; i++) cells.push(`<mxCell id="x${i}" value="x" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="${(i % 20) * 50}" y="${400 + Math.floor(i / 20) * 50}" width="40" height="40" as="geometry"/></mxCell>`);
  }
  const model = `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="827" pageHeight="1169" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel>`;
  const pad = variant === 'oversized' ? `<!-- ${'x'.repeat(600_000)} -->` : '';
  const second = variant === 'multipage' ? `<diagram id="b" name="Page-2">${model}</diagram>` : '';
  return `<mxfile host="demo">${pad}<diagram id="a" name="Page-1">${model}</diagram>${second}</mxfile>`;
}

export function demoVariant(ask: string): DemoDrawioVariant {
  if (ask.includes('[demo-invalid-drawio]')) return 'invalid';
  if (ask.includes('[demo-oversized-drawio]')) return 'oversized';
  if (ask.includes('[demo-toomany-drawio]')) return 'toomany';
  if (ask.includes('[demo-external-drawio]')) return 'external';
  if (ask.includes('[demo-script-drawio]')) return 'script';
  if (ask.includes('[demo-multipage-drawio]')) return 'multipage';
  return 'ok';
}
