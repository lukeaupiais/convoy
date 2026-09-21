import { join } from 'node:path';

export function desktopPaths({ appPath, userData, resourcesPath, packaged }) {
  return {
    daemonEntry: join(appPath, 'apps/daemon/src/bootstrap/index.mjs'),
    staticDirectory: join(appPath, 'dist'),
    dataDirectory: join(packaged ? userData : appPath, '.convoy'),
    workerDirectory: join(packaged ? resourcesPath : appPath, 'dist-worker'),
  };
}
