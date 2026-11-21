/**
 * What a chat message may carry on this portal. The cloud portal takes 50 MB a file (they go to S3 directly and reach the agent as
 * download links); a local install keeps 2 MB a file and 8 MB in all. The portal says which (GET /api/attachment-limits); until it
 * has answered, or if it cannot, the smaller limits are shown, because they are always safe.
 */

import { useEffect, useState } from 'react';
import { api } from './api.js';

const MB = 1024 * 1024;

/** The limits that hold everywhere. */
export const SMALL_LIMITS = Object.freeze({ files: 5, fileBytes: 2 * MB, totalBytes: 8 * MB, large: false });

/** "2 MB", "50 MB", "1.5 MB". */
export function formatMb(bytes) {
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

/** The limits out of the portal's answer, or the small ones when it is not an answer we know. */
export function parseLimits(data) {
  const c = data && typeof data === 'object' ? data.chat : null;
  if (!c || !Number.isFinite(c.files) || !Number.isFinite(c.fileBytes) || !Number.isFinite(c.totalBytes)) return SMALL_LIMITS;
  return { files: c.files, fileBytes: c.fileBytes, totalBytes: c.totalBytes, large: Boolean(c.large) };
}

/** "Up to 5 files · 2 MB each · 8 MB total". */
export function limitsHint(limits) {
  return `Up to ${limits.files} files · ${formatMb(limits.fileBytes)} each · ${formatMb(limits.totalBytes)} total`;
}

let cached = null;
let pending = null;

/** Ask the portal once per page load. */
export function loadAttachmentLimits() {
  if (cached) return Promise.resolve(cached);
  pending ??= api.get('/api/attachment-limits').then(parseLimits, () => SMALL_LIMITS).then((l) => {
    // A failed or unrecognised answer is not remembered, so the next chat box asks again.
    if (l === SMALL_LIMITS) pending = null; else cached = l;
    return l;
  });
  return pending;
}

/** The limits for the chat box: the small ones at first, the portal's once it has answered. */
export function useAttachmentLimits() {
  const [limits, setLimits] = useState(cached ?? SMALL_LIMITS);
  useEffect(() => {
    let live = true;
    loadAttachmentLimits().then((l) => { if (live) setLimits(l); });
    return () => { live = false; };
  }, []);
  return limits;
}

/** Tests: forget what was learned. */
export function _resetAttachmentLimits() { cached = null; pending = null; }
