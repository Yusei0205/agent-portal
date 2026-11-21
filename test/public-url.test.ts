import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { publicBaseUrl } from '../server/public-url.ts';
import type { PortalRequest } from '../server/http.ts';

const saved = process.env.PORTAL_PUBLIC_URL;
afterEach(() => { if (saved === undefined) delete process.env.PORTAL_PUBLIC_URL; else process.env.PORTAL_PUBLIC_URL = saved; });
const req = (host: string, secure: boolean) => ({ headers: { host }, secure }) as unknown as PortalRequest;

test('uses the configured public URL (without a trailing slash) behind CloudFront', () => {
  process.env.PORTAL_PUBLIC_URL = 'https://d123.cloudfront.net/';
  assert.equal(publicBaseUrl(req('abc.lambda-url.ap-southeast-1.on.aws', false)), 'https://d123.cloudfront.net');
});

test('falls back to the request address for local installs', () => {
  delete process.env.PORTAL_PUBLIC_URL;
  assert.equal(publicBaseUrl(req('localhost:8787', false)), 'http://localhost:8787');
  assert.equal(publicBaseUrl(req('portal.example.com', true)), 'https://portal.example.com');
});
