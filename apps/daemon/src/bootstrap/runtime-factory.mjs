import { createPersistence } from '../adapters/persistence/index.mjs';
import { createRuntime as createControlPlaneRuntime } from '../control-plane/runtime.mjs';
import { initialControlPlaneState } from '../control-plane/state-schema.mjs';
import { defaultWorkflowDefinition } from '../modules/workflows/index.mjs';
import { createLinearTickets } from '../adapters/linear-tickets.mjs';
import { createCustomTicketSource } from '../adapters/custom-ticket-source.mjs';
import { createTicketSources } from '../adapters/ticket-sources.mjs';

/**
 * Filesystem composition for production, tests, and smoke scripts.
 * The control plane itself receives ports and knows nothing about paths.
 */
export async function createRuntime({ directory, legacyDirectory, persistenceBackend, databaseUrl, importLegacy, onPersistenceFailure, ...dependencies }) {
  if (!directory) throw new Error('A runtime state directory is required.');
  const persistence = await createPersistence({
    directory,
    legacyDirectory,
    initialState: initialControlPlaneState(defaultWorkflowDefinition),
    backend: persistenceBackend,
    databaseUrl,
    importLegacy,
    onFatal: onPersistenceFailure,
  });
  const externalTickets = createTicketSources({
    linear: createLinearTickets(),
    'custom-http': createCustomTicketSource({
      allowedPrivateOrigins: (process.env.CONVOY_TICKET_SOURCE_PRIVATE_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    }),
  });
  return createControlPlaneRuntime({ externalTickets, ...dependencies, persistence });
}
