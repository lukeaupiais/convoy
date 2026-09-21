import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const electron = join(repository, 'node_modules/electron/dist/electron');
const xvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' }).status === 0;

test(
  'Electron entry starts its daemon and serves the built UI',
  {
    skip:
      process.platform !== 'linux' ||
      !xvfb ||
      !existsSync(electron) ||
      !existsSync(join(repository, 'dist/index.html'))
        ? 'Requires a built UI, installed Electron, and Xvfb on Linux.'
        : false,
  },
  async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'convoy-electron-entry-'));
    await symlink(join(repository, 'apps'), join(fixture, 'apps'), 'dir');
    await symlink(join(repository, 'dist'), join(fixture, 'dist'), 'dir');
    await writeFile(
      join(fixture, 'package.json'),
      JSON.stringify({
        name: 'convoy-electron-entry-test',
        version: '1.0.0',
        type: 'module',
        main: 'apps/desktop/main.mjs',
      }),
    );
    let output = '';
    const child = spawn('xvfb-run', ['-a', electron, fixture, '--no-sandbox'], {
      cwd: repository,
      env: { ...process.env, XDG_CONFIG_HOME: join(fixture, 'config') },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (bytes) => {
      output += bytes;
    });
    child.stderr.on('data', (bytes) => {
      output += bytes;
    });
    t.after(async () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
      await rm(fixture, { recursive: true, force: true });
    });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const status = await fetch('http://127.0.0.1:4317/api/status', {
          signal: AbortSignal.timeout(500),
        });
        const ui = await fetch('http://127.0.0.1:4317/', { signal: AbortSignal.timeout(500) });
        if (
          status.ok &&
          ui.ok &&
          (await ui.text()).includes('<html') &&
          output.includes('Convoy desktop ready.')
        ) {
          ready = true;
          break;
        }
      } catch {
        /* wait for startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    assert.equal(
      ready,
      true,
      `Electron did not start the daemon and UI. Output:\n${output.slice(-3000)}`,
    );
  },
);
