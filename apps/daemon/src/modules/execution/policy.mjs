import { createHash } from 'node:crypto';

const PROFILE_IDS = [
  'plan',
  'ask',
  'edit',
  'auto',
  'dont-ask',
  'full-access-ask',
  'full-access',
  'deny',
];

const profiles = {
  plan: profile('plan', 'Plan / inspect', 'workspace', 'read-only', 'none', {
    edits: 'deny',
    commands: 'deny',
    otherMutations: 'deny',
  }),
  ask: profile('ask', 'Sandboxed · ask', 'workspace', 'read-write', 'none', {
    edits: 'ask',
    commands: 'ask',
    otherMutations: 'ask',
  }),
  edit: profile('edit', 'Sandboxed · accept edits', 'workspace', 'read-write', 'none', {
    edits: 'allow',
    commands: 'ask',
    otherMutations: 'ask',
  }),
  auto: profile('auto', 'Sandboxed · automatic policy review', 'workspace', 'read-write', 'none', {
    edits: 'allow',
    commands: 'allow',
    otherMutations: 'ask',
  }, 'policy'),
  'dont-ask': profile('dont-ask', 'Sandboxed · deny prompts', 'workspace', 'read-write', 'none', {
    edits: 'ask',
    commands: 'ask',
    otherMutations: 'ask',
  }, 'none'),
  'full-access-ask': profile(
    'full-access-ask',
    'Host access · ask',
    'host',
    'host',
    'host',
    { edits: 'ask', commands: 'ask', otherMutations: 'ask' },
  ),
  'full-access': profile(
    'full-access',
    'Host access · no prompts',
    'host',
    'host',
    'host',
    { edits: 'allow', commands: 'allow', otherMutations: 'allow' },
    'none',
  ),
  deny: profile('deny', 'Execution denied', 'none', 'none', 'none', {
    reads: 'deny',
    edits: 'deny',
    commands: 'deny',
    otherMutations: 'deny',
  }, 'none'),
};

function profile(id, name, isolation, workspace, network, decisions, reviewer = 'user') {
  return Object.freeze({
    id,
    name,
    revision: 1,
    envelope: Object.freeze({
      isolation,
      filesystem: Object.freeze({ workspace, extraRoots: [], protectedPaths: [] }),
      network: Object.freeze({ mode: network, allowedDomains: [] }),
      credentials: Object.freeze({ mode: isolation === 'host' ? 'host' : 'none' }),
      process: Object.freeze({
        commands: isolation !== 'none' && id !== 'plan',
        background: isolation !== 'none' && id !== 'plan',
        terminal: isolation !== 'none' && id !== 'plan',
      }),
    }),
    approval: Object.freeze({
      reviewer,
      reads: decisions.reads ?? 'allow',
      edits: decisions.edits,
      commands: decisions.commands,
      otherMutations: decisions.otherMutations,
    }),
  });
}

const clone = (value) => structuredClone(value);
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const editTools = new Set(['write_file', 'apply_patch']);
const commandTools = new Set([
  'shell',
  'start_command',
  'send_command_input',
  'stop_command',
]);

export function executionProfile(value = 'ask', inherit = false) {
  if (inherit && value === 'inherit') return value;
  if (!PROFILE_IDS.includes(value)) throw new Error('Unknown execution profile.');
  return value;
}

/**
 * Execution policy is a deep module: callers select a profile, resolve a grant,
 * ask for one tool decision, or test runner eligibility. Profile composition and
 * precedence stay local to this implementation.
 */
export function createExecutionPolicy({ state, catalog }) {
  for (const project of state.projects ?? []) project.executionProfile ??= 'ask';
  for (const ticket of state.tickets ?? []) ticket.executionProfile ??= 'inherit';

  function selected(session) {
    if (session.executionGrant) return session.executionGrant.profileId;
    const ticket = catalog.ticket(session.activeTicketId ?? session.id);
    const project = catalog.project(ticket?.projectId ?? session.projectId ?? state.projects[0].id);
    const requested = session.executionProfile ?? ticket?.executionProfile ?? 'inherit';
    return executionProfile(requested === 'inherit' ? project.executionProfile ?? 'ask' : requested);
  }

  function resolve(session, runner) {
    const definition = profiles[selected(session)];
    const grant = {
      version: 1,
      profileId: definition.id,
      profileRevision: definition.revision,
      runnerId: runner?.id,
      environmentId: runner?.environmentId,
      envelope: clone(definition.envelope),
      approval: clone(definition.approval),
    };
    grant.digest = digest(grant);
    return grant;
  }

  function supports(runner, profileId) {
    const definition = profiles[executionProfile(profileId)];
    if (definition.envelope.isolation === 'none') return false;
    const isolation = runner.capabilities?.enforcement?.isolation;
    if (Array.isArray(isolation))
      return (
        runner.capabilities.enforcement.failClosed === true &&
        isolation.includes(definition.envelope.isolation)
      );
    return definition.envelope.isolation !== 'host' || runner.accessMode === 'trusted';
  }

  function decision(session, call, toolDefinition) {
    const grant = session.executionGrant ?? resolve(session);
    const approval = grant.approval;
    const category =
      toolDefinition?.approval !== 'ask'
        ? 'reads'
        : editTools.has(call.name)
          ? 'edits'
          : commandTools.has(call.name)
            ? 'commands'
            : 'otherMutations';
    const value = approval[category];
    const reviewer =
      grant.profileId === 'auto' && category === 'otherMutations' ? 'user' : approval.reviewer;
    return {
      decision: value,
      reviewer,
      interactive: value === 'ask' && reviewer !== 'none',
      category,
      profileId: grant.profileId,
      policyDigest: grant.digest,
    };
  }

  return {
    profiles: () => PROFILE_IDS.map((id) => clone(profiles[id])),
    selected,
    resolve,
    supports,
    decision,
  };
}
