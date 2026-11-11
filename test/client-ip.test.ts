import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from '../server/client-ip.ts';

const cloud = { originSecretSet: true, trustProxy: true };

test('behind CloudFront the address comes from the header CloudFront sets, not X-Forwarded-For', () => {
  const ip = clientIp({ 'x-portal-client-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, '10.0.0.1', cloud);
  assert.equal(ip, '203.0.113.9');
});

test('IPv6 addresses are accepted', () => {
  assert.equal(clientIp({ 'x-portal-client-ip': '2001:db8::1' }, '10.0.0.1', cloud), '2001:db8::1');
});

test('a value that is not an address is ignored', () => {
  assert.equal(clientIp({ 'x-portal-client-ip': 'evil, 1.1.1.1', 'x-forwarded-for': '198.51.100.4' }, '10.0.0.1', cloud), '198.51.100.4');
});

test('without the origin secret the header is not trusted (a direct caller could write it)', () => {
  const opts = { originSecretSet: false, trustProxy: false };
  assert.equal(clientIp({ 'x-portal-client-ip': '6.6.6.6', 'x-forwarded-for': '7.7.7.7' }, '192.0.2.1', opts), '192.0.2.1');
});

test('local installs: X-Forwarded-For only behind a trusted proxy, else the socket address', () => {
  assert.equal(clientIp({ 'x-forwarded-for': '198.51.100.4, 10.0.0.2' }, '10.0.0.2', { originSecretSet: false, trustProxy: true }), '198.51.100.4');
  assert.equal(clientIp({ 'x-forwarded-for': '198.51.100.4' }, '127.0.0.1', { originSecretSet: false, trustProxy: false }), '127.0.0.1');
  assert.equal(clientIp({}, undefined, { originSecretSet: false, trustProxy: false }), '');
});
