import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCredentialBroker } from '../../apps/daemon/src/adapters/auth/credential-broker.mjs';

test('credential broker encrypts local provider secrets and releases them only for an authorized purpose', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-credentials-'));
  const decisions = [];
  const broker = await createCredentialBroker(directory, {
    authorize: async (request) => {
      decisions.push(request);
      return request.organizationId === 'org_1' && request.purpose === 'generate';
    },
  });
  const reference = await broker.store({
    organizationId: 'org_1',
    providerConnectionId: 'connection_1',
    value: 'provider-secret-value',
  });

  const stored = await readFile(join(directory, 'provider-secrets.json'), 'utf8');
  assert.equal(stored.includes('provider-secret-value'), false);
  assert.equal(reference.kind, 'encrypted');
  await assert.rejects(
    broker.resolve({
      organizationId: 'org_1',
      providerConnectionId: 'connection_1',
      credentialRef: reference,
      purpose: 'inspect',
      actor: { kind: 'user', userId: 'user_1' },
    }),
    /not authorized/,
  );
  const credential = await broker.resolve({
    organizationId: 'org_1',
    providerConnectionId: 'connection_1',
    credentialRef: reference,
    purpose: 'generate',
    actor: { kind: 'user', userId: 'user_1' },
    sessionId: 'session_1',
    turnId: 'turn_1',
  });
  assert.equal(credential.value, 'provider-secret-value');
  assert.equal(credential.organizationId, 'org_1');
  assert.equal(credential.purpose, 'generate');
  assert.equal(decisions.length, 2);
});

test('credential broker resolves external references without persisting returned plaintext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-credentials-'));
  const broker = await createCredentialBroker(directory, {
    authorize: async () => true,
    resolveExternal: async (reference) => `resolved:${reference.reference}:${reference.version}`,
  });
  const credential = await broker.resolve({
    organizationId: 'org_1',
    providerConnectionId: 'connection_1',
    credentialRef: { kind: 'external', reference: 'vault://models/key', version: '7' },
    purpose: 'discover-models',
    actor: { kind: 'service-principal', servicePrincipalId: 'sp_1' },
  });
  assert.equal(credential.value, 'resolved:vault://models/key:7');
  await assert.rejects(readFile(join(directory, 'provider-secrets.json'), 'utf8'), /ENOENT/);
});

test('subscription OAuth is resolved on demand and never copied into broker storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-credentials-'));
  let active = true;
  let resolutions = 0;
  const broker = await createCredentialBroker(directory, {
    authorize: async () => true,
    resolveSubscription: async (reference) => {
      resolutions += 1;
      if (!active) throw new Error('Connect a Codex subscription first.');
      assert.deepEqual(reference, {
        kind: 'subscription',
        reference: 'chatgpt-oauth',
        version: '1',
      });
      return `refreshed-access-${resolutions}`;
    },
  });
  const request = {
    organizationId: 'personal',
    providerConnectionId: 'connection_personal_chatgpt_subscription',
    credentialRef: { kind: 'subscription', reference: 'chatgpt-oauth', version: '1' },
    purpose: 'generate',
    actor: { kind: 'user', userId: 'local' },
  };
  assert.equal((await broker.resolve(request)).value, 'refreshed-access-1');
  assert.equal((await broker.resolve(request)).value, 'refreshed-access-2');
  await assert.rejects(readFile(join(directory, 'provider-secrets.json'), 'utf8'), /ENOENT/);
  active = false;
  await assert.rejects(broker.resolve(request), /Connect a Codex subscription first/);
});

test('credential broker refuses connection and tenant substitution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-credentials-'));
  const broker = await createCredentialBroker(directory, { authorize: async () => true });
  const reference = await broker.store({
    organizationId: 'org_1',
    providerConnectionId: 'connection_1',
    value: 'secret',
  });
  await assert.rejects(
    broker.resolve({
      organizationId: 'org_2',
      providerConnectionId: 'connection_1',
      credentialRef: reference,
      purpose: 'generate',
      actor: { kind: 'user', userId: 'user_1' },
    }),
    /does not belong/,
  );
});

test('credential rotation can irreversibly invalidate the previous encrypted reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-credentials-'));
  const broker = await createCredentialBroker(directory, { authorize: async () => true });
  const oldReference = await broker.store({
    organizationId: 'org_1',
    providerConnectionId: 'connection_1',
    value: 'old-secret',
  });
  const newReference = await broker.store({
    organizationId: 'org_1',
    providerConnectionId: 'connection_1',
    value: 'new-secret',
  });

  await broker.delete({
    organizationId: 'org_1',
    providerConnectionId: 'connection_1',
    credentialRef: oldReference,
  });

  await assert.rejects(
    broker.resolve({
      organizationId: 'org_1',
      providerConnectionId: 'connection_1',
      credentialRef: oldReference,
      purpose: 'generate',
    }),
    /does not belong/,
  );
  assert.equal(
    (
      await broker.resolve({
        organizationId: 'org_1',
        providerConnectionId: 'connection_1',
        credentialRef: newReference,
        purpose: 'generate',
      })
    ).value,
    'new-secret',
  );
});
