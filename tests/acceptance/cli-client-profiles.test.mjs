import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const cli = join(process.cwd(), 'apps/cli/src/cli.mjs');

test('CLI connects a named deployment and persists an explicit organization context', async (t) => {
  const requests = [];
  let activeContext;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      client: request.headers['x-convoy-client'],
      body: body && JSON.parse(body),
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/.well-known/convoy') {
      response.end(
        JSON.stringify({
          id: '11111111-1111-4111-8111-111111111111',
          displayName: 'Local Team Convoy',
          issuer: origin,
          publicOrigin: origin,
          authenticationMethods: ['local-bootstrap'],
          capabilities: ['organizations'],
        }),
      );
      return;
    }
    if (request.method === 'POST') {
      activeContext = request.body;
      const command = JSON.parse(body);
      if (command.action === 'selectActiveContext')
        activeContext = {
          id: 'ctx_local',
          deploymentId: '11111111-1111-4111-8111-111111111111',
          ...command.context,
        };
      response.end(JSON.stringify({ ok: true, result: activeContext }));
      return;
    }
    response.end(
      JSON.stringify({
        activeContext,
        availableContexts: [
          {
            organizationId: 'org-local',
            organizationSlug: 'local-team',
            organizationDisplayName: 'Local Team',
            projectId: 'project-app',
            projectSlug: 'app',
            projectDisplayName: 'App',
            label: 'Local Team / App',
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = await mkdtemp(join(tmpdir(), 'convoy-cli-acceptance-'));
  const env = {
    ...process.env,
    CONVOY_CONFIG_HOME: config,
    CONVOY_TOKEN: 'client-access-token',
  };

  const connected = await exec(process.execPath, [cli, 'connect', origin, '--name', 'team'], {
    env,
  });
  assert.match(connected.stdout, /Connected profile team to Local Team Convoy/);
  const listed = await exec(process.execPath, [cli, 'profiles'], { env });
  assert.match(listed.stdout, /\* team\s+Local Team Convoy/);
  const contexts = await exec(process.execPath, [cli, 'context', 'list'], { env });
  assert.match(contexts.stdout, /local-team\/app\s+Local Team \/ App/);
  const selected = await exec(process.execPath, [cli, 'context', 'use', 'local-team/app'], { env });
  assert.match(selected.stdout, /Using Local Team \/ App/);
  const shown = await exec(process.execPath, [cli, 'context', 'show'], { env });
  assert.match(shown.stdout, /Local Team \/ App/);

  const apiRequests = requests.filter((request) => request.url === '/api/runtime');
  assert.ok(apiRequests.length >= 4);
  assert.ok(apiRequests.every((request) => request.authorization === 'Bearer client-access-token'));
  assert.equal(new Set(apiRequests.map((request) => request.client)).size, 1);
  assert.ok(
    requests
      .filter((request) => request.url === '/.well-known/convoy')
      .every((request) => request.authorization === undefined),
  );
  assert.deepEqual(
    apiRequests.filter((request) => request.body?.action === 'selectActiveContext').at(-1).body
      .context,
    { organizationId: 'org-local', projectId: 'project-app' },
  );
});

test('CLI bootstrap login stores its device session in the keychain and logout revokes it', async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      body: body && JSON.parse(body),
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/.well-known/convoy') {
      response.end(
        JSON.stringify({
          id: '44444444-4444-4444-8444-444444444444',
          displayName: 'Bootstrap Convoy',
          issuer: origin,
          publicOrigin: origin,
          authenticationMethods: ['local-bootstrap'],
          capabilities: ['organizations'],
        }),
      );
      return;
    }
    if (request.url === '/auth/bootstrap') {
      response.end(JSON.stringify({ accessToken: 'dvc_secure_session', tokenType: 'Bearer' }));
      return;
    }
    if (request.url === '/auth/logout') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'Not found.' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const directory = await mkdtemp(join(tmpdir(), 'convoy-cli-login-'));
  const bin = join(directory, 'bin');
  const keychain = join(directory, 'keychain.json');
  await mkdir(bin);
  const secretTool = join(bin, 'secret-tool');
  await writeFile(
    secretTool,
    `#!/bin/sh
KEYCHAIN=${JSON.stringify(keychain)}
case "$1" in
  lookup) test -f "$KEYCHAIN" && cat "$KEYCHAIN" ;;
  store) umask 077; cat > "$KEYCHAIN" ;;
  clear) rm -f "$KEYCHAIN" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(secretTool, 0o700);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CONVOY_CONFIG_HOME: join(directory, 'config'),
    CONVOY_BOOTSTRAP_TOKEN: 'one-time-secret',
  };

  await exec(process.execPath, [cli, 'connect', origin, '--name', 'bootstrap'], { env });
  const loggedIn = await exec(process.execPath, [cli, 'login'], { env });
  assert.match(loggedIn.stdout, /Logged in to Bootstrap Convoy/);
  assert.deepEqual(JSON.parse(await readFile(keychain, 'utf8')), {
    accessToken: 'dvc_secure_session',
  });
  assert.equal(
    (await readFile(join(directory, 'config', 'client-profiles.json'), 'utf8')).includes(
      'dvc_secure_session',
    ),
    false,
  );
  const bootstrap = requests.find((request) => request.url === '/auth/bootstrap');
  assert.equal(bootstrap.authorization, undefined);
  assert.equal(bootstrap.body.bootstrapToken, 'one-time-secret');

  const loggedOut = await exec(process.execPath, [cli, 'logout'], { env });
  assert.match(loggedOut.stdout, /Logged out of Bootstrap Convoy/);
  const logout = requests.find((request) => request.url === '/auth/logout');
  assert.equal(logout.authorization, 'Bearer dvc_secure_session');
  await assert.rejects(readFile(keychain, 'utf8'), { code: 'ENOENT' });
});
