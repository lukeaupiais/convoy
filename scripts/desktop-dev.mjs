import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { createServer } from 'vite';

if (process.env.CONVOY_DEV_LAN)
  throw new Error('desktop:dev requires the loopback Vite server; unset CONVOY_DEV_LAN.');

const root = fileURLToPath(new URL('../', import.meta.url));
const watched = [
  join(root, 'apps/desktop'),
  join(root, 'apps/daemon/src'),
  join(root, 'packages/runner/src'),
];
const vite = await createServer({
  configFile: join(root, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
let child;
let stopping = false;
let restarting = false;
let restartTimer;

async function stopChild() {
  const current = child;
  child = undefined;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => current.kill('SIGKILL'), 8_000);
    current.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      current.stdin.write('shutdown\n');
    } catch {
      current.kill('SIGTERM');
    }
  });
}

function startChild() {
  child = spawn(electron, [root], {
    cwd: root,
    env: { ...process.env, CONVOY_DESKTOP_DEV: '1' },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  const current = child;
  current.on('exit', (code) => {
    if (current !== child || stopping) return;
    console.log(`Electron exited (code ${code ?? 'signal'}).`);
    void shutdown(code || 0);
  });
  current.on('error', (error) => {
    console.error('Could not launch Electron:', error);
    void shutdown(1);
  });
}

async function restart() {
  if (stopping || restarting) return;
  restarting = true;
  console.log('Backend changed; restarting Electron and the daemon...');
  await stopChild();
  if (!stopping) startChild();
  restarting = false;
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  await stopChild();
  await vite.close();
  process.exitCode = code;
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

try {
  await vite.listen();
  vite.watcher.add(watched);
  vite.watcher.on('change', (path) => {
    if (!path.endsWith('.mjs') || !watched.some((dir) => path.startsWith(`${dir}/`))) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => void restart(), 250);
  });
  console.log('Vite ready on http://127.0.0.1:5173; launching Electron.');
  startChild();
} catch (error) {
  console.error('Desktop development startup failed:', error);
  await shutdown(1);
}
