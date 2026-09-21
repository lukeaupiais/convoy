import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const xvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' }).status === 0;

async function waitFor(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

test(
  'desktop development serves Vite and restarts the daemon after a source edit',
  {
    skip:
      process.platform !== 'linux' ||
      !xvfb ||
      !existsSync(join(repository, 'node_modules/electron/dist/electron'))
        ? 'Requires installed Electron and Xvfb on Linux.'
        : false,
  },
  async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'convoy-desktop-dev-'));
    await mkdir(join(fixture, 'apps/daemon'), { recursive: true });
    await mkdir(join(fixture, 'scripts'));
    await cp(join(repository, 'apps/desktop'), join(fixture, 'apps/desktop'), {
      recursive: true,
    });
    await cp(join(repository, 'apps/daemon/src'), join(fixture, 'apps/daemon/src'), {
      recursive: true,
    });
    await cp(join(repository, 'scripts/desktop-dev.mjs'), join(fixture, 'scripts/desktop-dev.mjs'));
    await cp(join(repository, 'vite.config.ts'), join(fixture, 'vite.config.ts'));
    await cp(join(repository, 'package.json'), join(fixture, 'package.json'));
    await symlink(join(repository, 'apps/web'), join(fixture, 'apps/web'), 'dir');
    await symlink(join(repository, 'packages'), join(fixture, 'packages'), 'dir');
    await symlink(join(repository, 'node_modules'), join(fixture, 'node_modules'), 'dir');
    let output = '';
    const child = spawn('xvfb-run', ['-a', process.execPath, 'scripts/desktop-dev.mjs'], {
      cwd: fixture,
      env: { ...process.env, XDG_CONFIG_HOME: join(fixture, 'config') },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (bytes) => { output += bytes; });
    child.stderr.on('data', (bytes) => { output += bytes; });
    t.after(async () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      await rm(fixture, { recursive: true, force: true });
    });
    assert.equal(
      await waitFor(async () => {
        try {
          const ui = await fetch('http://127.0.0.1:5173/', { signal: AbortSignal.timeout(500) });
          const api = await fetch('http://127.0.0.1:5173/api/status', {
            signal: AbortSignal.timeout(500),
          });
          return ui.ok && api.ok && output.includes('Convoy desktop ready.');
        } catch { return false; }
      }),
      true,
      `Development desktop did not start. Output:\n${output.slice(-3000)}`,
    );
    await appendFile(join(fixture, 'apps/daemon/src/bootstrap/index.mjs'), '\n// watcher test\n');
    assert.equal(
      await waitFor(() => output.split('Convoy desktop ready.').length >= 3),
      true,
      `Desktop did not restart after daemon edit. Output:\n${output.slice(-3000)}`,
    );
    assert.match(output, /Backend changed; restarting Electron and the daemon/);
  },
);
