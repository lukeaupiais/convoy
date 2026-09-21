import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeploymentIdentity } from '../../apps/daemon/src/adapters/deployment/deployment.mjs';

test('deployment identity remains stable across daemon restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-deployment-'));
  const configuration = {
    displayName: 'Engineering Convoy',
    publicOrigin: 'https://convoy.example.test',
    authenticationMethods: ['oidc-pkce'],
    capabilities: ['organizations'],
  };
  const first = await createDeploymentIdentity(directory, configuration);
  const second = await createDeploymentIdentity(directory, configuration);

  assert.match(first.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(second, first);
  assert.equal(first.issuer, configuration.publicOrigin);
  const persisted = JSON.parse(await readFile(join(directory, 'deployment.json'), 'utf8'));
  assert.equal(persisted.id, first.id);
  assert.equal('authenticationMethods' in persisted, false);
});

test('deployment identity refuses origin changes that could retarget saved clients', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-deployment-'));
  await createDeploymentIdentity(directory, {
    displayName: 'Local',
    publicOrigin: 'http://127.0.0.1:4317',
    authenticationMethods: ['local-bootstrap'],
    capabilities: [],
  });
  await assert.rejects(
    createDeploymentIdentity(directory, {
      displayName: 'Local',
      publicOrigin: 'https://attacker.invalid',
      authenticationMethods: ['local-bootstrap'],
      capabilities: [],
    }),
    /origin changed/i,
  );
});
