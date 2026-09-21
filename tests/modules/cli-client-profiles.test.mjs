import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MemoryCredentialStore,
  createClientProfiles,
  createSystemCredentialStore,
  normalizeDeploymentOrigin,
} from '../../apps/cli/src/client-profiles.mjs';
import { createDeploymentClient } from '../../apps/cli/src/deployment-client.mjs';

const discovery = (overrides = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Acme Convoy',
  issuer: 'https://convoy.acme.test',
  publicOrigin: 'https://convoy.acme.test',
  authenticationMethods: ['device-code'],
  capabilities: ['organizations'],
  ...overrides,
});

test('system credential store uses Linux Secret Service without putting secrets in argv', async () => {
  const calls = [];
  const store = createSystemCredentialStore({
    platform: 'linux',
    env: { PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    run: async (request) => {
      calls.push(request);
      if (request.args[0] === 'lookup')
        return { code: 0, output: '{"accessToken":"saved-linux-token"}\n' };
      return { code: 0, output: '' };
    },
  });

  await store.set('convoy:deployment:device', { accessToken: 'new-linux-token' });
  assert.deepEqual(await store.get('convoy:deployment:device'), {
    accessToken: 'saved-linux-token',
  });
  await store.delete('convoy:deployment:device');

  assert.deepEqual(
    calls.map(({ command, args }) => [command, args[0]]),
    [
      ['secret-tool', 'store'],
      ['secret-tool', 'lookup'],
      ['secret-tool', 'clear'],
    ],
  );
  assert.equal(calls[0].input, '{"accessToken":"new-linux-token"}');
  assert.equal(calls.flatMap((call) => call.args).includes('new-linux-token'), false);
});

test('system credential store uses macOS Keychain and pipes credential material over stdin', async () => {
  const calls = [];
  const store = createSystemCredentialStore({
    platform: 'darwin',
    env: { PATH: '/usr/bin' },
    run: async (request) => {
      calls.push(request);
      if (request.args[0] === 'find-generic-password')
        return {
          code: 0,
          output: `${Buffer.from('{"deviceCredential":"saved-macos-device"}').toString('base64')}\n`,
        };
      return { code: 0, output: '' };
    },
  });

  await store.set('convoy:deployment:device', { deviceCredential: 'new-macos-device' });
  assert.deepEqual(await store.get('convoy:deployment:device'), {
    deviceCredential: 'saved-macos-device',
  });
  await store.delete('convoy:deployment:device');

  assert.deepEqual(
    calls.map(({ command, args, input }) => [
      command,
      input?.startsWith('add-generic-password ') ? 'add-generic-password' : args[0],
    ]),
    [
      ['/usr/bin/security', 'add-generic-password'],
      ['/usr/bin/security', 'find-generic-password'],
      ['/usr/bin/security', 'delete-generic-password'],
    ],
  );
  assert.deepEqual(calls[0].args, ['-q', '-i']);
  const storedValue = calls[0].input.match(/-w ([A-Za-z0-9+/=]+)\n$/)[1];
  assert.equal(
    Buffer.from(storedValue, 'base64').toString('utf8'),
    '{"deviceCredential":"new-macos-device"}',
  );
  assert.equal(calls.flatMap((call) => call.args).includes('new-macos-device'), false);
});

test('system credential store uses Windows DPAPI CurrentUser without plaintext files or argv secrets', async () => {
  const calls = [];
  const store = createSystemCredentialStore({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' },
    credentialDirectory: 'C:\\Users\\Ada\\AppData\\Local\\Convoy\\credentials',
    run: async (request) => {
      calls.push(request);
      if (request.env.CONVOY_CREDENTIAL_OPERATION === 'get')
        return { code: 0, output: '{"accessToken":"saved-windows-token"}\n' };
      return { code: 0, output: '' };
    },
  });

  await store.set('convoy:deployment:device', { accessToken: 'new-windows-token' });
  assert.deepEqual(await store.get('convoy:deployment:device'), {
    accessToken: 'saved-windows-token',
  });
  await store.delete('convoy:deployment:device');

  assert.equal(
    calls.every((call) => call.command.endsWith('WindowsPowerShell\\v1.0\\powershell.exe')),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.env.CONVOY_CREDENTIAL_OPERATION),
    ['set', 'get', 'delete'],
  );
  assert.equal(calls[0].input, '{"accessToken":"new-windows-token"}');
  assert.equal(
    calls.flatMap((call) => call.args).some((arg) => arg.includes('new-windows-token')),
    false,
  );
  assert.match(calls[0].env.CONVOY_CREDENTIAL_PATH, /[a-f0-9]{64}\.bin$/);
  assert.equal(calls[0].env.CONVOY_CREDENTIAL_PATH.includes('deployment'), false);
});

