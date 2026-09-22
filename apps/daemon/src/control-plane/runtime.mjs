import { digest } from '../../../../packages/runner/src/index.mjs';
import { randomUUID } from 'node:crypto';
import {
  normalizeWorkflow,
  ensureAgentSessions,
  createWorkflowEngine,
  createWorkflows,
  migrateWorkflowState,
  createWorkflowStartRules,
  migrateWorkflowStartRules,
  workflowForProject,
  defaultWorkflowDefinition,
} from '../modules/workflows/index.mjs';
import { createWork } from '../modules/work/index.mjs';
import {
  createExecution,
  createExecutionSessionModule,
  createSessionExecution,
} from '../modules/execution/index.mjs';
import {
  createConversations,
  createConversationModule,
  createConversationMessaging,
  createSteering,
  recoverSessions,
  CONTINUE_INPUT,
  activeFlow,
  canMessage,
  messageBinding,
} from '../modules/conversations/index.mjs';
import { createLibrary } from '../modules/library/index.mjs';
import { createIdentity } from '../modules/identity/index.mjs';
import { createOrganizations } from '../modules/organizations/index.mjs';
import { createProviders } from '../modules/providers/index.mjs';
import { createSecurityAudit } from '../modules/audit/index.mjs';
import {
  createAgentModule,
  createPromptContext,
  instructionScopeOrder,
  migrateAgentState,
} from '../modules/agents/index.mjs';
import { createSnapshotQuery } from './snapshot-query.mjs';
import { migrateControlPlaneState } from './state-schema.mjs';
import { createTicketRun } from './ticket-run.mjs';
import { createWorkflowEffects, migrateWorkflowEffectState } from './workflow-effects.mjs';
import { createAgentTurns } from './agent-turns.mjs';
import { runtimeCommandContracts, validateRuntimeCommand } from './runtime-command-validation.mjs';
import { createWorkExecution } from './work-execution.mjs';
import { createWorkflowReferences } from './workflow-references.mjs';
import { createAgentExecution } from './agent-execution.mjs';
import { createProviderGateway } from './provider-gateway.mjs';
import { createProviderProbe } from './provider-probe.mjs';
import {
  createModuleCommandRegistry,
  createSessionCommandRegistry,
} from './module-command-registry.mjs';
import { createSessionConfiguration } from './session-configuration.mjs';
import { createCommandAuthorization } from './command-authorization.mjs';

const text = (value, max = 12000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Missing or oversized text.');
  return value.trim();
};
const taskId = (value) => {
  const id = String(value);
  if (!/^(?:\d{1,10}|chat-[a-f0-9-]{36})$/.test(id)) throw new Error('Invalid session ID.');
  return id;
};
const clientId = (value) => {
  if (typeof value !== 'string' || !/^[\w-]{8,80}$/.test(value))
    throw new Error('A client identity is required.');
  return value;
};
const now = () => new Date().toISOString();
const orchestrationCommands = [
  'querySecurityAudit',
  'exportSecurityAudit',
  'advance',
  'attachContext',
  'claim',
  'configure',
  'diff',
  'ensure',
  'heartbeat',
  'openTicketConversation',
  'reconcileAssignment',
  'release',
  'runTicket',
  'start',
  'stop',
  'selectActiveContext',
  'createOrganization',
  'createTeam',
  'createMembership',
  'updateMembership',
  'saveOrganizationPolicy',
  'createInvitation',
  'acceptInvitation',
  'beginOrganizationDomainVerification',
  'completeOrganizationDomainVerification',
  'configureEnterpriseIdentityProvider',
  'saveIdentityProviderGroupMapping',
  'provisionExternalIdentity',
  'deprovisionExternalIdentity',
  'createWorkloadIdentity',
  'revokeWorkloadIdentity',
  'createServicePrincipal',
  'rotateServicePrincipalCredential',
  'revokeServicePrincipal',
  'createProviderConnection',
  'probeProviderConnection',
  'rotateProviderCredential',
  'revokeProviderCredential',
  'createModelRoute',
  'revokeProviderConnection',
  'saveEnvironmentAccessBinding',
  'issueRunnerEnrollment',
  'redeemRunnerEnrollment',
  'revokeRunnerEnrollment',
  'rotateRunnerIdentity',
  'revokeRunnerIdentity',
];

