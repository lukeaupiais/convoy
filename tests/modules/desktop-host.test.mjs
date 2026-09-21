import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { daemonPaths } from '../../apps/daemon/src/bootstrap/paths.mjs';
import { desktopPaths } from '../../apps/desktop/paths.mjs';
import { launchDaemon, stopDaemon } from '../../apps/desktop/daemon-process.mjs';
import { externalWebLink } from '../../apps/desktop/links.mjs';

test('installed desktop paths isolate state and include bundled workers', () => {
  assert.deepEqual(desktopPaths({
    appPath: '/release/app.asar', userData: '/user/Convoy', resourcesPath: '/release', packaged: true,
  }), {
    daemonEntry: '/release/app.asar/apps/daemon/src/bootstrap/index.mjs',
    staticDirectory: '/release/app.asar/dist',
    dataDirectory: '/user/Convoy/.convoy',
    workerDirectory: '/release/dist-worker',
  });
  assert.equal(daemonPaths({ CONVOY_DATA_DIR: '/user/Convoy/.convoy' }).root, '/user/Convoy/.convoy');
  assert.throws(() => daemonPaths({ CONVOY_DATA_DIR: 'relative' }), /absolute/);
});

test('desktop daemon waits for readiness and requests graceful shutdown', async () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => assert.fail('graceful shutdown should not kill child');
  child.postMessage = (message) => {
    assert.deepEqual(message, { type: 'shutdown' });
    queueMicrotask(() => child.emit('exit', 0));
  };
  const start = launchDaemon(() => child, { entry: '/daemon', env: {}, cwd: '/', timeoutMs: 100 });
  child.emit('message', { type: 'ready', url: 'http://127.0.0.1:4317' });
  const { url } = await start;
  assert.equal(url, 'http://127.0.0.1:4317');
  await stopDaemon(child, 100);
});

test('desktop daemon reports startup failures and terminates the child', async () => {
  const child = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; };
  const start = launchDaemon(() => child, { entry: '/daemon', env: {}, cwd: '/', timeoutMs: 100 });
  child.emit('message', { type: 'startup-error', message: 'Address in use' });
  await assert.rejects(start, /Address in use/);
  assert.equal(killed, true);
});

test('desktop opens only credential-free HTTPS links externally', () => {
  assert.equal(externalWebLink('https://example.com/verify'), 'https://example.com/verify');
  assert.equal(externalWebLink('file:///etc/passwd'), null);
  assert.equal(externalWebLink('http://example.com'), null);
  assert.equal(externalWebLink('https://user:pass@example.com'), null);
});
