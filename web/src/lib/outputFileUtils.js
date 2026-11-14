/**
 * Output file utilities — pure helpers (no DOM, no React).
 *
 * Used by RunOutputsCard, IdeOutputs, and OutputFilePreview.
 * Tested in test/output-file-utils.test.ts.
 */

/**
 * Format a byte count as a human-readable string.
 * @param {number | null | undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes == null || bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Return an icon name and short label for a file based on its MIME type / filename extension.
 * Icon names must map to entries in web/src/components/Icon.jsx.
 *
 * @param {string | null | undefined} mimeType
 * @param {string | null | undefined} fileName
 * @returns {{ icon: string, label: string }}
 */
export function getFileTypeMeta(mimeType, fileName) {
  const name   = fileName ?? '';
  const dotIdx = name.lastIndexOf('.');
  // Only treat the suffix as an extension when there is a dot
  // that is not the last character (e.g. 'file.txt' → 'txt', 'Makefile' → '').
  const ext    = dotIdx >= 0 && dotIdx < name.length - 1
    ? name.slice(dotIdx + 1).toLowerCase()
    : '';

  if (mimeType?.startsWith('image/')) return { icon: 'eye', label: 'Image' };
  if (mimeType === 'application/pdf' || ext === 'pdf') return { icon: 'file', label: 'PDF' };
  if (ext === 'pptx' || mimeType?.includes('presentationml')) return { icon: 'file', label: 'PPTX' };
  if (ext === 'docx' || mimeType?.includes('wordprocessingml')) return { icon: 'file', label: 'DOCX' };
  if (ext === 'md' || mimeType === 'text/markdown') return { icon: 'file', label: 'MD' };
  // A source file the session wrote (text/plain with a code extension) is labelled by its extension, e.g. TSX.
  if (mimeType === 'text/plain' && ext && ext !== 'txt') return { icon: 'file', label: ext.toUpperCase() };
  if (mimeType?.startsWith('text/') || ext === 'txt') return { icon: 'file', label: 'Text' };
  if (ext === 'zip' || mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') {
    return { icon: 'zip-download', label: 'ZIP' };
  }
  if (ext === 'json' || mimeType === 'application/json') return { icon: 'file', label: 'JSON' };
  if (ext === 'csv') return { icon: 'file', label: 'CSV' };

  const upper = ext.toUpperCase();
  return { icon: 'file', label: upper || 'File' };
}

/**
 * Returns true when the file is an image and should display a thumbnail.
 * @param {{ mime_type?: string | null } | null | undefined} file
 * @returns {boolean}
 */
export function isImageFile(file) {
  return Boolean(file?.mime_type?.startsWith('image/'));
}

/**
 * Group output files by their run_id.
 * Files without a run_id are placed under the key `null`.
 *
 * @param {Array<{ run_id?: string | null }> | null | undefined} outputFiles
 * @returns {Map<string | null, Array>}
 */
export function groupOutputsByRunId(outputFiles) {
  const map = new Map();
  for (const file of outputFiles ?? []) {
    const key = file.run_id ?? null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(file);
  }
  return map;
}
