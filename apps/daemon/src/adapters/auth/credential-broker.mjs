import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PURPOSES = new Set(['inspect', 'discover-models', 'generate']);

async function optionalJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function masterKey(file) {
  try {
    const value = Buffer.from((await readFile(file, 'utf8')).trim(), 'base64');
    if (value.length !== 32) throw new Error('Credential broker key is invalid.');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = randomBytes(32);
    await writeFile(file, value.toString('base64'), { mode: 0o600, flag: 'wx' });
    return value;
  }
}

function seal(key, value, associatedData) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function unseal(key, record) {
  const associatedData = `${record.organizationId}\0${record.providerConnectionId}\0${record.id}`;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.nonce, 'base64'));
  decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export async function createCredentialBroker(
  directory,
  {
    authorize,
    resolveExternal,
    resolveWorkloadIdentity,
    resolveSubscription,
    now = () => Date.now(),
  } = {},
) {
  if (typeof authorize !== 'function') throw new Error('Credential authorization is required.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = await masterKey(join(directory, 'provider-secrets.key'));
  const file = join(directory, 'provider-secrets.json');
  const records = await optionalJson(file, []);
  if (!Array.isArray(records)) throw new Error('Credential broker store is invalid.');
  let writes = Promise.resolve();

  async function persist() {
    const temporary = `${file}.tmp`;
    writes = writes.then(async () => {
      await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
      await rename(temporary, file);
    });
    return writes;
  }

  return {
    async store({ organizationId, providerConnectionId, value }) {
      if (!organizationId || !providerConnectionId || typeof value !== 'string' || !value)
        throw new Error('Credential tenant, connection and value are required.');
      const id = randomUUID();
      const associatedData = `${organizationId}\0${providerConnectionId}\0${id}`;
      const protectedValue = seal(key, value, associatedData);
      records.push({ id, organizationId, providerConnectionId, ...protectedValue });
      await persist();
      return { kind: 'encrypted', reference: id, version: '1' };
    },
    async delete({ organizationId, providerConnectionId, credentialRef }) {
      if (credentialRef?.kind === 'none') return;
      if (credentialRef?.kind !== 'encrypted')
        throw new Error('Only broker-owned encrypted credentials can be deleted.');
      const index = records.findIndex(
        (candidate) =>
          candidate.id === credentialRef.reference &&
          candidate.organizationId === organizationId &&
          candidate.providerConnectionId === providerConnectionId,
      );
      if (index === -1)
        throw new Error('Credential does not belong to this organization and provider connection.');
      records.splice(index, 1);
      await persist();
    },
    async resolve(request) {
      if (!PURPOSES.has(request?.purpose)) throw new Error('Credential purpose is invalid.');
      if (!(await authorize(request))) throw new Error('Credential access is not authorized.');
      const reference = request.credentialRef;
      let value;
      if (reference?.kind === 'encrypted') {
        const record = records.find((candidate) => candidate.id === reference.reference);
        if (
          !record ||
          record.organizationId !== request.organizationId ||
          record.providerConnectionId !== request.providerConnectionId
        )
          throw new Error(
            'Credential does not belong to this organization and provider connection.',
          );
        value = unseal(key, record);
      } else if (reference?.kind === 'external') {
        if (typeof resolveExternal !== 'function')
          throw new Error('External secret resolution is not configured.');
        value = await resolveExternal(reference, request);
      } else if (reference?.kind === 'workload-identity') {
        if (typeof resolveWorkloadIdentity !== 'function')
          throw new Error('Workload identity resolution is not configured.');
        value = await resolveWorkloadIdentity(reference, request);
      } else if (reference?.kind === 'subscription') {
        if (typeof resolveSubscription !== 'function')
          throw new Error('Subscription credential resolution is not configured.');
        value = await resolveSubscription(reference, request);
      } else if (reference?.kind === 'none') {
        value = undefined;
      } else {
        throw new Error('Credential reference is invalid.');
      }
      if (value !== undefined && (typeof value !== 'string' || !value))
        throw new Error('Credential resolver returned an invalid value.');
      return Object.freeze({
        organizationId: request.organizationId,
        providerConnectionId: request.providerConnectionId,
        purpose: request.purpose,
        value,
        expiresAt: new Date(now() + 60_000).toISOString(),
      });
    },
  };
}
