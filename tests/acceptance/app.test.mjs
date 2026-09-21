import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApp } from '../../apps/daemon/src/http/app.mjs';

test('HTTP is a guarded transport over durable runtime and auth ports', async (t) => {
  const commands = [];
  const runtime = {
    snapshot: async (id) => ({
      auth: { connected: true },
      models: [{ id: 'test-model' }],
      selected: id,
    }),
    command: async (value) => {
      commands.push(value);
      if (value.action === 'fail') throw new Error('Rejected command.');
      return { accepted: value.action };
    },
    readContext: async (_sessionId, id) =>
      id === 'a'.repeat(64)
        ? { meta: { mime: 'text/plain', name: 'proof.txt' }, bytes: Buffer.from('proof') }
        : Promise.reject(new Error('Missing')),
    readTicketFile: async (_ticketId, id) =>
      id === 'a'.repeat(64)
        ? { meta: { mime: 'text/plain', name: 'scope.md' }, bytes: Buffer.from('scope') }
        : Promise.reject(new Error('Missing')),
    subscribe: () => () => {},
  };
  const auth = {
    connect: async () => ({ connected: true }),
    login: async () => ({ state: 'waiting' }),
    disconnect: async () => ({ connected: false }),
  };
  const server = createApp({ runtime, auth });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body, extra = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        url + path,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Host: '127.0.0.1:4317',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...extra,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: () => bytes.toString(),
              json: () => JSON.parse(bytes.toString()),
            });
          });
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });

  assert.equal(
    (await call('/api/status', undefined, { Origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal((await call('/api/status', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await call('/api/runtime', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.deepEqual((await call('/api/status')).json(), {
    connected: true,
    models: [{ id: 'test-model' }],
  });
  assert.equal((await call('/api/runtime/7')).json().selected, '7');
  assert.deepEqual(
    (await call('/api/runtime', { action: 'heartbeat', client: 'browser-client' })).json(),
    { ok: true, result: { accepted: 'heartbeat' } },
  );
  assert.equal(commands.length, 1);
  assert.equal(
    (await call('/api/runtime', { action: 'fail', client: 'browser-client' })).status,
    400,
  );
  assert.equal((await call('/api/auth/connect', {})).status, 410);
  assert.equal((await call('/api/auth/unknown', {})).status, 404);
  const context = await call(`/api/context/7/${'a'.repeat(64)}`);
  assert.equal(context.status, 200);
  assert.equal(context.text(), 'proof');
  assert.equal(context.headers['x-content-type-options'], 'nosniff');
  assert.equal((await call(`/api/context/7/${'b'.repeat(64)}`)).status, 404);
  const ticketFile = await call(`/api/tickets/7/attachments/${'a'.repeat(64)}`);
  assert.equal(ticketFile.status, 200);
  assert.equal(ticketFile.text(), 'scope');
  assert.equal((await call(`/api/tickets/7/attachments/${'b'.repeat(64)}`)).status, 404);
  assert.equal((await call('/api/conversations/1')).status, 410);
  assert.equal((await call('/api/connect', {})).status, 410);
});
