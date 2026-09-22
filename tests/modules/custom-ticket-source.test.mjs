import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustomTicketSource,
  validateCustomTicketSourceManifest,
} from '../../apps/daemon/src/adapters/custom-ticket-source.mjs';

function manifest(overrides = {}) {
  return {
    apiVersion: 'convoy.dev/v1alpha1',
    kind: 'TicketSource',
    connection: {
      baseUrl: 'https://tickets.example.com/api',
      authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_TOKEN_TEST' },
    },
    operations: {
      list: {
        method: 'GET',
        path: '/tickets',
        query: { limit: '${limit}' },
        response: { items: '$.data.items' },
      },
      get: { method: 'GET', path: '/tickets/${remoteId}', response: { item: '$.data' } },
    },
    mapping: {
      remoteId: '$.id',
      remoteKey: '$.key',
      title: '$.subject',
      description: '$.body',
      status: '$.state',
      priority: '$.severity',
      remoteVersion: '$.version',
      updatedAt: '$.updatedAt',
      url: '$.url',
    },
    values: {
      status: { open: 'Backlog', active: 'In progress' },
      priority: { normal: 'Medium', urgent: 'High' },
    },
    ownership: {
      title: 'external',
      description: 'external',
      status: 'external',
      priority: 'external',
    },
    ...overrides,
  };
}

const resolver = async () => [{ address: '203.0.113.10', family: 4 }];
function credential(t, value) {
  const previous = process.env.CONVOY_TICKET_SOURCE_TOKEN_TEST;
  process.env.CONVOY_TICKET_SOURCE_TOKEN_TEST = value;
  t.after(() => {
    if (previous === undefined) delete process.env.CONVOY_TICKET_SOURCE_TOKEN_TEST;
    else process.env.CONVOY_TICKET_SOURCE_TOKEN_TEST = previous;
  });
}

test('custom ticket source maps a conventional JSON API into normalized tickets', async (t) => {
  credential(t, 'secret');
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(
      JSON.stringify({
        data: {
          items: [
            {
              id: 41,
              key: 'SUP-41',
              subject: 'Broken export',
              body: 'Steps',
              state: 'active',
              severity: 'urgent',
              version: 7,
              updatedAt: '2026-09-22T10:00:00Z',
              url: 'https://tickets.example.com/tickets/41',
            },
          ],
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  const adapter = createCustomTicketSource({ fetcher, resolver });
  const connection = { name: 'Support', manifest: manifest() };
  const result = await adapter.listIssues(connection, 10);
  assert.deepEqual(result, [
    {
      remoteId: '41',
      remoteKey: 'SUP-41',
      title: 'Broken export',
      description: 'Steps',
      status: 'In progress',
      priority: 'High',
      remoteVersion: '7',
      updatedAt: '2026-09-22T10:00:00Z',
      url: 'https://tickets.example.com/tickets/41',
      fieldOwnership: {
        title: 'external',
        description: 'external',
        status: 'external',
        priority: 'external',
      },
    },
  ]);
  assert.equal(requests[0].url, 'https://tickets.example.com/tickets?limit=10');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].options.redirect, 'error');
});

test('probe returns a bounded normalized sample without exposing credentials', async (t) => {
  credential(t, 'do-not-return');
  const adapter = createCustomTicketSource({
    resolver,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          data: {
            items: [
              {
                id: 'one',
                key: 'ONE',
                subject: 'Sample',
                body: '',
                state: 'open',
                severity: 'normal',
                version: 'v1',
              },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  });
  const result = await adapter.probe({ name: 'Mapped support', manifest: manifest() });
  assert.equal(result.sourceName, 'Mapped support');
  assert.equal(result.sample.remoteId, 'one');
  assert.doesNotMatch(JSON.stringify(result), /do-not-return/);
});

test('manifest validation rejects executable selectors and arbitrary authentication headers', () => {
  const executable = manifest();
  executable.mapping.title = '$..subject';
  assert.throws(() => validateCustomTicketSourceManifest(executable), /unsupported selector/);
  const header = manifest();
  header.connection.authentication = {
    type: 'header',
    credential: 'CONVOY_TICKET_SOURCE_HEADER_TEST',
    header: 'Authorization',
  };
  assert.throws(() => validateCustomTicketSourceManifest(header), /X- prefixed/);
});

test('adapter blocks private destinations unless the deployment explicitly allows the exact origin', async (t) => {
  credential(t, 'secret');
  const privateResolver = async () => [{ address: '10.0.0.4', family: 4 }];
  const blocked = createCustomTicketSource({
    resolver: privateResolver,
    fetcher: async () => {
      throw new Error('must not fetch');
    },
  });
  await assert.rejects(blocked.listIssues({ manifest: manifest() }, 1), /private or unavailable/);
  let called = false;
  const allowed = createCustomTicketSource({
    resolver: privateResolver,
    allowedPrivateOrigins: ['https://tickets.example.com'],
    fetcher: async () => {
      called = true;
      return new Response(JSON.stringify({ data: { items: [] } }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.deepEqual(await allowed.listIssues({ manifest: manifest() }, 1), []);
  assert.equal(called, true);
});

test('adapter rejects oversized pages and unmapped values before Work sees them', async (t) => {
  credential(t, 'secret');
  const item = {
    id: 'one',
    key: 'ONE',
    subject: 'Sample',
    body: '',
    state: 'unknown',
    severity: 'normal',
    version: 'v1',
  };
  const adapter = createCustomTicketSource({
    resolver,
    fetcher: async () =>
      new Response(JSON.stringify({ data: { items: [item] } }), {
        headers: { 'content-type': 'application/json' },
      }),
  });
  await assert.rejects(
    adapter.listIssues({ manifest: manifest() }, 1),
    /status value is not mapped/,
  );
});
