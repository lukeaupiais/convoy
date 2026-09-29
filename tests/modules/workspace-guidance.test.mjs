import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkspaceGuidance,
  createPromptContext,
} from '../../apps/daemon/src/modules/agents/index.mjs';
import { createCapabilities } from '../../apps/daemon/src/modules/library/index.mjs';
import { createExecutionPolicy } from '../../apps/daemon/src/modules/execution/index.mjs';
import { digest } from '../../packages/runner/src/index.mjs';

function fixture() {
  const session = {
    id: 'chat',
    instructions: [],
    workspace: { path: '/workspace' },
    runnerId: 'r',
    assignment: { token: 'a', state: 'running', policyDigest: 'grant' },
    capabilityProfile: {
      id: 'investigate',
      version: 1,
      hash: 'profile',
      loadWorkspaceAgentsMd: true,
    },
  };
  const guidance = createWorkspaceGuidance();
  return { session, guidance };
}

test('guidance preserves captures across resume and profile revisions, and retires disabled captures', () => {
  const { session: s, guidance: g } = fixture();
  const first = g.request(s);
  g.complete(s, first, { status: 'loaded', hash: 'bytes', contentId: 'content' });
  assert.equal(g.request(s), null);
  s.capabilityProfile = { ...s.capabilityProfile, version: 2, hash: 'next' };
  assert.equal(g.request(s), null);
  assert.equal(g.view(s).profile.version, 2);
  s.capabilityProfile.loadWorkspaceAgentsMd = false;
  assert.equal(g.view(s).status, 'disabled');
  g.request(s);
  s.capabilityProfile.loadWorkspaceAgentsMd = true;
  assert.equal(g.view(s).status, 'pending');
  assert.ok(g.request(s));
  assert.equal(s.workspaceGuidanceHistory[0].contentId, 'content');
});

test('new assignment and explicit refresh capture again; stale results never commit', () => {
  const { session: s, guidance: g } = fixture();
  const first = g.request(s);
  g.complete(s, first, { status: 'missing' });
  assert.equal(g.request(s), null);
  const refreshed = g.request(s, true);
  assert.notEqual(refreshed.id, first.id);
  s.assignment.token = 'replacement';
  assert.throws(() => g.complete(s, refreshed, { status: 'loaded' }), /stale/);
  assert.equal(g.view(s).status, 'pending');
  const newRequest = g.request(s);
  s.capabilityProfile.hash = 'changed';
  assert.throws(() => g.complete(s, newRequest, { status: 'loaded' }), /stale/);
});

test('root guidance remains subordinate, epoch-pinned and available after checkpoint', () => {
  const { session: s, guidance: g } = fixture();
  g.complete(s, g.request(s), { status: 'loaded', hash: 'bytes' });
  const prompt = createPromptContext({ digest, workspaceGuidance: g });
  const first = prompt.compile({ session: s, guidanceText: 'Use modules/widget.' });
  assert.match(first.turnInstructions, /subordinate/);
  assert.match(first.turnInstructions, /Use modules\/widget/);
  assert.match(first.systemPrompt, /native CLI/);
  s.messages = [];
  assert.equal(
    prompt.compile({ session: s, guidanceText: 'Use modules/widget.' }).epoch.id,
    first.epoch.id,
  );
  s.capabilityProfile.loadWorkspaceAgentsMd = false;
  const off = prompt.compile({ session: s, guidanceText: 'Use modules/widget.' });
  assert.notEqual(off.epoch.id, first.epoch.id);
  assert.doesNotMatch(off.systemPrompt, /Use modules\/widget/);
});

test('inspect authority and selected shell intersect without changing legacy profile hashes', () => {
  const state = {
    projects: [{ id: 'p', executionProfile: 'inspect' }],
    tickets: [],
    sessions: {},
    runners: [],
  };
  const policy = createExecutionPolicy({
    state,
    catalog: { ticket: () => undefined, project: () => state.projects[0] },
  });
  const c = createCapabilities({ state, executionPolicy: policy });
  const old = {
    id: 'old',
    version: 1,
    hash: 'legacy',
    name: 'Old',
    tools: [],
    skills: [],
    extensions: [],
  };
  state.capabilityProfiles.push(old);
  assert.equal(old.hash, 'legacy');
  assert.equal(old.loadWorkspaceAgentsMd, undefined);
  const profile = c.command({
    action: 'publishProfile',
    id: 'inspect',
    name: 'Inspect',
    tools: ['convoy.shell'],
    skills: [],
    loadWorkspaceAgentsMd: true,
  });
  const s = { id: 'chat', projectId: 'p', workspace: { path: '/w' }, runnerId: 'r' };
  c.pin(s, profile);
  const runner = {
    id: 'r',
    capabilities: { tools: ['shell'], inspection: true, executionDescriptorVersion: 1 },
  };
  state.runners.push(runner);
  assert.equal(policy.readOnlyShell(s), false, 'unassigned session preview must not throw');
  s.executionGrant = policy.resolve(s, runner);
  s.assignment = { state: 'running', policyDigest: s.executionGrant.digest };
  assert.equal(
    c.preview(s, { permissions: 'read' }).tools.find((t) => t.name === 'shell').available,
    true,
  );
  assert.equal(policy.decision(s, { name: 'start_command' }, { approval: 'ask' }).decision, 'deny');
  assert.equal(policy.decision(s, { name: 'submit_step' }, { approval: 'none' }).decision, 'allow');
  assert.equal(policy.supports({ capabilities: {} }, 'inspect'), false);
  assert.equal(policy.profiles().find((p) => p.id === 'plan').envelope.process.commands, false);
  s.executionGrant.envelope.filesystem.workspace = 'read-write';
  assert.equal(
    c.preview(s, { permissions: 'read' }).tools.find((t) => t.name === 'shell').available,
    false,
  );
  assert.throws(
    () =>
      c.command({
        action: 'publishProfile',
        id: 'bad',
        name: 'Bad',
        tools: [],
        skills: [],
        loadWorkspaceAgentsMd: 'yes',
      }),
    /boolean/,
  );
});
