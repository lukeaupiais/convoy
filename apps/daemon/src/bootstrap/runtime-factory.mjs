import { createPersistence } from '../adapters/persistence/index.mjs';
import { createRuntime as createControlPlaneRuntime } from '../control-plane/runtime.mjs';
import { initialControlPlaneState } from '../control-plane/state-schema.mjs';
import { createLinearTickets } from '../adapters/linear-tickets.mjs';
import { createCustomTicketSource } from '../adapters/custom-ticket-source.mjs';
import { createTicketSources } from '../adapters/ticket-sources.mjs';

/**
 * Filesystem composition for production, tests, and smoke scripts.
 * The control plane itself receives ports and knows nothing about paths.
 */
export async function createRuntime({ directory, legacyDirectory, persistenceBackend, databaseUrl, importLegacy, onPersistenceFailure, onStartupPhase = () => {}, ...dependencies }) {
  if (!directory) throw new Error('A runtime state directory is required.');
  onStartupPhase('Loading persisted runtime');
  const persistence = await createPersistence({
    directory,
    legacyDirectory,
    initialState: initialControlPlaneState(),
    backend: persistenceBackend,
    databaseUrl,
    importLegacy,
    onFatal: onPersistenceFailure,
    onStartupPhase,
  });
  const externalTickets = createTicketSources({
    linear: createLinearTickets(),
    'custom-http': createCustomTicketSource({
      allowedPrivateOrigins: (process.env.CONVOY_TICKET_SOURCE_PRIVATE_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    }),
  });
  onStartupPhase('Initializing control plane');
  return createControlPlaneRuntime({ externalTickets, ...dependencies, persistence });
}
