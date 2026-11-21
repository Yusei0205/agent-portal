/**
 * Vault folder list builder.
 *
 * Takes an array of vault files (each with an optional `folder` property)
 * and returns a sorted, deduplicated list of all folder paths, including
 * every ancestor path.
 */

/**
 * Build a sorted list of unique folder paths from vault files.
 * Includes all ancestor paths implied by each file's folder.
 *
 * @param {Array<{ folder?: string | null | undefined }>} files
 * @returns {string[]} sorted folder paths (root / null entries excluded)
 *
 * @example
 * buildFolderList([{ folder: 'a/b/c' }, { folder: null }])
 * // => ['a', 'a/b', 'a/b/c']
 */
export function buildFolderList(files) {
  const set = new Set();
  for (const file of files) {
    const folder = file.folder;
    if (!folder) continue;
    const parts = folder.split('/').filter(Boolean);
    // Add each ancestor up to and including the file's own folder
    for (let i = 1; i <= parts.length; i++) {
      set.add(parts.slice(0, i).join('/'));
    }
  }
  return Array.from(set).sort();
}
