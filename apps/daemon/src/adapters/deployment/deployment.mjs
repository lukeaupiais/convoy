import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const origin = (value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Deployment public origin must be an absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('Deployment public origin must be an absolute HTTP(S) URL.');
  return parsed.origin;
};

export async function createDeploymentIdentity(directory, configuration) {
  const publicOrigin = origin(configuration?.publicOrigin);
  if (typeof configuration?.displayName !== 'string' || !configuration.displayName.trim())
    throw new Error('Deployment display name is required.');
  if (!Array.isArray(configuration.authenticationMethods) || !Array.isArray(configuration.capabilities))
    throw new Error('Deployment authentication methods and capabilities are required.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'deployment.json');
  let identity;
  try {
    identity = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    identity = { id: randomUUID(), publicOrigin };
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(identity), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  }
  if (identity.publicOrigin !== publicOrigin)
    throw new Error('Deployment public origin changed. Explicit identity migration is required.');
  if (typeof identity.id !== 'string' || !/^[a-f0-9-]{36}$/.test(identity.id))
    throw new Error('Persisted deployment identity is invalid.');
  return Object.freeze({
    id: identity.id,
    displayName: configuration.displayName.trim(),
    issuer: publicOrigin,
    publicOrigin,
    capabilities: [...configuration.capabilities],
    authenticationMethods: [...configuration.authenticationMethods],
    ...(configuration.minimumClientVersion
      ? { minimumClientVersion: configuration.minimumClientVersion }
      : {}),
  });
}
