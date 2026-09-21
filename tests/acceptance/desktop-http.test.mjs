import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/daemon/src/http/app.mjs';

test('installed UI shares the guarded daemon origin without intercepting API routes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-ui-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<html>Convoy</html>');
  await writeFile(join(directory, 'assets', 'app-123.js'), 'window.convoy = true;');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createApp({
    runtime: { snapshot: async () => ({ ready: true }) },
    auth: {},
    staticDirectory: directory,
    access: { host: /^127\.0\.0\.1:\d+$/, origin: /^http:\/\/127\.0\.0\.1:\d+$/ },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(base + path, {
    ...options,
    headers: { Host: '127.0.0.1:4317', ...options.headers },
  });

  const html = await request('/');
  assert.equal(html.status, 200);
  assert.equal(await html.text(), '<html>Convoy</html>');
  assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(html.headers.get('cache-control'), 'no-store');
  const asset = await request('/assets/app-123.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await request('/assets/app-123.js', { method: 'HEAD' })).status, 200);
  assert.equal((await request('/', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/assets/missing.js')).status, 404);
  assert.deepEqual(await (await request('/api/runtime')).json(), { ready: true });
});
