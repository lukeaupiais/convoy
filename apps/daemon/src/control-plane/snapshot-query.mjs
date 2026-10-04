import { workAutomationCapabilities, resolveBoardEffect } from '../modules/work/index.mjs';
import { boardAutomationRelationships } from '../modules/workflows/index.mjs';

const adapterInventory = (provider) => [
  {
    id: 'convoy',
    kind: 'harness',
    available: true,
    capabilities: [
      'durable-events',
      'native-chat-attach',
      'native-workspace-terminal',
      'approval-gated-tools',
      'session-owned-commands',
      'workflows',
      'local-and-ssh-runners',
    ],
  },
  {
    id: provider.id,
    kind: 'provider',
    available: true,
    capabilities: provider.capabilities,
  },
  ...['codex-cli', 'pi-agent', 'opencode', 'claude-code'].map((id) => ({
    id,
    kind: 'external-harness',
    available: false,
    capabilities: [],
  })),
];

/**
 * Build the read model consumed by the web and terminal clients.
 * Internal messages and idempotency ledgers never cross this seam.
 */
export function createSnapshotQuery({
  state,
  getSession,
  jobs,
  capabilities,
  guidanceView = (session) => session.workspaceGuidance,
  moduleSnapshots,
  canMessage,
  auth,
  models,
  provider,
  accessScope = async () => undefined,
  allowLegacyProvider = () => true,
  workflowEffectSummaries = () => [],
}) {
  return async function snapshot(id, client, principal, { view } = {}) {
    const scope = await accessScope({ id, client, principal });
    const legacyProviderVisible = await allowLegacyProvider({ principal, scope });
    const moduleState = Object.assign(
      {},
      ...(await Promise.all(
        moduleSnapshots.map((module) => module.snapshot({ id, client, principal, scope })),
      )),
    );
    const includeSessionDetails = id !== undefined || view !== 'overview';
    const sessions = (includeSessionDetails ? (id ? [getSession(id)] : Object.values(state.sessions)) : []).filter(
      (session) => !scope || scope.projectIds.includes(session.projectId),
    );
    const publicSessions = sessions.map(
      ({ messages, requests, steeringRequests, agentSessions, executionPrincipal, flow, workflowRunId, pastRuns, lease, ...session }) => {
        const publicLease = lease ? Object.fromEntries(Object.entries(lease).filter(([key]) => key !== 'actorKey')) : null;
        const publicFlow = flow ? structuredClone(flow) : null;
        // Exact approval input/effect material is returned only by the
        // execute-authorized, leased prepare command, never by project reads.
        for (const history of publicFlow?.history ?? []) delete history.activityReservation;
        if (publicFlow) session.flow = publicFlow;
        const publicPastRuns = (pastRuns ?? []).slice(-50).map(run => {
          const value = structuredClone(run);
          for (const history of value.history ?? []) delete history.activityReservation;
          return value;
        });
        if (workflowRunId) session.workflowRunId = workflowRunId;
        const runHistory = pastRuns ?? [];
        const activeAgentStep =
          flow && !['completed', 'cancelled'].includes(flow.status)
            ? (session.workflow?.nodes ?? session.workflow?.steps ?? []).find(
                (node) => node.id === flow.nodeId && node.kind === 'agent',
              )
            : undefined;
        return {
          ...session,
          lease: publicLease,
          workflowRunId: workflowRunId ?? flow?.id,
          pastRuns: publicPastRuns,
          pastRunsTotal: runHistory.length,
          pastRunsTruncated: runHistory.length > 50,
          flow: publicFlow,
          workspaceGuidance: guidanceView(session),
          ...(jobs.has(session.id) && session.status === 'awaiting_review'
            ? { status: 'running' }
            : {}),
          control: {
            busy: jobs.has(session.id),
            stopping: Boolean(session.stopRequested),
            canMessage: canMessage(session),
          },
          effectiveCapabilities: capabilities.preview(session, activeAgentStep),
          agentSessions: Object.values(agentSessions ?? {}).map(
            ({ messages: agentMessages, ...record }) => ({
              ...record,
              messageCount: agentMessages.length,
            }),
          ),
          events: session.events.slice(-500),
        };
      },
    );

    const automationDecisions = moduleState.automationDecisions ?? [];
    const descriptorCapabilities = (moduleState.workflowEventDescriptors ?? []).flatMap(descriptor => {
      const scope = descriptor.tenantScope;
      return [descriptor.id, ...(descriptor.aliases ?? [])].map(id => ({
        id, descriptorId: descriptor.id, revision: descriptor.revision, label: descriptor.label,
        scope: workAutomationCapabilities.events.find(event => event.id === id)?.scope ?? scope,
        fields: [...new Set([...(workAutomationCapabilities.events.find(event => event.id === id)?.fields ?? []), ...descriptor.payload.map(field => field.path)])],
        payload: descriptor.payload,
        manual: descriptor.manual === true,
      }));
    });
    const automationCapabilities = {
      ...workAutomationCapabilities,
      events: descriptorCapabilities.length ? descriptorCapabilities : workAutomationCapabilities.events,
      ruleActions: [{ id: 'start_workflow', label: 'Start workflow' }],
    };
    const boardAutomations = boardAutomationRelationships({
      boards: moduleState.boards ?? [],
      projects: moduleState.projects ?? [],
      workflows: moduleState.workflows ?? [],
      rules: moduleState.automations ?? [],
      decisions: automationDecisions,
      eventLabels: Object.fromEntries(automationCapabilities.events.map((event) => [event.id, event.label])),
      resolveEffect: (input) =>
        resolveBoardEffect({
          ...input,
          connections: moduleState.ticketConnections ?? [],
          bindings: moduleState.ticketImportBindings ?? [],
          tickets: moduleState.tickets ?? [],
        }),
    });
    return structuredClone({
      ...moduleState,
      boardAutomations,
      approvalRules: state.approvalRules.filter(
        (rule) => !scope || scope.projectIds.includes(rule.projectId),
      ),
      workflowEffects: workflowEffectSummaries(scope?.projectIds),
      automationFailures: moduleState.automationFailures ?? [],
      automationCapabilities,
      automationDecisions,
      sessions: publicSessions,
      sessionDetailsIncluded: includeSessionDetails,
      auth: legacyProviderVisible
        ? await auth.status()
        : { source: 'unavailable', connected: false, device: { state: 'idle' } },
      models: legacyProviderVisible ? models : [],
      modelChecks: legacyProviderVisible ? state.modelChecks : {},
      adapters: legacyProviderVisible
        ? adapterInventory(provider)
        : adapterInventory(provider).filter((adapter) => adapter.id !== provider.id),
    });
  };
}
