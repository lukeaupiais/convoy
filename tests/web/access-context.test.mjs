import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../../apps/web/src/features/access/context-model.ts', import.meta.url),
  'utf8',
);
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { buildContextModel, invitationAdministrationModel, invitationLink, invitationToken } =
  await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

test('active context resolves deployment, organization, team, project, and user names', () => {
  const model = buildContextModel({
    deployment: { id: 'dep-1', displayName: 'Acme Convoy' },
    currentUser: { id: 'user-1', displayName: 'Ada' },
    activeContext: {
      deploymentId: 'dep-1',
      userId: 'user-1',
      organizationId: 'org-1',
      teamId: 'team-1',
      projectId: 'project-1',
    },
    organizations: [{ id: 'org-1', displayName: 'Acme Corp', state: 'active' }],
    teams: [
      { id: 'team-1', organizationId: 'org-1', displayName: 'Platform', state: 'active' },
      { id: 'team-2', organizationId: 'org-2', displayName: 'Other', state: 'active' },
    ],
    projects: [
      { id: 'project-1', organizationId: 'org-1', name: 'Payments' },
      { id: 'project-2', organizationId: 'org-2', name: 'Other project' },
    ],
  });

  assert.equal(model.authoritativeLabel, 'Acme Convoy / Acme Corp / Platform / Payments');
  assert.equal(model.userLabel, 'Ada');
  assert.deepEqual(
    model.teams.map((team) => team.id),
    ['team-1'],
  );
  assert.deepEqual(
    model.projects.map((project) => project.id),
    ['project-1'],
  );
  assert.equal(model.isManaged, true);
});

test('single-user snapshots retain a compact local fallback', () => {
  const model = buildContextModel({
    projects: [{ id: 'project-1', name: 'Convoy' }],
  });

  assert.equal(model.authoritativeLabel, 'Local Convoy / Convoy');
  assert.equal(model.deploymentName, 'Local Convoy');
  assert.equal(model.organizationName, undefined);
  assert.equal(model.isManaged, false);
});

test('active context reports the current user roles at each authority scope', () => {
  const model = buildContextModel({
    currentUser: { id: 'user-1', displayName: 'Ada' },
    activeContext: {
      organizationId: 'org-1',
      teamId: 'team-1',
      projectId: 'project-1',
    },
    organizations: [{ id: 'org-1', displayName: 'Acme', state: 'active' }],
    teams: [{ id: 'team-1', organizationId: 'org-1', displayName: 'Platform', state: 'active' }],
    projects: [{ id: 'project-1', organizationId: 'org-1', name: 'Payments' }],
    memberships: [
      {
        organizationId: 'org-1',
        principal: { kind: 'user', userId: 'user-1' },
        scope: { kind: 'organization', organizationId: 'org-1' },
        roles: ['member'],
        state: 'active',
      },
      {
        organizationId: 'org-1',
        principal: { kind: 'user', userId: 'user-1' },
        scope: { kind: 'team', teamId: 'team-1' },
        roles: ['admin'],
        state: 'active',
      },
      {
        organizationId: 'org-1',
        principal: { kind: 'user', userId: 'user-1' },
        scope: { kind: 'project', projectId: 'project-1' },
        roles: ['contributor'],
        state: 'active',
      },
    ],
  });

  assert.deepEqual(model.roleLabels, [
    'Organization: member',
    'Team: admin',
    'Project: contributor',
  ]);
});

test('invitation entry accepts a raw token or a Convoy invitation link', () => {
  assert.equal(invitationToken('  invite_secret  '), 'invite_secret');
  assert.equal(
    invitationToken('https://convoy.example/join?invitation=invite_link_secret'),
    'invite_link_secret',
  );
  assert.equal(
    invitationLink('https://convoy.example/control', 'inv+secret'),
    'https://convoy.example/?invitation=inv%2Bsecret',
  );
});

test('invitation administration exposes only valid current-tenant scopes and roles', () => {
  const state = {
    currentUser: { id: 'user-1', displayName: 'Ada' },
    activeContext: { organizationId: 'org-1', teamId: 'team-1', projectId: 'project-1' },
    memberships: [
      {
        organizationId: 'org-1',
        principal: { kind: 'user', userId: 'user-1' },
        scope: { kind: 'organization', organizationId: 'org-1' },
        roles: ['admin'],
        state: 'active',
      },
    ],
    organizations: [{ id: 'org-1', displayName: 'Acme', state: 'active' }],
    teams: [
      { id: 'team-1', organizationId: 'org-1', displayName: 'Platform', state: 'active' },
      { id: 'team-2', organizationId: 'org-2', displayName: 'Other', state: 'active' },
    ],
    projects: [
      { id: 'project-1', organizationId: 'org-1', name: 'Payments' },
      { id: 'project-2', organizationId: 'org-2', name: 'Other' },
    ],
    identityProviders: [
      { organizationId: 'org-1', verifiedDomains: ['acme.example', 'ACME.EXAMPLE'] },
      { organizationId: 'org-2', verifiedDomains: ['other.example'] },
    ],
  };

  const model = invitationAdministrationModel(state);
  assert.equal(model.canInvite, true);
  assert.deepEqual(model.scopes, [
    {
      value: 'organization:org-1',
      label: 'Organization · Acme',
      roles: ['owner', 'admin', 'security-admin', 'billing-admin', 'member', 'viewer'],
    },
    { value: 'team:team-1', label: 'Team · Platform', roles: ['admin', 'member', 'viewer'] },
    {
      value: 'project:project-1',
      label: 'Project · Payments',
      roles: ['owner', 'maintainer', 'contributor', 'viewer'],
    },
  ]);
  assert.deepEqual(model.verifiedDomains, ['acme.example']);
});

test('non-administrators cannot issue invitations from the web surface', () => {
  const model = invitationAdministrationModel({
    currentUser: { id: 'user-1' },
    activeContext: { organizationId: 'org-1', projectId: 'project-1' },
    memberships: [
      {
        organizationId: 'org-1',
        principal: { kind: 'user', userId: 'user-1' },
        scope: { kind: 'organization', organizationId: 'org-1' },
        roles: ['viewer'],
        state: 'active',
      },
    ],
    organizations: [],
    teams: [],
    projects: [],
    identityProviders: [],
  });

  assert.equal(model.canInvite, false);
  assert.match(model.permissionMessage, /invitation administrator/i);
});
