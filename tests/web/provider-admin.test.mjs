import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/providers/provider-admin.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { providerAdministrationModel, modelRouteCandidateOptions } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
);

test('provider administration is visible only to an active organization owner or admin', () => {
  const base = {
    currentUser: { id: 'user-1' },
    activeContext: { organizationId: 'org-1' },
    organizations: [{ id: 'org-1', displayName: 'Acme' }],
    teams: [{ id: 'team-1', organizationId: 'org-1', displayName: 'Platform', state: 'active' }],
  };
  const admin = providerAdministrationModel({
    ...base,
    memberships: [
      {
        organizationId: 'org-1',
        principal: { kind: 'user', userId: 'user-1' },
        scope: { kind: 'organization', organizationId: 'org-1' },
        roles: ['admin'],
        state: 'active',
      },
    ],
  });
  const viewer = providerAdministrationModel({
    ...base,
    memberships: [
      {
        organizationId: 'org-1',
        principal: { kind: 'user', userId: 'user-1' },
        scope: { kind: 'organization', organizationId: 'org-1' },
        roles: ['viewer'],
        state: 'active',
      },
    ],
  });

  assert.equal(admin.canManage, true);
  assert.deepEqual(admin.owners, [
    { value: 'organization:org-1', label: 'Organization · Acme' },
    { value: 'team:team-1', label: 'Team · Platform' },
    { value: 'user:user-1', label: 'Personal · user-1' },
  ]);
  assert.equal(viewer.canManage, false);
  assert.match(viewer.permissionMessage, /organization owner or admin/i);
});

test('route candidates include only offerings published with a visible connection', () => {
  assert.deepEqual(
    modelRouteCandidateOptions(
      [
        { id: 'connection-1', displayName: 'OpenAI', state: 'ready' },
        { id: 'connection-2', displayName: 'Revoked', state: 'revoked' },
      ],
      [
        {
          id: 'offering-1',
          providerConnectionId: 'connection-1',
          displayName: 'GPT-5',
          availability: 'available',
        },
        {
          id: 'offering-2',
          providerConnectionId: 'missing',
          displayName: 'Hidden',
          availability: 'available',
        },
        {
          id: 'offering-3',
          providerConnectionId: 'connection-1',
          displayName: 'Not verified',
          availability: 'unverified',
        },
        {
          id: 'offering-4',
          providerConnectionId: 'connection-1',
          displayName: 'Temporarily unavailable',
          availability: 'unavailable',
        },
      ],
    ),
    [
      {
        value: 'connection-1:offering-1',
        connectionId: 'connection-1',
        offeringId: 'offering-1',
        label: 'OpenAI · GPT-5 (available)',
      },
    ],
  );
});
