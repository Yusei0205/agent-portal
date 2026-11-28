/**
 * Installs the Icon diagrams (draw.io) pack into ICON_DIAGRAMS_DIR. Run while the cloud portal image is built
 * (Dockerfile.lambda), so the pack is part of the image and the portal never has to fetch its thousands of files
 * from S3 on a cold start.
 *
 *   ICON_DIAGRAMS_DIR=/opt/icon-diagrams node --import tsx scripts/install-drawio-pack.ts
 *
 * Everything it downloads is pinned and checked against the hashes in server/drawio-pack.ts.
 */
import path from 'node:path';
import { installDrawioPackForBuild } from '../server/tool-packs.ts';
import { drawioPackState } from '../server/drawio-pack.ts';

const dir = process.env.ICON_DIAGRAMS_DIR;
if (!dir) {
  console.error('Set ICON_DIAGRAMS_DIR to the folder the pack should be installed into.');
  process.exit(2);
}

try {
  await installDrawioPackForBuild((line) => console.log(`[drawio-pack] ${line}`));
  const { tool, renderer } = drawioPackState();
  if (!tool.ok || !renderer.ok) throw new Error(`Installed, but the pack is incomplete: ${tool.ok ? '' : tool.reason} ${renderer.ok ? '' : renderer.reason}`);
  console.log(`[drawio-pack] ready in ${path.resolve(dir)}`);
  process.exit(0);
} catch (e) {
  console.error('[drawio-pack] install failed:', e instanceof Error ? e.message : e);
  process.exit(1);
}
