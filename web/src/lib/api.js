// Thin fetch wrapper for the portal API.
// Every state-changing call carries the CSRF header (x-requested-with: agent-portal).

export class ApiError extends Error {
  /** @param {number} status @param {string} message @param {Record<string, unknown>} [data] */
  constructor(status, message, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    /** Parsed response body from the server (may be undefined for network errors). */
    this.data = data;
  }
}

/**
 * Multipart upload — sends FormData without setting Content-Type so the browser
 * can include the multipart boundary. The CSRF header is still sent.
 *
 * @param {string} url
 * @param {FormData} formData
 * @returns {Promise<any>}
 */
async function requestUpload(url, formData) {
  const headers = { 'x-requested-with': 'agent-portal' };
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the portal server. Check that it is running.');
  }
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && data.error) ||
      `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, typeof data === 'object' && data !== null ? data : undefined);
  }
  return data;
}

/**
 * The server answers "Sign in to continue" when the session has ended (idle too long, signed out elsewhere).
 * Tell the app once so it shows the sign-in page instead of a screen of failing calls.
 */
function notifySignedOut(status, message, url) {
  if (status !== 401 || message !== 'Sign in to continue') return;
  if (String(url).startsWith('/api/auth/')) return;
  window.dispatchEvent(new CustomEvent('portal:signed-out'));
}

/** Set by the password prompt (ReauthPrompt): asks the person for their password and resolves true once confirmed. */
let askForPassword = /** @type {null | (() => Promise<boolean>)} */ (null);
/** @param {null | (() => Promise<boolean>)} fn */
export function setReauthHandler(fn) {
  askForPassword = fn;
}

/**
 * @param {string} method
 * @param {string} url
 * @param {unknown} [body]
 * @param {boolean} [retried] true on the repeat after a password confirmation
 * @returns {Promise<any>}
 */
async function request(method, url, body, retried = false) {
  /** @type {Record<string, string>} */
  const headers = { 'x-requested-with': 'agent-portal' };
  /** @type {BodyInit | undefined} */
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the portal server. Check that it is running.');
  }
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json()
    : await res.text();
  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && data.error) ||
      `Request failed (${res.status})`;
    notifySignedOut(res.status, msg, url);
    // Sensitive actions ask for the password again: confirm it, then repeat the action once.
    if (res.status === 403 && data && typeof data === 'object' && data.code === 'reauth_required' && askForPassword && !retried) {
      if (await askForPassword()) return request(method, url, body, true);
    }
    throw new ApiError(res.status, msg, typeof data === 'object' && data !== null ? data : undefined);
  }
  return data;
}

export const api = {
  /** @param {string} url @returns {Promise<any>} */
  get: (url) => request('GET', url),
  /** @param {string} url @param {unknown} [body] @returns {Promise<any>} */
  post: (url, body = {}) => request('POST', url, body),
  /** @param {string} url @param {unknown} [body] @returns {Promise<any>} */
  put: (url, body = {}) => request('PUT', url, body),
  /** @param {string} url @param {unknown} [body] @returns {Promise<any>} */
  patch: (url, body = {}) => request('PATCH', url, body),
  /** @param {string} url @param {unknown} [body] @returns {Promise<any>} */
  delete: (url, body) => request('DELETE', url, body),
  /**
   * Multipart file upload — body must be FormData.
   * The CSRF header is sent; Content-Type is omitted so the browser sets the
   * multipart boundary automatically.
   * @param {string} url @param {FormData} formData @returns {Promise<any>}
   */
  upload: (url, formData) => requestUpload(url, formData),
};

export default api;
