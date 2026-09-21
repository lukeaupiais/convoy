import { createApp } from '../http/app.mjs';
import { models, generate, provider } from '../adapters/providers/provider.mjs';
import { createCodexSubscriptionProvider } from '../adapters/providers/codex-subscription.mjs';
import { createAuth } from '../adapters/auth/auth.mjs';
import { createCredentialBroker } from '../adapters/auth/credential-broker.mjs';
import { createDeploymentIdentity } from '../adapters/deployment/deployment.mjs';
import { serverConfiguration } from '../adapters/deployment/server-config.mjs';
import { createOpenAICompatibleProvider } from '../adapters/providers/openai-compatible.mjs';
import { createProviderAdapterRegistry } from '../adapters/providers/registry.mjs';
import { createRuntime } from './runtime-factory.mjs';
import { createRunners } from '../adapters/runners/runners.mjs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
const directory = new URL('../../../../.convoy/conversations', import.meta.url).pathname;
const root = new URL('../../../../.convoy', import.meta.url).pathname;
const serverConfigurationValue = serverConfiguration();
await mkdir(root, { recursive: true, mode: 0o700 });
const lockPath = root + '/daemon.lock';
try { const pid = Number(await readFile(lockPath, 'utf8')); try { process.kill(pid, 0); throw new Error('Another Convoy daemon may be running. Refusing concurrent state writers.'); } catch (e) { if (e.code !== 'ESRCH') throw e; await unlink(lockPath); } } catch (e) { if (e.code !== 'ENOENT') throw e; }
const lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(String(process.pid)); await lock.close();
const auth = await createAuth(root);
const deployment = await createDeploymentIdentity(root, {
  displayName: process.env.CONVOY_DISPLAY_NAME ?? 'Local Convoy',
  publicOrigin: serverConfigurationValue.publicOrigin,
  capabilities: ['organizations', 'provider-connections', 'remote-execution'],
  authenticationMethods: serverConfigurationValue.access.requireAuthentication
    ? ['device-session', ...(serverConfigurationValue.access.allowBootstrap ? ['bootstrap'] : [])]
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
const runtime = await createRuntime({
  directory: root + '/runtime',
  legacyDirectory: directory,
  models,
  generate,
  provider,
  auth,
  runners: createRunners(),
  deployment,
  providerAdapters,
  credentialBrokerFactory: ({ authorize, resolveSubscription }) =>
    createCredentialBroker(root + '/credentials', { authorize, resolveSubscription }),
});
const server = createApp({
  runtime,
  auth,
  identitySessions: runtime.identitySessions,
  runnerEnrollment: runtime.runnerEnrollment,
  deployment,
  access: serverConfigurationValue.access,
});
server.listen(serverConfigurationValue.port, serverConfigurationValue.listenHost, () =>
  console.log(`Convoy durable daemon: ${serverConfigurationValue.publicOrigin}`),
);
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; server.close(); auth.close(); await runtime.close(); await unlink(lockPath); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
