// AppSync Events Lambda authorizer (inline Lambda code, read by portal-stack.ts). Kept as a real file, not a template
// string: inside a TypeScript template string a backslash in a regular expression is dropped, which broke the route
// match and made every realtime connection fail. Tested in test/realtime-authorizer.test.ts.
const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
let key;
async function signingKey() {
  if (key) return key;
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.KEY_SECRET_ARN }));
  key = crypto.createHmac('sha256', r.SecretString.trim()).update('portal-realtime-v1').digest();
  return key;
}
function verify(token, k) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', k).update(parts[0] + '.' + parts[1]).digest('base64url');
  const a = Buffer.from(parts[2]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let c;
  try { c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!c || typeof c.exp !== 'number' || c.exp < Date.now() / 1000) return null;
  return c;
}
exports.handler = async (e) => {
  const claims = verify(e.authorizationToken, await signingKey());
  if (!claims) return { isAuthorized: false };
  const ctx = e.requestContext || {};
  if (ctx.operation === 'EVENT_CONNECT') return { isAuthorized: true };
  if (ctx.operation !== 'EVENT_SUBSCRIBE') return { isAuthorized: false };
  const ch = ctx.channel || '';
  if (ch.startsWith('/global/') || ch.startsWith('/run/')) return { isAuthorized: true };
  const m = ch.match(/^\/project\/([^/]+)/);
  if (m) return { isAuthorized: claims.adm === true || (Array.isArray(claims.prj) && claims.prj.includes(m[1])) };
  return { isAuthorized: false };
};
