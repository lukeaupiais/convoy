import { app, BrowserWindow, dialog, session, shell, utilityProcess } from 'electron';
import { desktopPaths } from './paths.mjs';
import { launchDaemon, stopDaemon } from './daemon-process.mjs';
import { externalWebLink } from './links.mjs';
import { createInterface } from 'node:readline';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error('Convoy is already running. Close the other window before starting another desktop session.');
  app.exit(1);
} else {
  let window;
  let daemon;
  let quitting = false;
  const development = !app.isPackaged && process.env.CONVOY_DESKTOP_DEV === '1';
  const daemonOrigin = 'http://127.0.0.1:4317';
  const rendererOrigin = development ? 'http://127.0.0.1:5173' : daemonOrigin;

  if (development) {
    const commands = createInterface({ input: process.stdin });
    commands.on('line', (line) => {
      if (line === 'shutdown') app.quit();
    });
    app.on('will-quit', () => commands.close());
  }

  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (!daemon || quitting) return;
    event.preventDefault();
    quitting = true;
    void stopDaemon(daemon).finally(() => {
      daemon = null;
      app.quit();
    });
  });

  async function start() {
    try {
      const paths = desktopPaths({
        appPath: app.getAppPath(),
        userData: app.getPath('userData'),
        resourcesPath: process.resourcesPath,
        packaged: app.isPackaged,
      });
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const daemonEnv = {
        ...process.env,
        CONVOY_DATA_DIR: paths.dataDirectory,
        CONVOY_WORKER_ARTIFACT_DIR: paths.workerDirectory,
        CONVOY_LISTEN_HOST: '127.0.0.1',
        CONVOY_PORT: '4317',
        CONVOY_PUBLIC_ORIGIN: daemonOrigin,
        CONVOY_ALLOWED_ORIGINS: development
          ? `${daemonOrigin},${rendererOrigin}`
          : daemonOrigin,
      };
      if (development) delete daemonEnv.CONVOY_STATIC_DIR;
      else daemonEnv.CONVOY_STATIC_DIR = paths.staticDirectory;
      const started = await launchDaemon(
        (entry, args, options) => utilityProcess.fork(entry, args, options),
        {
          entry: paths.daemonEntry,
          cwd: app.isPackaged ? process.resourcesPath : app.getAppPath(),
          env: daemonEnv,
          onExit(code) {
            if (quitting) return;
            window?.destroy();
            dialog.showErrorBox(
              'Convoy stopped',
              `The daemon exited (code ${code}). Inspect its output before retrying an interrupted operation.`,
            );
            app.quit();
          },
        },
      );
      daemon = started.child;
      if (started.url !== daemonOrigin)
        throw new Error('Convoy daemon reported an unexpected origin.');
      window = new BrowserWindow({
        title: 'Convoy',
        width: 1440,
        height: 900,
        minWidth: 900,
        minHeight: 640,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false,
        },
      });
      const openExternalLink = (value) => {
        const safe = externalWebLink(value);
        if (safe) void shell.openExternal(safe);
      };
      window.webContents.setWindowOpenHandler(({ url }) => {
        openExternalLink(url);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (url === rendererOrigin || url === `${rendererOrigin}/`) return;
        event.preventDefault();
        openExternalLink(url);
      });
      await window.loadURL(rendererOrigin);
      window.show();
      console.log('Convoy desktop ready.');
    } catch (error) {
      console.error('Convoy desktop startup failed:', error);
      dialog.showErrorBox(
        'Convoy could not start',
        error instanceof Error ? error.message : 'Desktop startup failed.',
      );
      app.quit();
    }
  }

  // Electron must finish evaluating this ESM entry before its ready event can fire.
  void app.whenReady().then(start);
}
