/**
 * Upload a file from the browser straight to S3, for files that cannot go through the portal.
 *
 * On the cloud portal every request passes through a Lambda Function URL, which takes at most 6 MB. The portal therefore hands out
 * a presigned link (POST .../ai-attachments/presign), the browser PUTs the file to it, and the portal then checks what arrived and
 * records it (POST .../ai-attachments/complete). Where the portal cannot do this (a local install keeps files on its own disk) it
 * says 409 and the caller sends the file through the portal as before.
 */

import { api, ApiError } from './api.js';

/** What a refused or failed PUT to S3 means for the person. */
export function putErrorText(status, body = '') {
  if (status === 403) return 'The upload link was refused or has expired. Choose the file again.';
  if (status === 400 && /EntityTooLarge|EntityTooSmall|IncompleteBody|InvalidArgument/.test(body)) return 'Storage did not accept the file as it was sent. Choose it again.';
  return `Storage refused the file (HTTP ${status}). Try again.`;
}

/**
 * PUT `file` to `url`, reporting progress between 0 and 1. The browser sets Content-Length from the file, which the link was
 * signed for, so a different length is refused by S3.
 * @param {string} url
 * @param {Blob} file
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
export function putWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress?.(1); resolve(); } else reject(new Error(putErrorText(xhr.status, String(xhr.responseText || ''))));
    };
    xhr.onerror = () => reject(new Error('The upload could not reach storage. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('The upload was cancelled.'));
    xhr.ontimeout = () => reject(new Error('The upload took too long. Try again.'));
    xhr.send(file);
  });
}

/**
 * @param {object} args
 * @param {string} args.projectId
 * @param {File} args.file
 * @param {'chat'|'default'} [args.purpose]  'chat' allows up to 50 MB
 * @param {(fraction: number) => void} [args.onProgress]
 * @param {typeof putWithProgress} [args.put]  replaced in tests
 * @returns {Promise<{ id: string, filename: string, mimeType: string, size: number, kind: string } | null>}
 *   the attachment, or null when this portal cannot take direct uploads
 */
export async function uploadDirect({ projectId, file, purpose = 'default', onProgress, put = putWithProgress }) {
  let started;
  try {
    started = await api.post(`/api/projects/${projectId}/ai-attachments/presign`, { filename: file.name, size: file.size, purpose });
  } catch (e) {
    // 409: this deployment cannot (local storage). 404/405: an older portal that has no such route.
    if (e instanceof ApiError && (e.status === 409 || e.status === 404 || e.status === 405)) return null;
    throw e;
  }
  if (!started || typeof started.url !== 'string' || typeof started.token !== 'string') return null;
  await put(started.url, file, onProgress);
  const done = await api.post(`/api/projects/${projectId}/ai-attachments/complete`, { token: started.token });
  return done.attachment;
}
