import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';

function absoluteSetting(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

/** Installed builds provide explicit paths; source runs retain their existing state. */
export function daemonPaths(env = process.env) {
  const root = absoluteSetting(
    env.CONVOY_DATA_DIR,
    'CONVOY_DATA_DIR',
    fileURLToPath(new URL('../../../../.convoy/', import.meta.url)),
  );
  return {
    root,
    legacyDirectory: join(root, 'conversations'),
    staticDirectory: absoluteSetting(env.CONVOY_STATIC_DIR, 'CONVOY_STATIC_DIR'),
    workerDirectory: absoluteSetting(
      env.CONVOY_WORKER_ARTIFACT_DIR,
      'CONVOY_WORKER_ARTIFACT_DIR',
      fileURLToPath(new URL('../../../../dist-worker/', import.meta.url)),
    ),
  };
}
