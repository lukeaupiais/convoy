import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/providers/provider-inventory.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { providerConnectionRows, modelRouteRows } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

test('provider inventory exposes governed metadata without secret references', () => {
  const rows = providerConnectionRows(
    [
      {
        id: 'connection-1',
        providerId: 'openai',
        displayName: 'Organization OpenAI',
        owner: { kind: 'organization', organizationId: 'org-1' },
        endpoint: { origin: 'https://api.openai.com', region: 'us' },
        credentialRef: { kind: 'encrypted', reference: 'vault/very-secret' },
        state: 'ready',
        governance: { maximumConcurrency: 4, monthlyBudgetUsd: 250 },
        lastProbeAt: '2026-09-20T12:00:00.000Z',
      },
    ],
    [{ id: 'offering-1', providerConnectionId: 'connection-1', availability: 'available' }],
  );

  assert.deepEqual(rows, [
    {
      id: 'connection-1',
      name: 'Organization OpenAI',
      providerId: 'openai',
      owner: 'Organization',
      endpoint: 'https://api.openai.com · us',
      state: 'ready',
      offeringSummary: '1 model · 1 available',
      governance: '4 concurrent · $250 monthly budget',
      lastProbeAt: '2026-09-20T12:00:00.000Z',
    },
  ]);
  assert.equal(JSON.stringify(rows).includes('very-secret'), false);
});

test('model route inventory summarizes fallback and candidate health without mutation controls', () => {
  const rows = modelRouteRows(
    [
      {
        id: 'route-1',
        name: 'Coding',
        purposes: ['coding', 'review'],
        candidates: [
          { connectionId: 'connection-1', offeringId: 'offering-1' },
          { connectionId: 'connection-2', offeringId: 'offering-2' },
        ],
        policy: { fallback: 'not-sent', maximumEstimatedCostUsdPerTurn: 0.25 },
        state: 'active',
      },
    ],
    [
      { id: 'offering-1', displayName: 'GPT', availability: 'available' },
      { id: 'offering-2', displayName: 'Local', availability: 'degraded' },
    ],
  );

  assert.deepEqual(rows, [
    {
      id: 'route-1',
      name: 'Coding',
      purposes: 'coding, review',
      state: 'active',
      candidates: 'GPT (available) -> Local (degraded)',
      fallback: 'not sent',
      limit: '$0.25 maximum estimated cost per turn',
    },
  ]);
});
