// Thin fetch wrapper for the portal API.
// Every state-changing call carries the CSRF header (x-requested-with: fetch).

export class ApiError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * @param {string} method
 * @param {string} url
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function request(method, url, body) {
  /** @type {Record<string, string>} */
  const headers = { 'x-requested-with': 'fetch' };
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
    throw new ApiError(res.status, msg);
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
  delete: (url, body) => request('DELETE', url, body),
};

export default api;
