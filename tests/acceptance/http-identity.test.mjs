import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createApp } from '../../apps/daemon/src/http/app.mjs';

const remoteAccess = {
  host: /^convoy\.example(?::\d+)?$/,
  origin: /^https:\/\/convoy\.example$/,
  requireAuthentication: true,
  secureCookies: true,
};

function identityFixture() {
  const active = new Map();
  let sequence = 0;
  return {
    port: {
      async bootstrap(input) {
        return issue(input);
      },
      async login(input) {
        return issue(input);
      },
      async authenticate(credential) {
        const value = active.get(credential);
        if (!value) throw new Error('Device session is not active.');
        return structuredClone(value);
      },
      async logout({ credential }) {
        active.delete(credential);
      },
      async identity({ principal, session }) {
        return {
          principal,
          session: { ...session, credentialHash: 'must-not-leak' },
          displayName: 'Ada',
          refreshToken: 'must-not-leak',
        };
      },
    },
    active,
  };

  function issue(input) {
    const credential = `secret-${++sequence}`;
    const result = {
      principal: { kind: 'user', userId: 'usr_ada' },
      session: { id: `dvs_${sequence}`, deviceId: input.deviceId },
    };
    active.set(credential, result);
    return { ...structuredClone(result), credential };
  }
}

async function serve(t, options) {
  const app = createApp(options);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.closeAllConnections();
    app.close();
  });
  const port = app.address().port;
  return (path, { method = 'GET', body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            Host: 'convoy.example',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text,
              json: () => (text ? JSON.parse(text) : undefined),
            });
          });
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

test('a remotely reachable HTTP transport refuses to start without deployment identity sessions', () => {
  assert.throws(
    () =>
      createApp({
        runtime: {},
        auth: {},
        access: remoteAccess,
      }),
    /identity session port/i,
  );
});

test('remote discovery and login stay public while runtime access fails closed', async (t) => {
  const identity = identityFixture();
  const runtimeCalls = [];
  const runtime = {
    snapshot: async (...args) => {
      runtimeCalls.push(['snapshot', ...args]);
      return { auth: { connected: false }, models: [] };
    },
    command: async (...args) => {
      runtimeCalls.push(['command', ...args]);
      return { accepted: true };
    },
  };
  const call = await serve(t, {
    runtime,
    auth: {},
    identitySessions: identity.port,
    deployment: { deploymentId: 'dep_remote', authenticationMethods: ['device-session'] },
    access: remoteAccess,
  });

  assert.equal((await call('/.well-known/convoy')).status, 200);
  assert.equal((await call('/api/runtime')).status, 401);
  assert.equal(
    (await call('/api/runtime', { headers: { Authorization: 'Basic unsafe' } })).status,
    401,
  );
  assert.equal(runtimeCalls.length, 0);

  const login = await call('/auth/session', {
    method: 'POST',
    body: { deviceId: 'cli-one' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.json().accessToken, 'secret-1');
  assert.equal(login.json().tokenType, 'Bearer');

  const authorization = { Authorization: `Bearer ${login.json().accessToken}` };
  const snapshot = await call('/api/runtime/7', { headers: authorization });
  assert.equal(snapshot.status, 200);
  assert.deepEqual(runtimeCalls[0], [
    'snapshot',
    '7',
    undefined,
    { kind: 'user', userId: 'usr_ada' },
  ]);
  const command = await call('/api/runtime', {
    method: 'POST',
    body: { action: 'heartbeat', client: 'desktop' },
    headers: { ...authorization, Origin: 'https://convoy.example' },
  });
  assert.equal(command.status, 200);
  assert.deepEqual(runtimeCalls[1], [
    'command',
    { action: 'heartbeat', client: 'desktop' },
    { kind: 'user', userId: 'usr_ada' },
  ]);
});

test('browser sessions use secure cookies, require a trusted mutation origin, and revoke on logout', async (t) => {
  const identity = identityFixture();
  const call = await serve(t, {
    runtime: {
      snapshot: async () => ({ auth: { connected: false }, models: [] }),
      command: async () => ({ accepted: true }),
    },
    auth: {},
    identitySessions: identity.port,
    access: { ...remoteAccess, allowBootstrap: true },
  });
  const bootstrap = await call('/auth/bootstrap', {
    method: 'POST',
    body: { displayName: 'Ada', deviceId: 'browser-one', transport: 'cookie' },
    headers: { Origin: 'https://convoy.example' },
  });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json().accessToken, undefined);
  assert.equal(bootstrap.text.includes('secret-1'), false);
  const setCookie = bootstrap.headers['set-cookie'][0];
  assert.match(setCookie, /^convoy_session=secret-1;/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  const cookie = setCookie.split(';', 1)[0];

  const identityResponse = await call('/identity', { headers: { Cookie: cookie } });
  assert.deepEqual(identityResponse.json(), {
    principal: { kind: 'user', userId: 'usr_ada' },
    session: { id: 'dvs_1', deviceId: 'browser-one' },
    displayName: 'Ada',
  });
  assert.equal(identityResponse.text.includes('secret-1'), false);

  assert.equal(
    (
      await call('/api/runtime', {
        method: 'POST',
        body: { action: 'heartbeat', client: 'browser' },
        headers: { Cookie: cookie },
      })
    ).status,
    403,
  );
  const logout = await call('/auth/logout', {
    method: 'POST',
    body: {},
    headers: { Cookie: cookie, Origin: 'https://convoy.example' },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.json(), { ok: true });
  assert.match(logout.headers['set-cookie'][0], /^convoy_session=;/);
  assert.equal((await call('/identity', { headers: { Cookie: cookie } })).status, 401);
});

test('remote bootstrap can require an exact out-of-band bootstrap token', async (t) => {
  const identity = identityFixture();
  const call = await serve(t, {
    runtime: {
      snapshot: async () => ({ auth: { connected: false }, models: [] }),
      command: async () => ({}),
    },
    auth: {},
    identitySessions: identity.port,
    access: {
      ...remoteAccess,
      allowBootstrap: true,
      bootstrapToken: 'a-long-one-time-bootstrap-secret',
    },
  });
  assert.equal(
    (
      await call('/auth/bootstrap', {
        method: 'POST',
        body: { deviceId: 'cli-one', bootstrapToken: 'wrong' },
      })
    ).status,
    403,
  );
  const response = await call('/auth/bootstrap', {
    method: 'POST',
    body: {
      deviceId: 'cli-one',
      bootstrapToken: 'a-long-one-time-bootstrap-secret',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json().accessToken, 'secret-1');
});

test('personal loopback transport remains compatible without deployment login', async (t) => {
  const calls = [];
  const call = await serve(t, {
    runtime: {
      snapshot: async (...args) => {
        calls.push(args);
        return { auth: { connected: true }, models: [] };
      },
      command: async () => ({}),
    },
    auth: {},
    access: {
      host: /^convoy\.example$/,
      origin: /^https:\/\/convoy\.example$/,
      requireAuthentication: false,
    },
  });
  assert.equal((await call('/api/status')).status, 200);
  assert.deepEqual(calls[0], [undefined, undefined, undefined]);
});
