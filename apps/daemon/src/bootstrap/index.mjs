import { createApp } from '../http/app.mjs';
import { models, generate, provider } from '../adapters/providers/provider.mjs';
import { createCodexSubscriptionProvider } from '../adapters/providers/codex-subscription.mjs';
import { createAuth } from '../adapters/auth/auth.mjs';
import { createCredentialBroker } from '../adapters/auth/credential-broker.mjs';
import { createDeploymentIdentity } from '../adapters/deployment/deployment.mjs';
import { serverConfiguration } from '../adapters/deployment/server-config.mjs';
import { createOpenAICompatibleProvider } from '../adapters/providers/openai-compatible.mjs';
import { createProviderAdapterRegistry } from '../adapters/providers/registry.mjs';
import { createWorkerDeployment } from '../adapters/runners/worker-deployment.mjs';
import { createRunners } from '../adapters/runners/runners.mjs';
import { createRuntime } from './runtime-factory.mjs';
import { daemonPaths } from './paths.mjs';
import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

let server;
let auth;
let runtime;
let lockPath;
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    auth?.close();
    await runtime?.close();
    if (lockPath) await unlink(lockPath);
  } catch (error) {
    console.error('Convoy daemon shutdown failed:', error);
    code = 1;
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.parentPort?.on('message', (event) => {
  if (event.data?.type === 'shutdown') void shutdown();
});

async function main() {
  const { root, legacyDirectory, staticDirectory, workerDirectory } = daemonPaths();
  const configuration = serverConfiguration();
  if (staticDirectory) await access(join(staticDirectory, 'index.html'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const candidateLockPath = join(root, 'daemon.lock');
  try {
    const pid = Number(await readFile(candidateLockPath, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new Error('Another Convoy daemon may be running. Refusing concurrent state writers.');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      await unlink(candidateLockPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const lock = await open(candidateLockPath, 'wx', 0o600);
  lockPath = candidateLockPath;
  try {
    await lock.writeFile(String(process.pid));
  } finally {
    await lock.close();
  }

  auth = await createAuth(root);
  const deployment = await createDeploymentIdentity(root, {
    displayName: process.env.CONVOY_DISPLAY_NAME ?? 'Local Convoy',
    publicOrigin: configuration.publicOrigin,
    capabilities: ['organizations', 'provider-connections', 'remote-execution'],
    authenticationMethods: configuration.access.requireAuthentication
      ? ['device-session', ...(configuration.access.allowBootstrap ? ['bootstrap'] : [])]
      : ['local-bootstrap'],
  });
  const providerAdapters = createProviderAdapterRegistry({
    'openai-codex-subscription': () => createCodexSubscriptionProvider(),
    'openai-compatible': ({ connection }) =>
      createOpenAICompatibleProvider({
        id: connection.providerId,
        name: connection.id,
        endpoint: connection.endpoint?.origin ?? connection.endpoint,
      }),
  });
  runtime = await createRuntime({
    directory: join(root, 'runtime'),
    legacyDirectory,
    models,
    generate,
    provider,
    auth,
    runners: createRunners({ deployment: createWorkerDeployment({ directory: workerDirectory }) }),
    deployment,
    providerAdapters,
    credentialBrokerFactory: ({ authorize, resolveSubscription }) =>
      createCredentialBroker(join(root, 'credentials'), { authorize, resolveSubscription }),
  });
  server = createApp({
    runtime,
    auth,
    identitySessions: runtime.identitySessions,
    runnerEnrollment: runtime.runnerEnrollment,
    deployment,
    access: configuration.access,
    staticDirectory,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(configuration.port, configuration.listenHost, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.log(`Convoy durable daemon: ${configuration.publicOrigin}`);
  process.parentPort?.postMessage({ type: 'ready', url: configuration.publicOrigin });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Daemon startup failed.';
  process.parentPort?.postMessage({ type: 'startup-error', message });
  console.error(`Convoy daemon startup failed: ${message}`);
  await shutdown(1);
}