test('system credential store fails closed on unsupported platforms and unavailable keychains', async () => {
  assert.throws(
    () => createSystemCredentialStore({ platform: 'aix' }),
    /supported OS credential store/,
  );
  const store = createSystemCredentialStore({
    platform: 'darwin',
    run: async () => {
      const error = new Error('spawn security ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  });
  await assert.rejects(
    store.set('convoy:deployment:device', { accessToken: 'secret' }),
    /OS keychain is unavailable/,
  );
});

test('deployment origins require HTTPS except on loopback', () => {
  assert.equal(normalizeDeploymentOrigin('https://convoy.acme.test/'), 'https://convoy.acme.test');
  assert.equal(normalizeDeploymentOrigin('http://localhost:4317'), 'http://localhost:4317');
  assert.equal(normalizeDeploymentOrigin('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(normalizeDeploymentOrigin('http://[::1]:4317'), 'http://[::1]:4317');
  assert.throws(() => normalizeDeploymentOrigin('http://convoy.acme.test'), /HTTPS/);
  assert.throws(
    () => normalizeDeploymentOrigin('https://user:secret@convoy.acme.test'),
    /credentials/,
  );
  assert.throws(() => normalizeDeploymentOrigin('https://convoy.acme.test/path'), /origin/);
});

test('connect discovers and pins a named deployment without persisting credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-cli-'));
  const file = join(directory, 'profiles.json');
  const credentials = new MemoryCredentialStore();
  const profiles = createClientProfiles({
    file,
    credentials,
    fetch: async (url, init) => {
      assert.equal(url, 'https://convoy.acme.test/.well-known/convoy');
      assert.equal(init.redirect, 'manual');
      return new Response(JSON.stringify(discovery()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
  });

  const profile = await profiles.connect('https://convoy.acme.test', { name: 'acme' });
  assert.deepEqual(profile, {
    name: 'acme',
    deploymentId: '11111111-1111-4111-8111-111111111111',
    serverOrigin: 'https://convoy.acme.test',
    displayName: 'Acme Convoy',
    trustedServerIdentity: '11111111-1111-4111-8111-111111111111@https://convoy.acme.test',
    deviceId: '22222222-2222-4222-8222-222222222222',
    secureCredentialReference:
      'convoy:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
  });
  assert.equal((await profiles.current()).name, 'acme');
  const persisted = await readFile(file, 'utf8');
  assert.equal(persisted.includes('access-token'), false);
  assert.equal(JSON.parse(persisted).profiles[0].name, 'acme');
});

test('connect fails closed when a saved origin presents another deployment identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-cli-'));
  let identity = discovery();
  const profiles = createClientProfiles({
    file: join(directory, 'profiles.json'),
    credentials: new MemoryCredentialStore(),
    fetch: async () => new Response(JSON.stringify(identity), { status: 200 }),
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
  });
  await profiles.connect('https://convoy.acme.test', { name: 'acme' });
  identity = discovery({ id: '33333333-3333-4333-8333-333333333333' });
  await assert.rejects(
    profiles.connect('https://convoy.acme.test', { name: 'acme' }),
    /identity changed/,
  );
});

test('profile context is selected explicitly and credentials remain in the credential store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-cli-'));
  const credentials = new MemoryCredentialStore();
  const profiles = createClientProfiles({
    file: join(directory, 'profiles.json'),
    credentials,
    fetch: async () => new Response(JSON.stringify(discovery()), { status: 200 }),
    randomUUID: () => '22222222-2222-4222-8222-222222222222',
  });
  const profile = await profiles.connect('https://convoy.acme.test', { name: 'acme' });
  await credentials.set(profile.secureCredentialReference, {
    accessToken: 'access-token',
    deviceCredential: 'device-token',
  });
  await profiles.selectContext('acme', {
    organizationId: 'org-acme',
    teamId: 'team-platform',
    projectId: 'project-payments',
  });

  assert.deepEqual((await profiles.current()).lastContext, {
    organizationId: 'org-acme',
    teamId: 'team-platform',
    projectId: 'project-payments',
  });
  assert.deepEqual(await profiles.credentialsFor(await profiles.current()), {
    accessToken: 'access-token',
    deviceCredential: 'device-token',
  });
  assert.equal(
    (await readFile(join(directory, 'profiles.json'), 'utf8')).includes('device-token'),
    false,
  );
  await profiles.clearCredentials('acme');
  assert.equal(await profiles.credentialsFor(await profiles.current()), undefined);
  await profiles.setCredentials('acme', { accessToken: 'replacement-token' });
  assert.deepEqual(await profiles.credentialsFor(await profiles.current()), {
    accessToken: 'replacement-token',
  });
});

