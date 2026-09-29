import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { withPage } = createRequire(import.meta.url)('../../docs/examples/browser-ui-investigation/scripts/browser-session.cjs');

test('browser helper preserves observations, redacts credentials and bounds evidence without extra requests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-browser-evidence-'));
  const page = new EventEmitter();
  page.url = () => 'http://service.invalid/requests/7';
  page.setDefaultTimeout = page.setDefaultNavigationTimeout = () => {};
  page.locator = () => ({ ariaSnapshot: async () => 'Request screen' });
  let closed = 0;
  globalThis.convoyEvidenceFixture = { page, close: () => closed++ };
  t.after(async () => { delete globalThis.convoyEvidenceFixture; await rm(directory, { recursive: true, force: true }); });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const modulePath = join(directory, 'browser.cjs');
  await writeFile(modulePath, `module.exports={chromium:{connectOverCDP:async()=>({contexts:()=>[{pages:()=>[globalThis.convoyEvidenceFixture.page]}],close:async()=>globalThis.convoyEvidenceFixture.close()})}}`);
  const evidenceDir = join(directory, 'evidence');
  const config = { modulePath, cdpEndpoint: 'http://service.invalid:9222', evidenceDir };
  const response = (url, data) => ({ url: () => url, request: () => ({ resourceType: () => 'xhr', method: () => 'GET' }), headers: () => ({ 'content-type': 'application/json' }), status: () => 200, text: async () => JSON.stringify(data) });
  await withPage(config, async p => {
    p.emit('response', response('http://outside.invalid/data', { forbidden: true }));
    p.emit('response', response('http://service.invalid/auth/login', { token: 'SECRET' }));
    p.emit('response', response('http://service.invalid/requests/7?token=SECRET', { data: { id: 7, assignedTeam: null, inheritedFrom: 'queue', credentials: 'SECRET', detail: { csrf: 'SECRET' }, status: 'open' } }));
  });
  const files = await readdir(evidenceDir);
  assert.equal(files.length, 1);
  const text = await readFile(join(evidenceDir, files[0]), 'utf8');
  assert.ok(!text.includes('SECRET'));
  const captured = JSON.parse(text);
  assert.equal(captured.responses.length, 1);
  assert.equal(captured.responses[0].body.data.assignedTeam, null);
  assert.equal(captured.responses[0].path, '/requests/7');
  assert.equal(closed, 1);
  assert.equal(page.listenerCount('response'), 0);
  await assert.rejects(withPage(config, async () => { throw Error('locator failed'); }), /locator failed/);
  assert.equal(closed, 2);
  assert.equal(page.listenerCount('response'), 0);
  await withPage(config, async p => {
    for (let i = 0; i < 24; i++) p.emit('response', response('http://service.invalid/requests/' + i, { data: { id: i, text: 'x'.repeat(6000) } }));
  });
  for (const file of await readdir(evidenceDir)) assert.ok((await readFile(join(evidenceDir, file))).length < 64000);
});
