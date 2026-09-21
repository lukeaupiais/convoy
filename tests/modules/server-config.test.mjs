import assert from 'node:assert/strict';
import test from 'node:test';
import { serverConfiguration } from '../../apps/daemon/src/adapters/deployment/server-config.mjs';

test('server configuration defaults to an unauthenticated loopback deployment', () => {
  const value = serverConfiguration({});
  assert.equal(value.listenHost, '127.0.0.1');
  assert.equal(value.port, 4317);
  assert.equal(value.publicOrigin, 'http://127.0.0.1:4317');
  assert.equal(value.access.requireAuthentication, false);
  assert.equal(value.access.secureCookies, false);
  assert.equal(value.access.allowBootstrap, true);
  assert.equal(value.access.host.test('127.0.0.1:4317'), true);
});

test('remote deployments require HTTPS, authentication, explicit origins and a bootstrap secret', () => {
  const value = serverConfiguration({
    CONVOY_PUBLIC_ORIGIN: 'https://convoy.example.com',
    CONVOY_LISTEN_HOST: '0.0.0.0',
    CONVOY_PORT: '8443',
    CONVOY_ALLOWED_ORIGINS: 'https://convoy.example.com,https://admin.example.com',
    CONVOY_BOOTSTRAP_TOKEN: 'a-long-one-time-bootstrap-secret',
  });
  assert.equal(value.listenHost, '0.0.0.0');
  assert.equal(value.port, 8443);
  assert.equal(value.access.requireAuthentication, true);
  assert.equal(value.access.secureCookies, true);
  assert.equal(value.access.allowBootstrap, true);
  assert.equal(value.access.bootstrapToken, 'a-long-one-time-bootstrap-secret');
  assert.equal(value.access.host.test('convoy.example.com'), true);
  assert.equal(value.access.origin.test('https://admin.example.com'), true);
  assert.equal(value.access.origin.test('https://attacker.example.com'), false);
});

test('remote deployment configuration fails closed', () => {
  assert.throws(
    () => serverConfiguration({ CONVOY_PUBLIC_ORIGIN: 'http://convoy.example.com' }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      serverConfiguration({
        CONVOY_PUBLIC_ORIGIN: 'https://convoy.example.com',
        CONVOY_ALLOWED_ORIGINS: '*',
      }),
    /origin/,
  );
  assert.throws(
    () =>
      serverConfiguration({
        CONVOY_PUBLIC_ORIGIN: 'https://convoy.example.com',
        CONVOY_ALLOW_BOOTSTRAP: 'true',
      }),
    /bootstrap token/,
  );
});
