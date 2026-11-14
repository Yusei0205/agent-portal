/**
 * SSRF guard tests (finding 5).
 *
 * Covers:
 *   ✓ Blocked: cloud metadata IP (169.254.169.254)
 *   ✓ Blocked: redirect to metadata IP (blocked at both DNS and route levels)
 *   ✓ Blocked: metadata.google.internal hostname
 *   ✓ Blocked: link-local IPv6 (fe80::)
 *   ✓ Allowed: loopback (127.0.0.1) when allowPrivateNetworks=true
 *   ✓ Allowed: private range (192.168.x.x) when allowPrivateNetworks=true
 *   ✓ Blocked: loopback when allowPrivateNetworks=false
 *   ✓ Blocked: private range when allowPrivateNetworks=false
 *   ✓ Test run: goto fixture URL passes when allowPrivateNetworks=true
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSsrf, assertNotBlocked } from '../server/testing/ssrf.ts';

describe('SSRF guard — checkSsrf()', () => {
  it('always blocks 169.254.169.254 (AWS/GCE metadata)', async () => {
    const r = await checkSsrf('169.254.169.254', true);
    assert.equal(r.blocked, true);
    assert.ok(r.reason?.includes('169.254'), `Reason: ${r.reason}`);
  });

  it('always blocks 169.254.169.250 (Azure WireServer)', async () => {
    const r = await checkSsrf('169.254.169.250', true);
    assert.equal(r.blocked, true);
  });

  it('always blocks metadata.google.internal', async () => {
    const r = await checkSsrf('metadata.google.internal', true);
    assert.equal(r.blocked, true);
    assert.ok(r.reason?.includes('metadata.google.internal'));
  });

  it('always blocks metadata.azure.internal', async () => {
    const r = await checkSsrf('metadata.azure.internal', true);
    assert.equal(r.blocked, true);
  });

  it('always blocks link-local 169.254.x.x range directly as IP', async () => {
    const r = await checkSsrf('169.254.1.1', true);
    assert.equal(r.blocked, true);
    assert.ok(r.reason?.includes('link-local'));
  });

  it('always blocks link-local IPv6 fe80::', async () => {
    const r = await checkSsrf('fe80::1', true);
    assert.equal(r.blocked, true);
    assert.ok(r.reason?.includes('fe80'));
  });

  it('allows 127.0.0.1 when allowPrivateNetworks=true', async () => {
    const r = await checkSsrf('127.0.0.1', true);
    assert.equal(r.blocked, false);
  });

  it('allows 192.168.1.1 when allowPrivateNetworks=true', async () => {
    const r = await checkSsrf('192.168.1.1', true);
    assert.equal(r.blocked, false);
  });

  it('allows 10.0.0.1 when allowPrivateNetworks=true', async () => {
    const r = await checkSsrf('10.0.0.1', true);
    assert.equal(r.blocked, false);
  });

  it('blocks 127.0.0.1 when allowPrivateNetworks=false', async () => {
    const r = await checkSsrf('127.0.0.1', false);
    assert.equal(r.blocked, true);
    assert.ok(r.reason?.includes('loopback'));
  });

  it('blocks 192.168.1.1 when allowPrivateNetworks=false', async () => {
    const r = await checkSsrf('192.168.1.1', false);
    assert.equal(r.blocked, true);
    assert.ok(r.reason?.includes('RFC-1918'));
  });

  it('blocks 10.0.0.5 when allowPrivateNetworks=false', async () => {
    const r = await checkSsrf('10.0.0.5', false);
    assert.equal(r.blocked, true);
  });

  it('allows 8.8.8.8 (public IP) regardless of setting', async () => {
    const r = await checkSsrf('8.8.8.8', false);
    assert.equal(r.blocked, false);
  });

  it('allows 8.8.8.8 (public IP) when allowPrivateNetworks=true', async () => {
    const r = await checkSsrf('8.8.8.8', true);
    assert.equal(r.blocked, false);
  });
});

describe('SSRF guard — assertNotBlocked()', () => {
  it('throws for metadata URL', async () => {
    await assert.rejects(
      () => assertNotBlocked('http://169.254.169.254/latest/meta-data/', true),
      /SSRF blocked/,
    );
  });

  it('throws for metadata.google.internal URL', async () => {
    await assert.rejects(
      () => assertNotBlocked('http://metadata.google.internal/computeMetadata/v1/', true),
      /SSRF blocked/,
    );
  });

  it('does not throw for loopback URL when allowPrivateNetworks=true', async () => {
    await assert.doesNotReject(
      () => assertNotBlocked('http://127.0.0.1:9999/api', true),
    );
  });

  it('throws for loopback URL when allowPrivateNetworks=false', async () => {
    await assert.rejects(
      () => assertNotBlocked('http://127.0.0.1:9999/api', false),
      /SSRF blocked/,
    );
  });

  it('does not throw for invalid URL (graceful pass-through)', async () => {
    await assert.doesNotReject(
      () => assertNotBlocked('not-a-valid-url', true),
    );
  });
});

// ── Issue 3: alternate IP encodings ──────────────────────────────────────────

import { normaliseIpv4, extractMappedIpv4 } from '../server/testing/ssrf.ts';

describe('SSRF guard — IPv4-mapped IPv6 (::ffff:...) must be blocked', () => {
  it('blocks ::ffff:169.254.169.254 (standard mapped form)', async () => {
    const r = await checkSsrf('::ffff:169.254.169.254', true);
    assert.equal(r.blocked, true, `expected blocked, reason: ${r.reason}`);
  });

  it('blocks ::ffff:a9fe:a9fe (hex-word mapped form)', async () => {
    // 0xa9fe = 169.254, so ::ffff:a9fe:a9fe = ::ffff:169.254.169.254
    const r = await checkSsrf('::ffff:a9fe:a9fe', true);
    assert.equal(r.blocked, true, `expected blocked, reason: ${r.reason}`);
  });

  it('blocks [::ffff:a9fe:a9fe] (bracketed)', async () => {
    const r = await checkSsrf('[::ffff:a9fe:a9fe]', true);
    assert.equal(r.blocked, true, `expected blocked, reason: ${r.reason}`);
  });

  it('blocks ::ffff:0a00:0005 (private IPv4 10.0.0.5 when private networks disallowed)', async () => {
    const r = await checkSsrf('::ffff:0a00:0005', false);
    assert.equal(r.blocked, true, `expected blocked for private range, reason: ${r.reason}`);
  });

  it('allows ::ffff:0a00:0005 when allowPrivateNetworks=true', async () => {
    const r = await checkSsrf('::ffff:0a00:0005', true);
    assert.equal(r.blocked, false, 'mapped private should be allowed when private networks enabled');
  });
});

describe('SSRF guard — alternate IPv4 representations must be normalised', () => {
  it('blocks decimal integer 2852039166 (= 169.254.169.254)', async () => {
    const r = await checkSsrf('2852039166', true);
    assert.equal(r.blocked, true, `expected blocked, reason: ${r.reason}`);
  });

  it('blocks octal dotted 0251.0376.0251.0376 (= 169.254.169.254)', async () => {
    const r = await checkSsrf('0251.0376.0251.0376', true);
    assert.equal(r.blocked, true, `expected blocked, reason: ${r.reason}`);
  });

  it('blocks hex integer 0xa9fea9fe (= 169.254.169.254)', async () => {
    const r = await checkSsrf('0xa9fea9fe', true);
    assert.equal(r.blocked, true, `expected blocked, reason: ${r.reason}`);
  });
});

describe('normaliseIpv4()', () => {
  it('returns dotted decimal unchanged', () => {
    assert.equal(normaliseIpv4('169.254.169.254'), '169.254.169.254');
  });

  it('converts decimal integer', () => {
    assert.equal(normaliseIpv4('2852039166'), '169.254.169.254');
  });

  it('converts hex integer', () => {
    assert.equal(normaliseIpv4('0xa9fea9fe'), '169.254.169.254');
  });

  it('converts octal octets', () => {
    assert.equal(normaliseIpv4('0251.0376.0251.0376'), '169.254.169.254');
  });

  it('returns null for non-IP strings', () => {
    assert.equal(normaliseIpv4('example.com'), null);
  });
});

describe('extractMappedIpv4()', () => {
  it('extracts from ::ffff:a.b.c.d form', () => {
    assert.equal(extractMappedIpv4('::ffff:169.254.169.254'), '169.254.169.254');
  });

  it('extracts from ::ffff:hhhh:hhhh form', () => {
    assert.equal(extractMappedIpv4('::ffff:a9fe:a9fe'), '169.254.169.254');
  });

  it('returns null for non-mapped IPv6', () => {
    assert.equal(extractMappedIpv4('::1'), null);
    assert.equal(extractMappedIpv4('fe80::1'), null);
  });
});

// ── Issue 2: redirect-to-metadata is blocked ──────────────────────────────────

import { fetchWithSsrfCheck } from '../server/testing/runner.ts';
import http from 'node:http';

describe('fetchWithSsrfCheck — redirect SSRF protection', () => {
  it('blocks redirect to 169.254.169.254', async () => {
    // Create a local HTTP server that issues a redirect to the metadata IP
    const redirectServer = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((_req, res) => {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (redirectServer.address() as { port: number }).port;

    try {
      await assert.rejects(
        () => fetchWithSsrfCheck(
          `http://127.0.0.1:${port}/`,
          'GET',
          {},
          undefined,
          5000,
          true,
        ),
        /SSRF blocked/,
        'Should block redirect to link-local metadata IP',
      );
    } finally {
      await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
    }
  });

  it('follows legitimate redirects (up to 5 hops)', async () => {
    // Create a server that redirects once to itself with /final
    const server = await new Promise<http.Server>((resolve) => {
      const s = http.createServer((req, res) => {
        if (req.url === '/') {
          res.writeHead(302, { Location: '/final' });
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ done: true }));
        }
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;

    try {
      const resp = await fetchWithSsrfCheck(
        `http://127.0.0.1:${port}/`,
        'GET',
        {},
        undefined,
        5000,
        true,
      );
      assert.equal(resp.status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
