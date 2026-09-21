import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createApp } from '../../apps/daemon/src/http/app.mjs';

test('runner enrollment redemption is public but only the single-use domain port is exposed', async (t) => {
  const calls = [];
  const app = createApp({
    runtime: {},
    auth: {},
    identitySessions: {
      async authenticate() {
        throw new Error('No user session');
      },
    },
    runnerEnrollment: {
      async redeem(input) {
        calls.push(input);
        return {
          runner: { id: 'runner-a' },
          machineCredential: 'rnr_secret-once',
        };
      },
    },
    access: {
      host: /^convoy\.example$/,
      origin: /^https:\/\/convoy\.example$/,
      requireAuthentication: true,
      secureCookies: true,
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.closeAllConnections();
    app.close();
  });

  const body = {
    token: 'one-time-token',
    organizationId: 'org-a',
    environmentId: 'environment-a',
    name: 'runner-a',
    repository: '/repo',
    attestation: { platform: 'linux', architecture: 'x64', tools: [] },
  };
  const response = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: app.address().port,
        path: '/runner-enrollments',
        method: 'POST',
        headers: { Host: 'convoy.example', 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.machineCredential, 'rnr_secret-once');
  assert.deepEqual(calls, [body]);
});
