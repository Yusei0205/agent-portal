/**
 * Docs-pack capability detection.
 *
 * Each function tries to resolve a package from node_modules.
 * Returns true if the package is resolvable, false otherwise.
 *
 * Packages:
 *   pdfjs-dist   — PDF upload parsing
 *   docx         — Word document generation
 *   exceljs      — Excel generation
 *   pptxgenjs    — PowerPoint generation
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Capability checks ─────────────────────────────────────────────────────────

export function hasPdfCapability(): boolean {
  try {
    require.resolve('pdfjs-dist');
    return true;
  } catch {
    return false;
  }
}

export function hasDocxCapability(): boolean {
  try {
    require.resolve('docx');
    return true;
  } catch {
    return false;
  }
}

export function hasExcelCapability(): boolean {
  try {
    require.resolve('exceljs');
    return true;
  } catch {
    return false;
  }
}

export function hasPptxCapability(): boolean {
  try {
    require.resolve('pptxgenjs');
    return true;
  } catch {
    return false;
  }
}

// ── Guard helpers ─────────────────────────────────────────────────────────────

export function requirePdfCapability(): void {
  if (!hasPdfCapability()) {
    throw new Error(
      'PDF capability not available. Install the docs pack: npm install pdfjs-dist',
    );
  }
}

export function requireDocxCapability(): void {
  if (!hasDocxCapability()) {
    throw new Error(
      'Word document capability not available. Install the docs pack: npm install docx',
    );
  }
}

export function requireExcelCapability(): void {
  if (!hasExcelCapability()) {
    throw new Error(
      'Excel capability not available. Install the docs pack: npm install exceljs',
    );
  }
}

export function requirePptxCapability(): void {
  if (!hasPptxCapability()) {
    throw new Error(
      'PowerPoint capability not available. Install the docs pack: npm install pptxgenjs',
    );
  }
}

// ── All capabilities ──────────────────────────────────────────────────────────

/** Returns true when all four document packages are available. */
export function hasAllDocCapabilities(): boolean {
  return (
    hasPdfCapability() &&
    hasDocxCapability() &&
    hasExcelCapability() &&
    hasPptxCapability()
  );
}
