import { randomUUID } from 'node:crypto';

const identity = (session) =>
  JSON.stringify([
    session.assignment?.token,
    session.assignment?.policyDigest,
    session.workspace?.path,
    session.runnerId,
    session.capabilityProfile?.hash,
  ]);
const profile = (s) => ({
  id: s.capabilityProfile.id,
  version: s.capabilityProfile.version,
  hash: s.capabilityProfile.hash,
});

// Owns capture identity and transitions. Filesystem and durable content access
// remain injected control-plane operations, not dependencies of this module.
export function createWorkspaceGuidance({ now = () => new Date().toISOString() } = {}) {
  function view(s) {
    if (s.capabilityProfile?.loadWorkspaceAgentsMd !== true) return { status: 'disabled' };
    const g = s.workspaceGuidance;
    if (
      !g ||
      g.assignmentToken !== s.assignment?.token ||
      g.workspace !== s.workspace?.path ||
      g.status === 'disabled'
    )
      return { status: 'pending', path: 'AGENTS.md', ...(g?.id ? { id: g.id } : {}) };
    return g;
  }
  function replace(s, value) {
    if (s.workspaceGuidance?.id) {
      s.workspaceGuidanceHistory ??= [];
      s.workspaceGuidanceHistory.push(s.workspaceGuidance);
      s.workspaceGuidanceHistory = s.workspaceGuidanceHistory.slice(-20);
    }
    s.workspaceGuidance = value;
  }
  function request(s, force = false) {
    const current = view(s);
    if (current.status === 'disabled') {
      if (s.workspaceGuidance?.status !== 'disabled')
        replace(s, { status: 'disabled', id: randomUUID(), at: now() });
      return null;
    }
    if (!s.workspace || !s.assignment) return null;
    if (!force && ['loaded', 'missing', 'error'].includes(current.status)) {
      s.workspaceGuidance.profile = profile(s);
      return null;
    }
    const request = { identity: identity(s), id: randomUUID() };
    replace(s, {
      id: request.id,
      status: 'pending',
      path: 'AGENTS.md',
      at: now(),
      assignmentToken: s.assignment.token,
      workspace: s.workspace.path,
      runnerId: s.runnerId,
      profile: profile(s),
      source: s.workspace.guidanceBootstrap ?? { kind: 'workspace' },
    });
    return request;
  }
  function assertCurrent(s, request) {
    if (
      s.capabilityProfile?.loadWorkspaceAgentsMd !== true ||
      identity(s) !== request.identity ||
      s.workspaceGuidance?.id !== request.id ||
      !['running', 'released'].includes(s.assignment?.state)
    )
      throw new Error(
        'Workspace guidance capture became stale. Retry with the current assignment.',
      );
  }
  function complete(s, request, result) {
    assertCurrent(s, request);
    Object.assign(s.workspaceGuidance, result, { at: now() });
    return s.workspaceGuidance;
  }
  return { view, request, assertCurrent, complete };
}