export async function createRuntime({
  persistence,
  generate,
  models,
  provider = { id: 'injected-provider', name: 'Injected provider', capabilities: [] },
  auth,
  runners,
  boards,
  externalTickets,
  credentialBroker,
  credentialBrokerFactory,
  enterpriseIdentity = {},
  providerAdapters = {
    adapterFor(connection) {
      throw new Error(
        `No provider adapter is registered for ${connection?.providerId ?? 'unknown'}.`,
      );
    },
  },
  capacityProvider,
  deployment = {
    id: 'convoy-local',
    displayName: 'Local Convoy',
    issuer: 'http://127.0.0.1:4317',
    publicOrigin: 'http://127.0.0.1:4317',
    capabilities: ['organizations', 'provider-connections', 'remote-execution'],
    authenticationMethods: ['local-bootstrap'],
  },
}) {
  if (!persistence?.store || !persistence?.contextFiles || !persistence?.commandLogs)
    throw new Error('Runtime persistence ports are required.');
  const {
    store,
    contextFiles,
    commandLogs,
    readLegacyConversation = async () => null,
  } = persistence;
  const state = store.data;
  const jobs = new Map();
  const listeners = new Set();
  const publish = (change) => {
    for (const listener of listeners)
      try {
        listener(change);
      } catch {
        /* A disconnected observer must not stop execution. */
      }
  };
  const save = store.save.bind(store);
  store.save = () => {
    const saved = save();
    saved.then(
      () => publish({ type: 'change' }),
      () => {},
    );
    return saved;
  };
  function partial(s, text) {
    s.partial = text;
    s.updatedAt = now();
    s.streamVersion = (s.streamVersion ?? 0) + 1;
    publish({
      type: 'partial',
      id: s.id,
      text,
      updatedAt: s.updatedAt,
      version: s.streamVersion,
      agentSessionId: s.currentAgentSessionId,
    });
  }
  migrateControlPlaneState(state, { deploymentId: deployment.id });
  migrateAgentState(state);
  migrateWorkflowState(state, {
    defaultWorkflow: defaultWorkflowDefinition,
    normalize: normalizeWorkflow,
  });
  migrateWorkflowEffectState(state);
  let queue = Promise.resolve();
  let closing = false;
  let closePromise;
  function event(session, type, data = {}) {
    session.streamVersion = (session.streamVersion ?? 0) + 1;
    session.updatedAt = now();
    session.sequence++;
    session.events.push({
      seq: session.sequence,
      type,
      at: session.updatedAt,
      ticketId: session.activeTicketId,
      agentSessionId: session.currentAgentSessionId,
      ...data,
    });
  }
  const workExecution = createWorkExecution({ state, jobs });
  const workflowReferences = createWorkflowReferences(state);
  let workflowEffects;
  const work = createWork({
    state,
    save: () => store.save(),
    contextFiles,
    execution: workExecution,
    externalTickets,
    referencedColumn: workflowReferences.column,
    referencedBoard: (boardId) =>
      workflowReferences.board(boardId) ||
      Object.values(state.sessions).some((session) => session.boardId === boardId),
    afterCommand: (command, result, context) => workflowEffects.observeBoardCommand(command, result, context),
  });
  const catalog = work.catalog;
  migrateWorkflowStartRules(state);
  const startRules = createWorkflowStartRules({
    state,
    save: () => store.save(),
    authorizeRule: (projectId, principal) =>
      requireProjectPermission(projectId, 'project.execute', principal),
  });
  const localPrincipal = { kind: 'user', userId: 'local' };
  const deploymentIsRemote = !['127.0.0.1', 'localhost', '[::1]'].includes(
    new URL(deployment.publicOrigin).hostname,
  );
  const enterpriseIdentityPorts = {
    async authorizeAccountLink() {
      return false;
    },
    async authorizeProvisioning() {
      return false;
    },
    async verifyDomainControl() {
      return undefined;
    },
    async resolveLogin() {
      throw new Error('Enterprise identity login is not configured.');
    },
    async resolveProvisioning() {
      throw new Error('Enterprise identity provisioning is not configured.');
    },
    async resolveDeprovisioning() {
      throw new Error('Enterprise identity deprovisioning is not configured.');
    },
    ...enterpriseIdentity,
  };
  const identity = createIdentity({
    state,
    save: () => store.save(),
    authorizeAccountLink: enterpriseIdentityPorts.authorizeAccountLink,
  });
  const organizations = createOrganizations({
    state,
    deploymentId: deployment.id,
    save: () => store.save(),
    assertPrincipalActive: identity.assertPrincipalActive,
    getPrincipalEmail: identity.getVerifiedEmail,
    authorizeProvisioning: enterpriseIdentityPorts.authorizeProvisioning,
    verifyDomainControl: enterpriseIdentityPorts.verifyDomainControl,
    projects: {
      listByOrganization: async (organizationId) =>
        state.projects
          .filter((project) => project.organizationId === organizationId)
          .map((project) => ({
            id: project.id,
            organizationId: project.organizationId,
            teamId: project.teamId,
            slug: project.id,
            displayName: project.name,
          })),
      get: async (organizationId, projectId) => {
        const project = state.projects.find(
          (candidate) => candidate.organizationId === organizationId && candidate.id === projectId,
        );
        return project
          ? {
              id: project.id,
              organizationId: project.organizationId,
              teamId: project.teamId,
              slug: project.id,
              displayName: project.name,
            }
          : undefined;
      },
    },
  });
  const securityAudit = createSecurityAudit({
    state,
    deploymentId: deployment.id,
    save: () => store.save(),
    now,
  });
  const providers = createProviders({ state, save: () => store.save() });
  await providers.administration.ensureSubscriptionCompatibility({
    organizationId: 'personal',
    userId: 'local',
    providerId: provider.id,
    displayName: provider.name,
    credentialRef: { kind: 'subscription', reference: 'chatgpt-oauth', version: '1' },
    models,
  });
  const activeProviderAdapters = {
    adapterFor(connection) {
      if (connection?.providerId === provider.id) {
        return {
          ...provider,
          protocol: 'chatgpt-subscription',
          async inspectConnection() {
            return { available: true, authentication: 'oauth' };
          },
          async discoverModels() {
            return structuredClone(models);
          },
          generate,
        };
      }
      return providerAdapters.adapterFor(connection);
    },
  };
  const authorizeCredential = async (request) => {
    try {
      if (request.purpose === 'discover-models' && !request.grantId) {
        const connection = await providers.administration.prepareProbe({
          organizationId: request.organizationId,
          connectionId: request.providerConnectionId,
          expectedRevision: request.expectedRevision,
        });
        const decision = await organizations.authorize(request.context, 'provider.manage', {
          organizationId: request.organizationId,
        });
        return connection.id === request.providerConnectionId && decision.effect === 'allow';
      }
      const plan = await providers.routing.prepareDispatch(request.grantId, {
        policyRevision: request.policyRevision,
      });
      return (
        plan.connection.id === request.providerConnectionId &&
        plan.grant.organizationId === request.organizationId &&
        plan.grant.sessionId === request.sessionId &&
        plan.grant.turnId === request.turnId &&
        (request.actor?.kind !== 'user' || plan.grant.userId === request.actor.userId)
      );
    } catch {
      return false;
    }
  };
  const activeCredentialBroker =
    credentialBroker ??
    (credentialBrokerFactory
      ? await credentialBrokerFactory({
          authorize: authorizeCredential,
          resolveSubscription: (_reference, request) => auth.token(request.signal),
        })
      : {
          async resolve(request) {
            if (!(await authorizeCredential(request)))
              throw new Error('Credential access is not authorized.');
            if (request.credentialRef?.kind === 'subscription')
              return {
                organizationId: request.organizationId,
                providerConnectionId: request.providerConnectionId,
                purpose: request.purpose,
                value: await auth.token(request.signal),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              };
            throw new Error('Provider credential resolution is not configured.');
          },
        });
  const providerGateway = createProviderGateway({
    routing: providers.routing,
    credentialBroker: activeCredentialBroker,
    adapters: activeProviderAdapters,
    authorizeContext: async (context, _purpose, plan) => {
      const resource = {
        organizationId: context.organizationId,
        ...(context.teamId ? { teamId: context.teamId } : {}),
        projectId: context.projectId,
      };
      const role = await organizations.authorize(context, 'provider.use', resource);
      if (role.effect !== 'allow') return false;
      const policy = await organizations.evaluatePolicy({
        context,
        action: 'provider.use',
        resource,
        personalProvider: plan?.connection?.owner?.kind === 'user',
      });
      return policy.effect === 'allow';
    },
    audit: securityAudit.record,
    legacyModels: [],
    legacyGenerate: generate,
  });
  const providerProbe = createProviderProbe({
    administration: providers.administration,
    credentialBroker: activeCredentialBroker,
    adapters: activeProviderAdapters,
  });
  const defaultProject = state.projects.find((project) => project.organizationId === 'personal');
  const defaultActiveContext = defaultProject
    ? await organizations.resolveContext(localPrincipal, {
        organizationId: defaultProject.organizationId,
        ...(defaultProject.teamId ? { teamId: defaultProject.teamId } : {}),
        projectId: defaultProject.id,
      })
    : undefined;
  const clientContexts = new Map();
  const principalKey = (actor) =>
    actor?.kind === 'user'
      ? `user:${actor.userId}`
      : actor?.kind === 'workload'
        ? `workload:${actor.workloadIdentityId}`
        : actor?.kind === 'service-principal'
          ? `service-principal:${actor.servicePrincipalId}`
          : 'anonymous';
  const contextFor = (client, actor = localPrincipal) =>
    clientContexts.get(`${principalKey(actor)}:${client}`) ??
    (principalKey(actor) === principalKey(localPrincipal) ? defaultActiveContext : undefined);
  async function providerContextForProject(projectId, actor = localPrincipal) {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('Choose a project before selecting a model route.');
    return organizations.resolveContext(actor, {
      organizationId: project.organizationId,
      ...(project.teamId ? { teamId: project.teamId } : {}),
      projectId: project.id,
    });
  }
  const providerContextForSession = (session) =>
    providerContextForProject(session.projectId, session.executionPrincipal ?? localPrincipal);
  async function resolveSessionModel(session, model) {
    return providerGateway.describeModel(
      model,
      providerGateway.isLegacyModel(model) ? undefined : await providerContextForSession(session),
    );
  }
  async function resolveProjectModel(model, projectId, actor = localPrincipal) {
    return providerGateway.describeModel(
      model,
      providerGateway.isLegacyModel(model)
        ? undefined
        : await providerContextForProject(projectId, actor),
    );
  }
  async function authorizeSessionModel(session, model, signal) {
    if (providerGateway.isLegacyModel(model)) {
      const project = state.projects.find((candidate) => candidate.id === session.projectId);
      if (
        project?.organizationId !== 'personal' ||
        principalKey(session.executionPrincipal ?? localPrincipal) !== principalKey(localPrincipal)
      )
        throw new Error('Personal subscription models are unavailable in this context.');
      const context = await providerContextForProject(
        session.projectId,
        session.executionPrincipal ?? localPrincipal,
      );
      const policy = await organizations.evaluatePolicy({
        context,
        action: 'provider.use',
        resource: {
          organizationId: context.organizationId,
          ...(context.teamId ? { teamId: context.teamId } : {}),
          projectId: context.projectId,
        },
        personalProvider: true,
      });
      if (policy.effect !== 'allow') throw new Error('Personal provider is not authorized.');
      await auth.token(signal);
    } else if (!(await resolveSessionModel(session, model)))
      throw new Error('Unknown provider model.');
  }
  async function authorizeProjectModel(model, projectId, actor = localPrincipal, signal) {
    if (providerGateway.isLegacyModel(model)) {
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (
        project?.organizationId !== 'personal' ||
        principalKey(actor) !== principalKey(localPrincipal)
      )
        throw new Error('Personal subscription models are unavailable in this context.');
      const context = await providerContextForProject(projectId, actor);
      const policy = await organizations.evaluatePolicy({
        context,
        action: 'provider.use',
        resource: {
          organizationId: context.organizationId,
          ...(context.teamId ? { teamId: context.teamId } : {}),
          projectId: context.projectId,
        },
        personalProvider: true,
      });
      if (policy.effect !== 'allow') throw new Error('Personal provider is not authorized.');
      await auth.token(signal);
    } else if (!(await resolveProjectModel(model, projectId, actor)))
      throw new Error('Unknown provider model.');
  }
  async function requireContextPermission(client, permission, organizationId, actor) {
    const context = contextFor(client, actor);
    if (!context || context.organizationId !== organizationId) throw new Error('Not authorized.');
    const decision = await organizations.authorize(context, permission, { organizationId });
    if (decision.effect !== 'allow') throw new Error('Not authorized.');
    return context;
  }
  async function requireProjectPermission(projectId, permission, actor) {
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('Not authorized.');
    const context = await organizations.resolveContext(actor, {
      organizationId: project.organizationId,
      ...(project.teamId ? { teamId: project.teamId } : {}),
      projectId: project.id,
    });
    const decision = await organizations.authorize(context, permission, {
      organizationId: project.organizationId,
      ...(project.teamId ? { teamId: project.teamId } : {}),
      projectId: project.id,
    });
    if (decision.effect !== 'allow') throw new Error('Not authorized.');
    return context;
  }
  async function provisionResolvedExternalIdentity(
    organizationId,
    identityProviderId,
    resolved,
    sessionInput,
  ) {
    if (!resolved || typeof resolved !== 'object') {
      throw new Error('Enterprise identity adapter returned an invalid assertion.');
    }
    if (resolved.source === 'jit') {
      await organizations.evaluateFederatedAccess({
        organizationId,
        identityProviderId,
        email: resolved.email,
        emailVerified: resolved.emailVerified,
        authenticationStrength: resolved.authenticationStrength,
        mfa: resolved.mfa,
      });
    } else if (resolved.source !== 'scim') {
      throw new Error('Enterprise identity adapter returned an invalid provisioning source.');
    }
    const provisioned = await identity.provisionExternalUser({
      organizationId,
      identityProviderId,
      protocol: resolved.protocol,
      issuer: resolved.issuer,
      subject: resolved.subject,
      displayName: resolved.displayName,
      email: resolved.email,
      emailVerified: resolved.emailVerified,
      source: resolved.source,
    });
    const principal = { kind: 'user', userId: provisioned.user.id };
    await organizations.reconcileProvisionedMemberships({
      organizationId,
      identityProviderId,
      principal,
      source: resolved.source,
      externalGroupIds: resolved.externalGroupIds ?? [],
      evidence: resolved.evidence,
    });
    if (!sessionInput) return { principal, user: provisioned.user, link: provisioned.link };
    const opened = await identity.openDeviceSession({
      userId: provisioned.user.id,
      deviceId: sessionInput.deviceId,
      ttlMs: sessionInput.ttlMs,
    });
    return { credential: opened.credential, principal, session: opened.session };
  }
  async function revokePrincipalWork(principal, organizationId) {
    const affected = Object.values(state.sessions).filter(
      (session) =>
        principalKey(session.executionPrincipal) === principalKey(principal) &&
        (!organizationId ||
          state.projects.find((project) => project.id === session.projectId)?.organizationId ===
            organizationId),
    );
    const activeJobs = [];
    for (const session of affected) {
      delete session.queuedInput;
      for (const message of session.pendingMessages ?? []) {
        message.held = true;
        message.reason = 'Identity authority was revoked before dispatch.';
      }
      const job = jobs.get(session.id);
      if (job) {
        job.controller.abort();
        activeJobs.push(job.promise.catch(() => {}));
      }
    }
    await Promise.all(activeJobs);
    for (const session of affected) {
      delete session.queuedInput;
      delete session.pendingTurnInput;
      session.status = 'interrupted';
      event(session, 'identity_authority_revoked', {
        message: 'Identity authority was revoked before further dispatch.',
      });
    }
    await store.save();
  }
  const commandAuthorization = createCommandAuthorization({
    state,
    contextFor,
    requireProjectPermission,
    requireOrganizationPermission: organizations.requireOrganizationPermission,
    isBootstrapPrincipal: (actor) => principalKey(actor) === principalKey(localPrincipal),
  });
  const execution = createExecution({
    state,
    save: () => store.save(),
    catalog,
    workExecution,
    execute: (...args) => runners.execute(...args),
    event,
    capacityProvider,
    audit: securityAudit.record,
    authorizeFullSystem: async (session, profileId) => {
      const project = state.projects.find((candidate) => candidate.id === session.projectId);
      if (!project) return { effect: 'deny', reason: 'project-not-found' };
      const context = await organizations.resolveContext(
        session.executionPrincipal ?? localPrincipal,
        {
          organizationId: project.organizationId,
          ...(project.teamId ? { teamId: project.teamId } : {}),
          projectId: project.id,
        },
      );
      return organizations.evaluatePolicy({
        context,
        action: 'project.execute',
        resource: {
          organizationId: project.organizationId,
          ...(project.teamId ? { teamId: project.teamId } : {}),
          projectId: project.id,
        },
        fullSystemAccess: true,
      });
    },
  });
  const placement = execution.placement;
  const promptContext = createPromptContext({ digest, now });
  const library = createLibrary({
    state,
    save: () => store.save(),
    catalog,
    parseSessionId: taskId,
    digest,
    scopeOrder: instructionScopeOrder,
    now,
    event,
  });
  const capabilities = library.capabilities;
  const steering = createSteering(event);
  function makeSession(id, title) {
    return {
      id,
      title,
      description: '',
      status: 'idle',
      model: models.find((m) => m.id === 'gpt-5.6-sol')?.id ?? models[0]?.id,
      messages: [],
      events: [],
      sequence: 0,
      instructions: [],
      checks: [],
      step: 0,
      completedStep: -1,
      lease: null,
      pending: null,
      workspace: null,
      workflow: null,
      requests: [],
      updatedAt: now(),
      partial: '',
    };
  }
  function migrateRun(s) {
    if (!s.workflow) return;
    try {
      const normalized = normalizeWorkflow(s.workflow);
      s.workflow = { ...normalized, version: s.workflow.version ?? 1 };
      if (!s.flow) return;
      const list = s.workflow.nodes;
      s.flow.workflowId ??= s.workflow.id;
      s.flow.workflowVersion ??= s.workflow.version;
      s.flow.history ??= [];
      s.flow.aliases ??= { main: s.currentAgentSessionId };
      s.flow.bindings ??= {};
      s.flow.revision ??= 0;
      if (!s.flow.nodeId) s.flow.nodeId = list[s.flow.step ?? s.step ?? 0]?.id;
      if (s.flow.nodeId)
        s.step = Math.max(
          0,
          list.findIndex((node) => node.id === s.flow.nodeId),
        );
      if (s.pastRuns)
        for (const run of s.pastRuns)
          if (run.workflow)
            try {
              run.workflow = {
                ...normalizeWorkflow(run.workflow),
                version: run.workflow.version ?? s.workflow.version,
              };
            } catch {
              /* retain an auditable legacy record */
            }
    } catch {
      /* malformed historical data remains inspectable and will fail safely on resume */
    }
  }
  function pinInstructions(s) {
    capabilities.pinDefault(s);
    s.instructions = promptContext.select(state, s);
    s.environmentInstructionsPinned = false;
  }
  async function startAssigned(s, input, requestId) {
    if (s.requests.includes(requestId)) return;
    await authorizeSessionModel(s, s.model);
    s.requests.push(requestId);
    s.status = 'running';
    if (!launch(s, input)) {
      s.queuedInput = input;
      s.status = 'queued';
      s.queueReason = 'Global concurrency limit reached.';
    }
    await store.save();
  }
  let engine;
  let configuration;
  const conversations = createConversations({
    state,
    catalog,
    save: () => store.save(),
    event,
    makeSession,
    busy: (s) => jobs.has(s.id),
    start: startAssigned,
    pinInstructions,
    authorizeStart: (session) => authorizeSessionModel(session, session.model),
    initializeWorkspace(s, c) {
      if (!c.placement) return;
      const policy = placement.policy(c.placement);
      if (policy.mode !== 'none' && !s.projectId)
        throw new Error('Choose a project before selecting a workspace.');
      if (policy.mode === 'pinned') {
        const runner = state.runners.find((r) => r.id === policy.runnerId);
        if (
          !runner.enabled ||
          !placement.env(runner.environmentId).enabled ||
          !runner.projectIds.includes(s.projectId)
        )
          throw new Error('This repository is disabled or unavailable to the selected project.');
      }
      s.placement = policy;
      s.chatWorkspaceSelected = policy.mode === 'pinned';
    },
    // Conversation tools and direct board commands share one event seam. A
    // workflow-created ticket is marked with its run so its own event cannot
    // recursively start another trigger, while user/agent conversation work
    // remains eligible for configured ticket triggers.
    ticketCommand: (s, command) =>
      workflowEffects.boardCommand({
        ...command,
        ...(s.flow ? { workflowRunId: s.flow.id, workflowInstance: s.flow.instance } : {}),
      }),
    validateBinding(s, t) {
      if (
        s.workspace ||
        s.workspaceRequest ||
        (s.chatWorkspaceSelected && s.placement?.mode === 'pinned')
      ) {
        const runnerId = s.runnerId ?? s.placement?.runnerId;
        const policy =
          t.placement?.mode === 'inherit' ? catalog.project(t.projectId).placement : t.placement;
        if (
          (policy?.mode === 'none' && t.placement?.mode !== 'inherit') ||
          (policy?.mode === 'pinned' && policy.runnerId !== runnerId) ||
          (policy?.mode === 'pool' &&
            !state.runnerPools.find((p) => p.id === policy.poolId)?.runnerIds.includes(runnerId))
        )
          throw new Error(
            'Ticket placement does not match this session’s selected or existing worktree. Delegate instead.',
          );
        const runner = placement.runner(runnerId);
        const tags = [...runner.tags, ...placement.env(runner.environmentId).tags];
        if (
          !runner.projectIds.includes(t.projectId) ||
          (policy?.requiredTools ?? []).some((x) => !runner.capabilities.tools.includes(x)) ||
          (policy?.requiredTags ?? []).some((x) => !tags.includes(x))
        )
          throw new Error(
            'Existing worktree cannot meet this ticket’s placement requirements. Delegate instead.',
          );
      }
    },
  });
  recoverSessions({ state, ensureAgentSessions, migrateRun, steering, event });
  await store.save();
  function get(id) {
    const key = taskId(id);
    const s = workExecution.sessionFor(catalog.ticket(key)) ?? state.sessions[key];
    if (!s) throw new Error('Session does not exist. Open Chat first.');
    return s;
  }
  let snapshot;
  function own(s, client) {
    clientId(client);
    if (!s.lease || s.lease.expiresAt < Date.now() || s.lease.client !== client)
      throw new Error('Claim session control first. Another terminal or tab may own it.');
    s.lease.expiresAt = Date.now() + 90000;
  }
  function idle(s) {
    if (jobs.has(s.id)) throw new Error('Stop or finish the current run first.');
  }
  function runnerFor(s) {
    const runner = state.runners.find((r) => r.id === s.runnerId);
    if (!runner) throw new Error('Select a registered runner.');
    return runner;
  }
  const sessionExecution = createSessionExecution({
    commandLogs,
    runners,
    runnerFor,
    placement,
    extensionTool: (session, name) => capabilities.extensionTool(session, null, name),
    event,
    save: () => store.save(),
    isClosing: () => closing,
    executionPolicy: execution.policy,
  });
  const executionSessionModule = createExecutionSessionModule({
    sessionExecution,
    channelGrants: execution.channelGrants,
  });
  const { activeTerminal, concurrentWorkspaceExecution, tool } = sessionExecution;
  const agentTurns = createAgentTurns({
    state,
    generate,
    contextFiles,
    ensureAgentSessions,
    digest,
    event,
    save: () => store.save(),
    now,
    requireText: text,
    policyDecision: execution.policy.decision,
    audit: securityAudit.record,
  });
  const agentModule = createAgentModule({
    state,
    agentTurns,
    async probeModel(model) {
      if (!models.some((candidate) => candidate.id === model)) throw new Error('Unknown model.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        if (!defaultProject) throw new Error('Personal project is unavailable.');
        const context = await providerContextForProject(defaultProject.id, localPrincipal);
        let complete = false;
        for await (const item of providerGateway.generate({
          model,
          messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }],
          systemPrompt: 'Reply briefly.',
          signal: controller.signal,
          tools: [],
          context,
          purpose: 'coding',
          sessionId: 'subscription-model-probe',
          turnId: `probe:${model}:${Date.now()}:${crypto.randomUUID()}`,
        }))
          if (item.type === 'result') complete = true;
        if (!complete) throw new Error('No completed response.');
        state.modelChecks[model] = { available: true, checkedAt: now() };
        await providers.administration.recordSubscriptionProbe({
          organizationId: 'personal',
          connectionId: 'connection_personal_chatgpt_subscription',
          modelId: model,
          available: true,
        });
      } catch (error) {
        state.modelChecks[model] = {
          available: false,
          checkedAt: now(),
          message:
            error.publicMessage ??
            'Model check failed. Check your connection, login and subscription limits.',
        };
        await providers.administration.recordSubscriptionProbe({
          organizationId: 'personal',
          connectionId: 'connection_personal_chatgpt_subscription',
          modelId: model,
          available: false,
          message: state.modelChecks[model].message,
        });
      } finally {
        clearTimeout(timer);
        await store.save();
      }
    },
  });
  workflowEffects = createWorkflowEffects({
    state,
    catalog,
    conversations,
    sessionFor: workExecution.sessionFor,
    boards,
    makeSession,
    pinInstructions,
    normalizeWorkflow,
    event,
    save: () => store.save(),
    now,
    getEngine: () => engine,
    requireText: text,
    startRules,
    authorizeStart: async (rule, session) => {
      startRules.validate(rule);
      await requireProjectPermission(rule.projectId, 'project.execute', rule.principal);
      await authorizeProjectModel(session.model, rule.projectId, rule.principal);
      capabilities.pinDefault(session);
      const nodes = session.workflow?.nodes ?? [];
      const required = [...new Set(nodes.flatMap((node) => [
        ...(node.artifact ? ['read_file'] : []),
        ...(node.kind === 'check' || node.requiresCheck ? ['shell'] : []),
      ]))];
      if (required.length || nodes.some((node) =>
        node.kind === 'action' && node.operation === 'inspect_changes')) {
        const choice = placement.choose(session, required);
        if (choice.textOnly || choice.reason && !choice.capacityDemand)
          throw new Error(choice.reason ?? 'This workflow requires an authorized runner.');
      }
    },
  });
  engine = createWorkflowEngine({
    state,
    save: () => store.save(),
    event,
    canProvision: (s) => placement.effective(s).mode !== 'none',
    inspectArtifact: (s, path) => tool(s, 'read_file', { path }),
    captureArtifacts: async (s, paths) => {
      if (paths.length && (!s.workspace || !s.runnerId))
        throw new Error('Submitted artifacts require an assigned workspace.');
      const captured = [];
      for (const path of paths) {
        const file = await tool(s, 'read_file', { path, limit: 2000 });
        if (typeof file.text !== 'string' || file.truncated)
          throw new Error(`Artifact ${path} is too large to capture for review.`);
        const attachment = await contextFiles.add(
          s,
          {
            name: path.split('/').at(-1),
            mime: 'text/plain',
            data: Buffer.from(file.text).toString('base64'),
          },
          { path, runnerId: s.runnerId, workspace: s.workspace.path },
        );
        captured.push({
          id: attachment.id,
          path,
          name: attachment.name,
          mime: attachment.mime,
          size: attachment.size,
          hash: attachment.hash,
          at: attachment.at,
        });
      }
      return captured;
    },
    inspectChanges: (s, ignoreArtifact) =>
      runners.execute(runnerFor(s), {
        action: 'diff',
        workspace: s.workspace.path,
        ignoreArtifact,
      }),
    busy: (s) => jobs.has(s.id),
    abort: (s) => jobs.get(s.id)?.controller.abort(),
    actionExecutor: workflowEffects.executeAction,
    launch: (s, step, instance) =>
      launch(
        s,
        `${step.prompt}${s.flow.lastSubmission ? `\nPrevious step handoff: ${JSON.stringify(s.flow.lastSubmission)}` : ''}${s.flow.feedback ? `\nReview feedback: ${s.flow.feedback}` : ''}`,
        step,
        instance,
      ),
  });
  const agentExecution = createAgentExecution({
    providerGateway,
    providerContext: providerContextForSession,
    provider,
    auth,
    runners,
    store,
    contextFiles,
    capabilities,
    steering,
    placement,
    pinInstructions,
    promptContext,
    partial,
    digest,
    catalog,
    conversations,
    agentTurns,
    event,
    sessionExecution,
    runnerFor,
    getEngine: () => engine,
    now,
  });
  function launch(s, input, step, instance) {
    const project = state.projects.find((candidate) => candidate.id === s.projectId);
    const organizationId = project?.organizationId ?? 'personal';
    const organizationSessionIds = new Set(
      Object.values(state.sessions)
        .filter(
          (session) =>
            state.projects.find((candidate) => candidate.id === session.projectId)
              ?.organizationId === organizationId,
        )
        .map((session) => session.id),
    );
    const uncertain = Object.values(state.sessions).filter(
      (t) =>
        organizationSessionIds.has(t.id) && t.assignment?.state === 'uncertain' && !jobs.has(t.id),
    ).length;
    const active = [...jobs.keys()].filter((id) => organizationSessionIds.has(id)).length;
    const scheduler = state.schedulers?.[organizationId] ?? state.scheduler;
    if (active + uncertain >= scheduler.maxConcurrent || jobs.has(s.id)) {
      s.queueReason = 'Organization capacity is occupied by active or unresolved assignments.';
      return false;
    }
    const controller = new AbortController();
    const job = { controller };
    jobs.set(s.id, job);
    s.pendingTurnInput = input;
    let blocked = false;
    job.promise = (async () => {
      try {
        const executionPrincipal = s.executionPrincipal ?? localPrincipal;
        await identity.assertPrincipalActive(executionPrincipal);
        if (s.projectId)
          await requireProjectPermission(s.projectId, 'project.execute', executionPrincipal);
        await store.save();
        const required = [
          ...new Set(
            (s.workflow?.nodes ?? s.workflow?.steps ?? []).flatMap((x) => [
              ...(x.artifact ? ['read_file'] : []),
              ...(x.kind === 'check' || x.requiresCheck ? ['shell'] : []),
            ]),
          ),
        ];
        const result = await placement.prepare(s, required, controller.signal);
        if (controller.signal.aborted) throw new Error('Stopped');
        if (result.reason) {
          blocked = true;
          s.status = 'queued';
          s.queueReason = result.reason;
          if (instance) s.flow.status = 'ready';
          else s.queuedInput = input;
          await store.save();
          return;
        }
        delete s.queueReason;
        delete s.queuedInput;
        if (s.runnerId && !s.environmentInstructionsPinned) {
          s.instructions = promptContext.select(state, s);
          s.environmentInstructionsPinned = true;
        }
        await (step && step.kind !== 'agent'
          ? automated(s, step, instance, controller)
          : agentExecution.run(s, input, controller, instance));
      } catch (e) {
        if (!instance || !['paused', 'cancelled'].includes(s.flow.status))
          s.status = controller.signal.aborted ? 'interrupted' : 'failed';
        event(s, 'placement_error', { message: e.message });
        if (instance) await engine.fail(s, instance);
      }
    })().finally(async () => {
      // Do not expose an idle slot until the old runner's assignment is released.
      try {
        await placement.release(s);
      } finally {
        jobs.delete(s.id);
      }
      if (s.pendingTurnInput && !instance && controller.signal.aborted)
        s.queuedInput = s.pendingTurnInput;
      delete s.pendingTurnInput;
      await store.save();
      await conversations.notify(s);
      if (!closing && !blocked) await dispatch();
    });
    job.promise.catch(() => {});
    return true;
  }
  async function dispatch() {
    for (const s of Object.values(state.sessions)) {
      for (const m of s.pendingMessages ?? [])
        if (m.binding !== messageBinding(s)) {
          m.held = true;
          m.reason = 'Workflow or agent session changed; message was not delivered.';
        }
    }
    await engine.pump();
    for (const s of Object.values(state.sessions)) {
      if (
        jobs.has(s.id) ||
        s.stopRequested ||
        s.interruption?.needsReview ||
        s.assignment?.state === 'uncertain'
      )
        continue;
      if (s.queuedInput && s.status === 'queued') launch(s, s.queuedInput);
      else if (
        !activeFlow(s) &&
        steering.ready(s) &&
        !['failed', 'interrupted', 'paused'].includes(s.status)
      ) {
        s.status = 'running';
        launch(s, CONTINUE_INPUT);
      }
    }
  }
  async function requestStop(s, interrupt = false) {
    const token = { at: now(), mode: interrupt ? 'interrupt' : 'stop' };
    const job = jobs.get(s.id);
    s.stopRequested = token;
    steering.hold(
      s,
      interrupt
        ? 'Waiting for the current turn to stop.'
        : 'Stopped. Resume to deliver queued messages.',
    );
    event(s, 'stop_requested', {
      message: interrupt
        ? 'Interrupting to apply new direction.'
        : 'Stop requested. Queued messages are held.',
    });
    job?.controller.abort();
    if (activeFlow(s)) await engine.pause(s);
    await store.save();
    await job?.promise.catch(() => {});
    if (s.stopRequested === token) {
      delete s.stopRequested;
      if (!activeFlow(s)) s.status = 'interrupted';
      if (!job || !s.interruption) steering.interrupt(s, 'Stopped before further execution.');
      if (interrupt && !s.interruption?.needsReview && s.assignment?.state !== 'uncertain')
        await resumeSession(s);
      await store.save();
    }
  }
  async function resumeSession(s, acknowledge = false, request) {
    idle(s);
    if (s.assignment?.state === 'uncertain')
      throw new Error('Reconcile the original runner before resuming.');
    if (s.interruption?.needsReview && !acknowledge)
      throw new Error(
        'Inspect the interrupted operation and acknowledge its possible partial effects before resuming.',
      );
    if (
      activeFlow(s) &&
      !['paused', 'interrupted', 'failed', 'awaiting_submission'].includes(s.flow.status)
    )
      throw new Error('Use the current workflow decision controls.');
    if (!activeFlow(s) && s.workflow && !['completed', 'cancelled'].includes(s.flow?.status))
      throw new Error('Start the configured workflow first.');
    if ((s.pendingMessages ?? []).some((m) => m.binding !== messageBinding(s)))
      throw new Error('Remove messages held for a previous workflow step before resuming.');
    await authorizeSessionModel(s, s.model);
    idle(s);
    if (s.stopRequested) throw new Error('Wait for the stop request to finish.');
    if (request && !steering.resumeRequest(s, request)) return;
    steering.release(s);
    if (acknowledge && s.interruption?.needsReview) {
      s.interruption.needsReview = false;
      event(s, 'interruption_reviewed', {
        message: 'User inspected possible partial effects before resuming.',
      });
    }
    delete s.stopRequested;
    delete s.autoResume;
    event(s, 'execution_resumed', {
      message: 'Continuing from recorded results, without replaying tool calls.',
    });
    if (activeFlow(s))
      await engine.decide(s, { action: 'continueWorkflow', instance: s.flow.instance });
    else {
      const input = s.queuedInput || CONTINUE_INPUT;
      s.status = 'running';
      if (!launch(s, input)) {
        s.queuedInput = input;
        s.status = 'queued';
      }
    }
    await store.save();
  }
  const dispatchTimer = setInterval(() => {
    if (!closing)
      queue = queue
        .catch(() => {})
        .then(dispatch)
        .catch(() => {});
  }, 3000);
  dispatchTimer.unref();
  async function automated(s, step, instance, controller) {
    try {
      if (step.kind === 'check') {
        if (
          (s.commands ?? []).some((c) => ['running', 'stopping'].includes(c.state)) ||
          activeTerminal(s)
        )
          throw new Error(
            'Stop session commands and native terminals before running a workflow check.',
          );
        if (
          !(await agentTurns.authorize(
            s,
            { name: 'shell', arguments: { command: step.checkCommand } },
            { approval: 'ask' },
            controller.signal,
          ))
        )
          throw new Error('Check denied.');
        if (controller.signal.aborted) throw new Error('Stopped');
        s.inFlightTool = { name: 'shell', mutating: true };
        await store.save();
        const output = await tool(s, 'shell', { command: step.checkCommand }, controller.signal);
        if (controller.signal.aborted)
          throw new Error('Check interrupted; inspect possible partial effects.');
        delete s.inFlightTool;
        const review = await runners.execute(
          runnerFor(s),
          { action: 'diff', workspace: s.workspace.path, ignoreArtifact: step.artifact?.path },
          controller.signal,
        );
        const concurrent = concurrentWorkspaceExecution(
          s,
          output.startedAt ?? Date.now(),
          output.endedAt ?? Date.now(),
          output.commandId,
        );
        s.checks.push({
          command: step.checkCommand,
          ...output,
          concurrent,
          digest: review.digest,
          instance,
          at: now(),
        });
        event(s, 'check_result', { output: { ...output, concurrent } });
        // A check is a graph node with two meaningful outcomes. Preserve the
        // exact exit code in the durable check record and route non-zero
        // results explicitly; a missing failed edge leaves the run failed.
        const outcome = output?.code === 0 && !output.stopped ? 'success' : 'failed';
        await engine.finishAutomated(s, instance, outcome, {
          check: { command: step.checkCommand, code: output?.code, digest: review.digest },
        });
        return;
      } else if (step.kind === 'action') {
        let result = null;
        if (step.operation === 'inspect_changes') {
          if (!s.workspace) throw new Error('Inspect changes requires an assigned worktree.');
          result = {
            ...(await runners.execute(
              runnerFor(s),
              { action: 'diff', workspace: s.workspace.path },
              controller.signal,
            )),
            at: now(),
          };
          s.review = result;
        } else result = await engine.executeAction(s, instance);
        if (controller.signal.aborted) throw new Error('Stopped.');
        await engine.finishAutomated(s, instance, 'success', result);
        return;
      } else if (step.kind === 'branch') {
        const condition = step.condition;
        let matches = true;
        if (condition) {
          const source =
            condition.source === 'ticket'
              ? s.activeTicketId == null
                ? null
                : catalog.ticket(s.activeTicketId)
              : condition.source === 'submission'
                ? s.flow.lastSubmission
                : condition.source === 'actionResult'
                  ? s.flow.actionResult
                  : s.workingContext;
          const path = String(condition.field ?? '').split('.');
          let value = source;
          for (const key of path) value = value == null ? undefined : value[key];
          if (Object.hasOwn(condition, 'exists'))
            matches = (value !== undefined) === condition.exists;
          else if (Object.hasOwn(condition, 'equals'))
            matches = JSON.stringify(value) === JSON.stringify(condition.equals);
          else if (Object.hasOwn(condition, 'notEquals'))
            matches = JSON.stringify(value) !== JSON.stringify(condition.notEquals);
        }
        const outcome = condition
          ? matches
            ? condition.trueOutcome
            : condition.falseOutcome
          : (step.outcome ?? step.defaultOutcome ?? 'success');
        await engine.finishAutomated(s, instance, outcome);
        return;
      } else
        s.review = {
          ...(await runners.execute(
            runnerFor(s),
            { action: 'diff', workspace: s.workspace.path },
            controller.signal,
          )),
          at: now(),
        };
      if (controller.signal.aborted) throw new Error('Stopped');
      await engine.finishAutomated(s, instance);
    } catch (error) {
      if (s.inFlightTool?.mutating)
        steering.interrupt(
          s,
          'Check execution may have partially changed state. Inspect before resuming.',
          true,
        );
      delete s.inFlightTool;
      steering.hold(s, 'Workflow stopped. Resume explicitly.');
      if (!['paused', 'cancelled'].includes(s.flow.status))
        s.status = controller.signal.aborted ? 'interrupted' : 'failed';
      s.pending = null;
      event(s, 'workflow_error', { message: error.message });
      await engine.fail(s, instance);
    }
  }
  function validateWorkflowBindings(workflow) {
    for (const node of workflow.nodes ?? []) {
      const input = node.input ?? node.args ?? node.payload ?? {};
      if (node.operation === 'create_ticket') catalog.project(input.projectId);
      if (node.operation === 'move_ticket' && catalog.boards) {
        const board = catalog.boards.board(input.boardId);
        const columnId = input.columnId ?? input.placement?.columnId;
        if (!board.columns.some((column) => column.id === columnId))
          throw new Error(`${node.name}: board column was not found.`);
      }
    }
    for (const trigger of workflow.triggers ?? []) {
      if (trigger.projectId) catalog.project(trigger.projectId);
      if (trigger.boardId && catalog.boards) {
        const board = catalog.boards.board(trigger.boardId);
        if (trigger.columnId && !board.columns.some((column) => column.id === trigger.columnId))
          throw new Error('Workflow trigger column was not found.');
      }
    }
  }
  const messaging = createConversationMessaging({
    conversations,
    steering,
    ensureAgentSessions,
    contextFiles,
    resolveModel: resolveSessionModel,
    jobs,
    authorizeModel: authorizeSessionModel,
    canMessage,
    save: () => store.save(),
    requestStop,
    resume: resumeSession,
    launch,
    continueInput: CONTINUE_INPUT,
  });
  const conversationModule = createConversationModule({ conversations, messaging });
  const workflows = createWorkflows({
    state,
    save: () => store.save(),
    defaultWorkflow: defaultWorkflowDefinition,
    normalize: normalizeWorkflow,
    validateBindings: validateWorkflowBindings,
    engine,
    effects: workflowEffects,
    requestStop,
    startRules,
  });
  configuration = createSessionConfiguration({
    engine,
    execution,
    workflows,
    refreshInstructions(session) {
      session.environmentInstructionsPinned = false;
      session.instructions = promptContext.select(state, session);
    },
    event,
    save: () => store.save(),
  });
  const sessionCommands = createSessionCommandRegistry([
    conversationModule,
    workflows,
    executionSessionModule,
    agentModule,
    library,
  ]);
  const moduleCommands = createModuleCommandRegistry(
    [library, work, execution, workflows, conversationModule, agentModule],
    {
      expectedActions: Object.keys(runtimeCommandContracts),
      orchestrationActions: orchestrationCommands,
      sessionActions: sessionCommands.actions(),
    },
  );
  snapshot = createSnapshotQuery({
    state,
    getSession: get,
    jobs,
    capabilities,
    moduleSnapshots: [
      {
        snapshot: async ({ client, principal: snapshotPrincipal } = {}) => {
          const actor = snapshotPrincipal ?? localPrincipal;
          const selected = contextFor(client, actor);
          const providerAdministration = selected
            ? await organizations.authorize(selected, 'provider.manage', {
                organizationId: selected.organizationId,
              })
            : { effect: 'deny' };
          const identityAdministration = selected
            ? await organizations.authorize(selected, 'security.manage', {
                organizationId: selected.organizationId,
              })
            : { effect: 'deny' };
          return {
            deployment,
            activeContext: selected,
            availableContexts: await organizations.listAvailableContexts(actor),
            ...identity.snapshot(actor, {
              organizationId: selected?.organizationId,
              includeAdministration: identityAdministration.effect === 'allow',
            }),
            ...organizations.snapshot(actor),
            ...(selected
              ? providers.snapshot(selected, {
                  includeAll: providerAdministration.effect === 'allow',
                })
              : {}),
          };
        },
      },
      library,
      work,
      execution,
      conversationModule,
      workflows,
    ],
    canMessage,
    auth,
    models,
    provider,
    allowLegacyProvider: ({ principal: legacyPrincipal, scope }) =>
      principalKey(legacyPrincipal ?? localPrincipal) === principalKey(localPrincipal) &&
      scope?.organizationId === 'personal',
    accessScope: async ({ client, principal: scopePrincipal } = {}) => {
      const actor = scopePrincipal ?? localPrincipal;
      const selected = contextFor(client, actor);
      if (!selected) return { organizationId: undefined, projectIds: [] };
      const available = await organizations.listAvailableContexts(actor);
      return {
        organizationId: selected.organizationId,
        includeUnowned: principalKey(actor) === principalKey(localPrincipal),
        projectIds: available
          .filter((context) => context.organizationId === selected.organizationId)
          .map((context) => context.projectId),
      };
    },
  });
  const runTicket = createTicketRun({
    state,
    catalog,
    jobs,
    workflows: engine,
    resolveModel: resolveProjectModel,
    placement,
    authorizeModel: authorizeProjectModel,
    conversations,
    sessionFor: workExecution.sessionFor,
    capabilities,
    pinInstructions,
    event,
    save: () => store.save(),
    normalizeWorkflow,
    resolveWorkflow: (id, version, projectId) => workflowForProject(state, id, version, projectId),
    digest,
    validateClient: clientId,
    now,
  });
  function auditEnvelope(command, actor) {
    const session = state.sessions?.[String(command.sessionId ?? command.taskId ?? '')];
    const ticket = state.tickets?.find(
      (value) => String(value.id) === String(command.ticketId ?? command.taskId ?? ''),
    );
    const projectId = command.projectId ?? ticket?.projectId ?? session?.projectId;
    const project = state.projects?.find((value) => value.id === projectId);
    const selected = contextFor(command.client, actor);
    const organizationId =
      command.organizationId ??
      project?.organizationId ??
      selected?.organizationId ??
      state.organizations?.organizations?.find((value) => value.kind === 'personal')?.id;
    if (!organizationId) return undefined;
    return {
      organizationId,
      actor,
      authenticatedIdentity:
        actor.kind === 'user'
          ? { userId: actor.userId }
          : actor.kind === 'workload'
            ? { workloadIdentityId: actor.workloadIdentityId }
            : { servicePrincipalId: actor.servicePrincipalId },
      context: {
        ...(selected?.organizationId === organizationId && selected.teamId
          ? { teamId: selected.teamId }
          : project?.teamId
            ? { teamId: project.teamId }
            : {}),
        ...(projectId ? { projectId } : {}),
        ...(session?.id ? { sessionId: String(session.id) } : {}),
      },
      revisions:
        selected?.organizationId === organizationId
          ? {
              membershipRevision: selected.membershipRevision,
              policyRevision: selected.policyRevision,
            }
          : undefined,
      action: 'runtime.command',
      resource: { kind: 'command', id: command.action },
      traceId: command.traceId,
      correlationId: command.requestId,
    };
  }

  async function executeAudited(command, actor = localPrincipal) {
    const evidence = auditEnvelope(command, actor);
    try {
      const result = await execute(command, actor);
      if (evidence)
        await securityAudit.record({
          ...evidence,
          decision: 'allow',
          outcome: 'completed',
        });
      return result;
    } catch (error) {
      const authorizationDenied =
        /not authorized|not available|(?:principal|identity).*not active|not active for this organization/i.test(
          error.message,
        );
      if (evidence)
        await securityAudit.record({
          ...evidence,
          decision: authorizationDenied ? 'deny' : 'allow',
          outcome: authorizationDenied ? 'denied' : 'failed',
          observations: { failureClass: error.name ?? 'Error' },
        });
      throw error;
    }
  }
  async function execute(command, actor = localPrincipal) {
    if (closing) throw new Error('Daemon is shutting down.');
    await identity.assertPrincipalActive(actor);
    if (
      [
        'exportSkill',
        'publishExtension',
        'publishProfile',
        'publishSkill',
        'setToolEnabled',
        'publishInstruction',
      ].includes(command.action)
    ) {
      const selected = contextFor(command.client, actor);
      if (!selected) throw new Error('Not authorized.');
      command = { ...command, organizationId: command.organizationId ?? selected.organizationId };
      if (command.organizationId !== selected.organizationId) throw new Error('Not authorized.');
      if (command.action === 'setToolEnabled') {
        command = { ...command, projectId: command.projectId ?? selected.projectId };
        if (command.projectId !== selected.projectId) throw new Error('Not authorized.');
      }
      if (command.action === 'publishInstruction') {
        if (command.scope === 'organization')
          command = { ...command, target: command.target ?? selected.organizationId };
        if (command.scope === 'project')
          command = { ...command, projectId: command.projectId ?? selected.projectId };
        if (command.scope === 'user' && actor.kind === 'user')
          command = { ...command, target: command.target ?? actor.userId };
      }
    }
    if (command.action === 'saveWorkflow' || command.action === 'saveWorkflowDraft') {
      const selected = contextFor(command.client, actor);
      if (!selected) throw new Error('Not authorized.');
      command = {
        ...command,
        organizationId: command.organizationId ?? selected.organizationId,
        teamId: command.teamId ?? selected.teamId,
        projectId: command.projectId ?? selected.projectId,
      };
      if (
        command.organizationId !== selected.organizationId ||
        command.teamId !== selected.teamId ||
        command.projectId !== selected.projectId
      )
        throw new Error('Not authorized.');
    }
    if (
      command.action === 'createConversation' &&
      command.projectId === undefined &&
      command.placement === undefined
    ) {
      const selected = contextFor(command.client, actor);
      if (!selected?.projectId) throw new Error('Not authorized.');
      command = { ...command, projectId: selected.projectId };
    }
    if (
      ['saveProject', 'registerRunner', 'saveEnvironment', 'saveRunnerPool'].includes(
        command.action,
      ) &&
      command.organizationId === undefined &&
      principalKey(actor) !== principalKey(localPrincipal)
    ) {
      const selected = contextFor(command.client, actor);
      if (!selected?.organizationId) throw new Error('Not authorized.');
      command = { ...command, organizationId: selected.organizationId };
    }
    if (command.action === 'setScheduler' && command.organizationId === undefined) {
      const selected = contextFor(command.client, actor);
      if (!selected?.organizationId) throw new Error('Not authorized.');
      command = { ...command, organizationId: selected.organizationId };
    }
    const { action } = command;
    if (action === 'querySecurityAudit' || action === 'exportSecurityAudit') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'audit.read',
      );
      return action === 'querySecurityAudit'
        ? securityAudit.query(command)
        : securityAudit.export(command);
    }
    if (action === 'selectActiveContext') {
      const selected = await organizations.resolveContext(actor, command.context);
      clientContexts.set(`${principalKey(actor)}:${command.client}`, selected);
      return selected;
    }
    if (action === 'createOrganization')
      return organizations.createOrganization({ ...command, owner: actor });
    if (action === 'createTeam') return organizations.createTeam({ ...command, actor });
    if (action === 'createMembership') return organizations.createMembership({ ...command, actor });
    if (action === 'saveOrganizationPolicy') {
      return organizations.savePolicy({ ...command, actor });
    }
    if (action === 'updateMembership') {
      const membership = await organizations.updateMembership({ ...command, actor });
      if (membership.state !== 'active')
        await revokePrincipalWork(membership.principal, membership.organizationId);
      return membership;
    }
    if (action === 'createInvitation') return organizations.createInvitation({ ...command, actor });
    if (action === 'acceptInvitation')
      return organizations.acceptInvitation({ ...command, principal: actor });
    if (action === 'beginOrganizationDomainVerification') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      return organizations.beginDomainVerification({ ...command, actor });
    }
    if (action === 'completeOrganizationDomainVerification') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      return organizations.completeDomainVerification(command);
    }
    if (action === 'configureEnterpriseIdentityProvider') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      return organizations.configureIdentityProvider({ ...command, actor });
    }
    if (action === 'saveIdentityProviderGroupMapping') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      return organizations.saveIdentityProviderGroupMapping({ ...command, actor });
    }
    if (action === 'provisionExternalIdentity') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      const resolved = await enterpriseIdentityPorts.resolveProvisioning({
        organizationId: command.organizationId,
        identityProviderId: command.identityProviderId,
        request: command.request,
      });
      return provisionResolvedExternalIdentity(
        command.organizationId,
        command.identityProviderId,
        resolved,
      );
    }
    if (action === 'deprovisionExternalIdentity') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      const resolved = await enterpriseIdentityPorts.resolveDeprovisioning({
        organizationId: command.organizationId,
        identityProviderId: command.identityProviderId,
        request: command.request,
      });
      const authentication = await identity.resolveExternalIdentity({
        identityProviderId: command.identityProviderId,
        issuer: resolved.issuer,
        subject: resolved.subject,
      });
      await organizations.deprovisionProvisionedPrincipal({
        organizationId: command.organizationId,
        identityProviderId: command.identityProviderId,
        principal: authentication.principal,
        evidence: resolved.evidence,
      });
      const link = await identity.deprovisionExternalIdentity({
        organizationId: command.organizationId,
        identityProviderId: command.identityProviderId,
        subject: resolved.subject,
      });
      await revokePrincipalWork(authentication.principal, command.organizationId);
      return link;
    }
    if (action === 'createWorkloadIdentity') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      return identity.createWorkloadIdentity(command);
    }
    if (action === 'revokeWorkloadIdentity') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      const principal = {
        kind: 'workload',
        workloadIdentityId: command.workloadIdentityId,
      };
      const workload = await identity.revokeWorkloadIdentity(command);
      await revokePrincipalWork(principal, command.organizationId);
      return workload;
    }
    if (action === 'createServicePrincipal') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      return identity.createServicePrincipal(command);
    }
    if (action === 'rotateServicePrincipalCredential') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      const principal = {
        kind: 'service-principal',
        servicePrincipalId: command.servicePrincipalId,
      };
      const rotated = await identity.rotateServicePrincipalCredential(command);
      await revokePrincipalWork(principal, command.organizationId);
      return rotated;
    }
    if (action === 'revokeServicePrincipal') {
      await organizations.requireOrganizationPermission(
        actor,
        command.organizationId,
        'security.manage',
      );
      const principal = {
        kind: 'service-principal',
        servicePrincipalId: command.servicePrincipalId,
      };
      const servicePrincipal = await identity.revokeServicePrincipal(command);
      await revokePrincipalWork(principal, command.organizationId);
      return servicePrincipal;
    }
    if (action === 'createProviderConnection') {
      await requireContextPermission(
        command.client,
        'provider.manage',
        command.organizationId,
        actor,
      );
      if (command.credentialValue !== undefined) {
        if (typeof activeCredentialBroker.store !== 'function')
          throw new Error('Provider credential storage is not configured.');
        const { credentialValue, ...safeCommand } = command;
        const connection = await providers.administration.createConnection({
          ...safeCommand,
          credentialRef: { kind: 'none' },
        });
        const credentialRef = await activeCredentialBroker.store({
          organizationId: connection.organizationId,
          providerConnectionId: connection.id,
          value: credentialValue,
        });
        return providers.administration.setCredentialReference({
          organizationId: connection.organizationId,
          connectionId: connection.id,
          expectedRevision: connection.revision,
          credentialRef,
        });
      }
      return providers.administration.createConnection(command);
    }
    if (action === 'probeProviderConnection') {
      const context = await requireContextPermission(
        command.client,
        'provider.manage',
        command.organizationId,
        actor,
      );
      return providerProbe.run({ ...command, actor, context });
    }
    if (action === 'rotateProviderCredential') {
      await requireContextPermission(
        command.client,
        'provider.manage',
        command.organizationId,
        actor,
      );
      if (typeof activeCredentialBroker.store !== 'function')
        throw new Error('Provider credential storage is not configured.');
      const connection = await providers.administration.prepareProbe(command);
      const credentialRef = await activeCredentialBroker.store({
        organizationId: connection.organizationId,
        providerConnectionId: connection.id,
        value: command.credentialValue,
      });
      const updated = await providers.administration.setCredentialReference({
        organizationId: connection.organizationId,
        connectionId: connection.id,
        expectedRevision: connection.revision,
        credentialRef,
      });
      if (connection.credentialRef.kind === 'encrypted')
        await activeCredentialBroker.delete({
          organizationId: connection.organizationId,
          providerConnectionId: connection.id,
          credentialRef: connection.credentialRef,
        });
      return updated;
    }
    if (action === 'revokeProviderCredential') {
      await requireContextPermission(
        command.client,
        'provider.manage',
        command.organizationId,
        actor,
      );
      const connection = await providers.administration.prepareProbe(command);
      const updated = await providers.administration.setCredentialReference({
        organizationId: connection.organizationId,
        connectionId: connection.id,
        expectedRevision: connection.revision,
        credentialRef: { kind: 'none' },
      });
      if (connection.credentialRef.kind === 'encrypted')
        await activeCredentialBroker.delete({
          organizationId: connection.organizationId,
          providerConnectionId: connection.id,
          credentialRef: connection.credentialRef,
        });
      return updated;
    }
    if (action === 'createModelRoute') {
      await requireContextPermission(
        command.client,
        'provider.manage',
        command.organizationId,
        actor,
      );
      return providers.administration.createRoute(command);
    }
    if (action === 'revokeProviderConnection') {
      await requireContextPermission(
        command.client,
        'provider.manage',
        command.organizationId,
        actor,
      );
      return providers.administration.revokeConnection(command);
    }
    if (action === 'saveEnvironmentAccessBinding') {
      await requireContextPermission(
        command.client,
        'environment.manage',
        command.organizationId,
        actor,
      );
      return execution.access.saveBinding(command);
    }
    if (action === 'issueRunnerEnrollment') {
      await requireContextPermission(
        command.client,
        'environment.manage',
        command.organizationId,
        actor,
      );
      return execution.enrollment.issue(command);
    }
    if (action === 'redeemRunnerEnrollment') return execution.enrollment.redeem(command);
    if (action === 'revokeRunnerEnrollment') {
      await requireContextPermission(
        command.client,
        'environment.manage',
        command.organizationId,
        actor,
      );
      return execution.enrollment.revoke(command.id, command.organizationId, command.revision);
    }
    if (action === 'rotateRunnerIdentity') {
      await requireContextPermission(
        command.client,
        'environment.manage',
        command.organizationId,
        actor,
      );
      return execution.enrollment.rotateIdentity(
        command.runnerId,
        command.organizationId,
        command.revision,
      );
    }
    if (action === 'revokeRunnerIdentity') {
      await requireContextPermission(
        command.client,
        'environment.manage',
        command.organizationId,
        actor,
      );
      return execution.enrollment.revokeIdentity(
        command.runnerId,
        command.organizationId,
        command.revision,
      );
    }
    await commandAuthorization.authorize(command, actor);
    if (moduleCommands.handles(action))
      return moduleCommands.execute(command, { validateClient: clientId, principal: actor });
    if (action === 'runTicket') return runTicket(command, actor);
    if (action === 'openTicketConversation') {
      const t = catalog.ticket(command.ticketId);
      if (!t) throw new Error('Ticket not found.');
      const existing = workExecution.sessionFor(t);
      if (existing?.conversationId) return conversations.current(existing);
      const linked = state.conversations.findLast((c) => c.linkedTicketIds.includes(t.id));
      if (linked) return linked;
      const c = await conversations.create({
        title: t.title,
        projectId: t.projectId,
        requestId: command.requestId,
      });
      await conversations.action(state.sessions[c.sessionId], {
        action: 'linkTicket',
        ticketId: t.id,
      });
      return c;
    }
    if (action === 'ensure') {
      if (!/^\d{1,10}$/.test(String(command.taskId)))
        throw new Error(
          'Legacy ensure requires a numeric ticket ID. Use createConversation for chat.',
        );
      const id = taskId(command.taskId);
      if (workExecution.sessionFor(catalog.ticket(id))) return;
      if (!state.sessions[id]) {
        const ticket = catalog.ticket(id);
        const s = {
          id,
          title: text(ticket?.title ?? command.title, 200),
          status: 'idle',
          model: models[0]?.id,
          messages: [],
          events: [],
          sequence: 0,
          instructions: [],
          checks: [],
          step: 0,
          completedStep: -1,
          lease: null,
          pending: null,
          workspace: null,
          workflow: null,
          requests: [],
          updatedAt: now(),
          partial: '',
        };
        if (models.some((m) => m.id === 'gpt-5.6-sol')) s.model = 'gpt-5.6-sol';
        const old = await readLegacyConversation(id);
        if (old) {
          s.messages = old.messages;
          for (const turn of old.turns) {
            event(s, 'user', { text: turn.text });
            event(s, 'assistant', { text: turn.reply, model: turn.model });
          }
        }
        if (
          typeof command.description !== 'undefined' &&
          (typeof command.description !== 'string' || command.description.length > 12000)
        )
          throw new Error('Task description is too large.');
        s.description = ticket?.description ?? command.description ?? '';
        if (!ticket)
          state.tickets.push({
            id: Number(id),
            title: s.title,
            description: s.description,
            projectId: state.projects[0].id,
            status: 'Backlog',
            label: 'Core',
            agent: 'Convoy',
            priority: 'Medium',
            revision: 1,
            placement: { mode: 'inherit' },
            createdAt: now(),
          });
        state.sessions[id] = s;
        conversations.adopt(s);
        await store.save();
      }
      return;
    }
    const s = command.sessionId ? state.sessions[taskId(command.sessionId)] : get(command.taskId);
    if (!s) throw new Error('Session not found.');
    if (!s.projectId) throw new Error('Not authorized.');
    await requireProjectPermission(s.projectId, 'project.write', actor);
    if (action === 'claim') {
      clientId(command.client);
      if (s.lease && s.lease.expiresAt > Date.now() && s.lease.client !== command.client)
        throw new Error(
          `Session controlled by ${s.lease.label}. Release it there or wait for the 90-second lease to expire.`,
        );
      s.lease = {
        id: randomUUID(),
        client: command.client,
        label: text(command.label ?? 'Client', 60),
        expiresAt: Date.now() + 90000,
      };
      await store.save();
      return;
    }
    own(s, command.client);
    if (
      [
        'start',
        'sendMessage',
        'resumeSession',
        'requestExecution',
        'startWorkflow',
        'continueWorkflow',
      ].includes(action)
    )
      s.executionPrincipal = structuredClone(actor);
    if (action === 'attachContext') {
      let input = command;
      let source;
      if (command.path !== undefined) {
        const path = text(command.path, 500);
        if (
          path.startsWith('/') ||
          path.includes('\\') ||
          path.split('/').some((p) => p === '..' || p === '.' || !p) ||
          path.includes('\0')
        )
          throw new Error('Use a relative file path inside the assigned workspace.');
        if (!s.workspace || !s.runnerId)
          throw new Error('No workspace assigned. Upload a file or assign a workspace first.');
        if (s.assignment?.state === 'uncertain')
          throw new Error('Reconcile the original runner before reading workspace files.');
        const workspace = s.workspace.path;
        const runnerId = s.runnerId;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let output;
        try {
          output = await runners.execute(
            runnerFor(s),
            { action: 'tool', workspace, name: 'read_file', args: { path } },
            controller.signal,
          );
        } finally {
          clearTimeout(timer);
        }
        if (controller.signal.aborted || workspace !== s.workspace?.path || runnerId !== s.runnerId)
          throw new Error('Workspace read was interrupted or assignment changed. Try again.');
        if (typeof output.text !== 'string' || output.truncated)
          throw new Error('Workspace file could not be read completely.');
        input = {
          name: path.split('/').at(-1),
          mime: 'text/plain',
          data: Buffer.from(output.text).toString('base64'),
        };
        source = { path, runnerId, workspace };
      }
      const attachment = await contextFiles.add(s, input, source);
      await store.save();
      return attachment;
    }
    if (
      s.interruption?.needsReview &&
      [
        'start',
        'startWorkflow',
        'continueWorkflow',
        'requestExecution',
        'releaseTicket',
        'configure',
      ].includes(action)
    )
      throw new Error('Review the interrupted operation and use Resume before continuing.');
    if (['requestExecution', 'releaseTicket'].includes(action) && s.pendingMessages?.length)
      throw new Error('Deliver or remove queued messages before changing assignment.');
    await commandAuthorization.authorizeSessionReferences(command, actor);
    if (sessionCommands.handles(action))
      return sessionCommands.execute(s, command, {
        principal: actor,
        assertProfileChange(session) {
          idle(session);
          if (
            engine.active(session) ||
            session.queuedInput ||
            session.pendingMessages?.length ||
            session.assignment?.state === 'uncertain'
          )
            throw new Error('Finish, cancel, or reconcile execution before changing profile.');
        },
      });
    if (action === 'release') {
      s.lease = null;
      await store.save();
      return;
    }
    if (action === 'heartbeat') {
      await store.save();
      return;
    }
    if (action === 'stop') {
      await requestStop(s);
      return;
    }
    if (action === 'reconcileAssignment') {
      idle(s);
      await placement.reconcile(s, command);
      return;
    }
    if (action === 'start') {
      const requestId = text(command.requestId, 80);
      if (s.requests.includes(requestId)) return;
      if (engine.active(s))
        throw new Error('Use workflow Continue, approval or feedback controls.');
      idle(s);
      if (s.queuedInput)
        throw new Error('This message is already queued. Stop it before sending another.');
      if (s.workflow && !['completed', 'cancelled'].includes(s.flow?.status))
        throw new Error('Use Start workflow to execute this definition.');
      if (!(await resolveSessionModel(s, command.model)))
        throw new Error('Unknown provider model.');
      await authorizeSessionModel(s, command.model);
      const input = text(command.text);
      s.model = command.model;
      s.requests.push(requestId);
      s.requests = s.requests.slice(-100);
      const c = conversations.current(s);
      if (c.title === 'New chat') {
        c.title = input.slice(0, 80);
        s.title = c.title;
      }
      s.status = 'running';
      s.partial = '';
      await store.save();
      if (!launch(s, input)) {
        s.queuedInput = input;
        s.status = 'queued';
        s.queueReason = 'Global concurrency limit reached.';
        await store.save();
      }
      return;
    }
    if (action === 'diff') {
      if (!['waiting_gate', 'awaiting_continue', 'completed'].includes(s.flow?.status)) idle(s);
      if (!s.workspace) throw new Error('No worktree assigned.');
      s.review = {
        ...(await runners.execute(runnerFor(s), { action: 'diff', workspace: s.workspace.path })),
        at: now(),
      };
      await store.save();
      return;
    }
    idle(s);
    if (action === 'configure') {
      return configuration.apply(s, command);
    }
    if (action === 'advance') {
      if (s.flow || s.workflow?.schemaVersion >= 3)
        throw new Error('Use the explicit workflow decision controls.');
      const step = (s.workflow?.nodes ?? s.workflow?.steps)?.[s.step];
      if (!step) throw new Error('No active workflow step.');
      if (step.kind === 'agent' && s.completedStep !== s.step)
        throw new Error('Complete an agent run for this step first.');
      let artifact;
      if (step.artifact) {
        const file = await tool(s, 'read_file', { path: step.artifact.path });
        const headings = file.text
          .split('\n')
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) =>
            line
              .replace(/^#{1,6} /, '')
              .trim()
              .toLowerCase(),
          );
        if (
          !file.text.trim() ||
          step.artifact.headings.some((h) => !headings.includes(h.toLowerCase()))
        )
          throw new Error('Required artifact or headings are missing.');
        artifact = { ...step.artifact, sha256: file.sha256 };
      }
      const review = await runners.execute(runnerFor(s), {
        action: 'diff',
        workspace: s.workspace.path,
        ignoreArtifact: step.artifact?.path,
      });
      if (
        step.requiresCheck &&
        !s.checks.some(
          (c) =>
            c.step === s.step &&
            c.command === step.checkCommand &&
            c.code === 0 &&
            !c.stopped &&
            !c.concurrent &&
            c.digest === review.digest,
        )
      )
        throw new Error(
          'This step requires the configured sandbox check to pass on the current workspace without concurrent session commands or terminals. Changes after checks require re-verification.',
        );
      event(s, 'workflow_approved', {
        step: s.step,
        name: step.name,
        artifact,
        reviewDigest: review.digest,
        client: s.lease.label,
      });
      s.step++;
      s.status = s.step >= (s.workflow.nodes ?? s.workflow.steps).length ? 'accepted' : 'idle';
      await store.save();
      return;
    }
    throw new Error('Unknown runtime command.');
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async readContext(sessionId, id, authenticatedPrincipal = localPrincipal) {
      await identity.assertPrincipalActive(authenticatedPrincipal);
      const s = state.sessions[taskId(sessionId)];
      if (!s) throw new Error('Conversation not found.');
      if (!s.projectId) throw new Error('Not authorized.');
      await requireProjectPermission(s.projectId, 'project.read', authenticatedPrincipal);
      return contextFiles.read(s, id);
    },
    async readTicketFile(ticketId, id, authenticatedPrincipal = localPrincipal) {
      await identity.assertPrincipalActive(authenticatedPrincipal);
      const ticket = catalog.ticket(ticketId);
      if (!ticket) throw new Error('Ticket not found.');
      await requireProjectPermission(ticket.projectId, 'project.read', authenticatedPrincipal);
      return catalog.readAttachment(ticketId, id);
    },
    identitySessions: {
      async authenticate(credential) {
        return identity.authenticateCredential(credential);
      },
      async bootstrap(input = {}) {
        if (deploymentIsRemote && state.identity.remoteBootstrapConsumedAt)
          throw new Error('Remote deployment bootstrap has already been completed.');
        if (deploymentIsRemote) state.identity.remoteBootstrapConsumedAt = now();
        let opened;
        try {
          opened = await identity.openDeviceSession({
            userId: 'local',
            deviceId: input.deviceId ?? 'bootstrap-client',
            ttlMs: input.ttlMs ?? 30 * 24 * 60 * 60 * 1000,
          });
        } catch (error) {
          if (deploymentIsRemote) delete state.identity.remoteBootstrapConsumedAt;
          throw error;
        }
        return {
          credential: opened.credential,
          principal: localPrincipal,
          session: opened.session,
        };
      },
      async login(input = {}) {
        const organizationId = text(input.organizationId, 200);
        const identityProviderId = text(input.identityProviderId, 200);
        const deviceId = text(input.deviceId, 200);
        const ttlMs = input.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
        const resolved = await enterpriseIdentityPorts.resolveLogin({
          organizationId,
          identityProviderId,
          request: input.request ?? {},
        });
        return provisionResolvedExternalIdentity(organizationId, identityProviderId, resolved, {
          deviceId,
          ttlMs,
        });
      },
      async logout(authentication) {
        if (authentication?.session?.id)
          await identity.revokeDeviceSession(authentication.session.id);
      },
      async identity(authentication) {
        await identity.assertPrincipalActive(authentication.principal);
        const projected = identity.snapshot(authentication.principal);
        return {
          principal: authentication.principal,
          currentUser: projected.currentUser,
          session: authentication.session,
        };
      },
    },
    runnerEnrollment: {
      redeem(input) {
        return execution.enrollment.redeem(input);
      },
      authenticate(credential, expected) {
        return execution.enrollment.authenticate(credential, expected);
      },
      authorizeChannel(input) {
        return execution.runnerChannels.validate(input);
      },
    },
    async snapshot(id, client, authenticatedPrincipal = localPrincipal) {
      await identity.assertPrincipalActive(authenticatedPrincipal);
      if (id !== undefined) {
        const session = get(id);
        if (!session.projectId) throw new Error('Not authorized.');
        await requireProjectPermission(session.projectId, 'project.read', authenticatedPrincipal);
      }
      return snapshot(id, client, authenticatedPrincipal);
    },
    command(input, authenticatedPrincipal = localPrincipal) {
      const command = validateRuntimeCommand(input);
      if (
        [
          'stop',
          'stopCommand',
          'readCommandOutput',
          'terminalStatus',
          'terminalConnection',
          'readTerminalOutput',
          'stopTerminal',
          'pauseWorkflow',
          'cancelWorkflow',
        ].includes(command.action)
      )
        return executeAudited(command, authenticatedPrincipal);
      const result = queue
        .catch(() => {})
        .then(async () => {
          const value = await executeAudited(command, authenticatedPrincipal);
          await dispatch();
          return value;
        });
      queue = result;
      return result;
    },
    close() {
      return (closePromise ??= (async () => {
        closing = true;
        clearInterval(dispatchTimer);
        for (const job of jobs.values()) job.controller.abort();
        await Promise.allSettled([...jobs.values()].map((j) => j.promise));
        await runners?.close?.();
        await sessionExecution.close();
        await store.save();
        await store.close?.();
      })());
    },
  };
}
