import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../../apps/daemon/src/http/app.mjs';

test('client discovers deployment identity and supported authentication before login', async (t) => {
  const deployment = {
    id: 'dep-local',
    displayName: 'Local Convoy',
    issuer: 'http://127.0.0.1:4317',
    publicOrigin: 'http://127.0.0.1:4317',
    capabilities: ['organizations', 'provider-connections', 'remote-execution'],
    authenticationMethods: ['local-bootstrap'],
  };
  const app = createApp({
    runtime: { snapshot: async () => ({}), close: async () => {} },
    auth: { status: async () => ({ connected: false }) },
    deployment,
    access: { host: /^127\.0\.0\.1:\d+$/, origin: /^http:\/\/127\.0\.0\.1:\d+$/ },
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => {
    app.closeAllConnections();
    app.close();
  });

  const address = app.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/convoy`, {
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
  assert.deepEqual(await response.json(), deployment);
});
