import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonEntry = fileURLToPath(new URL('../../apps/daemon/src/bootstrap/index.mjs', import.meta.url));

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startDaemon(root, staticDirectory, port) {
  const child = spawn(process.execPath, [daemonEntry], {
    env: {
      ...process.env,
      CONVOY_DATA_DIR: root,
      CONVOY_STATIC_DIR: staticDirectory,
      CONVOY_PORT: String(port),
      CONVOY_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => { output += bytes; });
  child.stderr.on('data', (bytes) => { output += bytes; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempts = 0; attempts < 80; attempts += 1) {
    if (child.exitCode !== null) throw new Error(`Daemon exited: ${output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return { child, url, response };
    } catch { /* wait for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`Daemon startup timed out: ${output}`);
}

async function stopDaemon(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
}

test('desktop daemon uses explicit state and static paths, then releases its lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-desktop-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staticDirectory = join(directory, 'web');
  const root = join(directory, 'state');
  await mkdir(staticDirectory);
  await writeFile(join(staticDirectory, 'index.html'), '<html>installed</html>');
  const port = await unusedPort();
  const first = await startDaemon(root, staticDirectory, port);
  t.after(() => first.child.kill('SIGTERM'));
  assert.equal(await first.response.text(), '<html>installed</html>');
  assert.equal((await readFile(join(root, 'daemon.lock'), 'utf8')).trim(), String(first.child.pid));
  assert.equal((await fetch(`${first.url}/api/status`)).status, 200);
  await stopDaemon(first.child);
  await assert.rejects(stat(join(root, 'daemon.lock')), { code: 'ENOENT' });
  const second = await startDaemon(root, staticDirectory, port);
  t.after(() => second.child.kill('SIGTERM'));
  assert.equal(await second.response.text(), '<html>installed</html>');
  await stopDaemon(second.child);
});
