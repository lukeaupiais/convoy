import { createPersistence } from '../adapters/persistence/index.mjs';
import { createRuntime as createControlPlaneRuntime } from '../control-plane/runtime.mjs';
import { initialControlPlaneState } from '../control-plane/state-schema.mjs';
import { defaultWorkflowDefinition } from '../modules/workflows/index.mjs';

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
  return createControlPlaneRuntime({ ...dependencies, persistence });
}