test('deployment client authenticates, identifies the device, and revalidates saved context', async () => {
  const calls = [];
  const profile = {
    deploymentId: '11111111-1111-4111-8111-111111111111',
    serverOrigin: 'https://convoy.acme.test',
    trustedServerIdentity: '11111111-1111-4111-8111-111111111111@https://convoy.acme.test',
    deviceId: '22222222-2222-4222-8222-222222222222',
    lastContext: { organizationId: 'org-acme', projectId: 'project-payments' },
  };
  const client = createDeploymentClient({
    profile,
    credentials: { accessToken: 'access-token', deviceCredential: 'device-token' },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const value =
        calls.length === 1 ? discovery() : calls.length === 2 ? { ok: true } : { sessions: [] };
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.deepEqual(await client.api(), { sessions: [] });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://convoy.acme.test/.well-known/convoy');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    action: 'selectActiveContext',
    client: profile.deviceId,
    context: profile.lastContext,
  });
  for (const call of calls.slice(1)) {
    assert.equal(call.init.headers['X-Convoy-Client'], profile.deviceId);
    assert.equal(call.init.headers.Authorization, 'Bearer access-token');
    assert.equal(call.init.headers['X-Convoy-Device-Credential'], 'device-token');
  }
});

test('deployment client rejects redirect retargeting and non-JSON responses', async () => {
  const profile = {
    serverOrigin: 'https://convoy.acme.test',
    deviceId: '22222222-2222-4222-8222-222222222222',
  };
  const redirected = createDeploymentClient({
    profile,
    fetch: async () =>
      new Response(null, { status: 307, headers: { location: 'https://evil.test' } }),
  });
  await assert.rejects(redirected.api(), /redirect/);
  const nonJson = createDeploymentClient({
    profile,
    fetch: async () => new Response('<html>proxy login</html>', { status: 200 }),
  });
  await assert.rejects(nonJson.api(), /valid JSON/);
});

test('deployment bootstrap login verifies identity and never authenticates the public request', async () => {
  const calls = [];
  const profile = {
    deploymentId: '11111111-1111-4111-8111-111111111111',
    serverOrigin: 'https://convoy.acme.test',
    trustedServerIdentity: '11111111-1111-4111-8111-111111111111@https://convoy.acme.test',
    deviceId: '22222222-2222-4222-8222-222222222222',
  };
  const client = createDeploymentClient({
    profile,
    credentials: { accessToken: 'expired-token' },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify(
          calls.length === 1
            ? discovery({ authenticationMethods: ['bootstrap'] })
            : { accessToken: 'new-token', tokenType: 'Bearer' },
        ),
        { status: 200 },
      );
    },
  });

  assert.deepEqual(await client.bootstrap('one-time-bootstrap-token'), {
    accessToken: 'new-token',
    tokenType: 'Bearer',
  });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    deviceId: profile.deviceId,
    transport: 'bearer',
    bootstrapToken: 'one-time-bootstrap-token',
  });
});

test('deployment login reports unsupported advertised authentication precisely', async () => {
  const profile = {
    deploymentId: '11111111-1111-4111-8111-111111111111',
    serverOrigin: 'https://convoy.acme.test',
    trustedServerIdentity: '11111111-1111-4111-8111-111111111111@https://convoy.acme.test',
    deviceId: '22222222-2222-4222-8222-222222222222',
  };
  const client = createDeploymentClient({
    profile,
    fetch: async () =>
      new Response(
        JSON.stringify(discovery({ authenticationMethods: ['oidc-pkce', 'device-code'] })),
        { status: 200 },
      ),
  });
  await assert.rejects(
    client.bootstrap(),
    /advertises oidc-pkce, device-code authentication.*only bootstrap/,
  );
});
