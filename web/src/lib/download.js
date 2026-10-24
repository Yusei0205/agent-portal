/**
 * Save a file the API serves. Goes through fetch so a refusal (for example "no file to download") shows as a message
 * instead of a saved error page.
 * @param {string} url An /api/ path
 * @param {string} filename The name to save under
 * @returns {Promise<void>}
 */
export async function saveFromApi(url, filename) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `Download failed (${res.status})`);
  }
  const blobUrl = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
