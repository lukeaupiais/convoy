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
  moduleSnapshots,
  canMessage,
  auth,
  models,
  provider,
  accessScope = async () => undefined,
  allowLegacyProvider = () => true,
}) {
  return async function snapshot(id, client, principal) {
    const scope = await accessScope({ id, client, principal });
    const legacyProviderVisible = await allowLegacyProvider({ principal, scope });
    const moduleState = Object.assign(
      {},
      ...(await Promise.all(
        moduleSnapshots.map((module) => module.snapshot({ id, client, principal, scope })),
      )),
    );
    const sessions = (id ? [getSession(id)] : Object.values(state.sessions)).filter(
      (session) => !scope || scope.projectIds.includes(session.projectId),
    );
    const publicSessions = sessions.map(
      ({ messages, requests, steeringRequests, agentSessions, executionPrincipal, ...session }) => {
        const activeAgentStep =
          session.flow && !['completed', 'cancelled'].includes(session.flow.status)
            ? (session.workflow?.nodes ?? session.workflow?.steps ?? []).find(
                (node) => node.id === session.flow.nodeId && node.kind === 'agent',
              )
            : undefined;
        return {
          ...session,
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

    return structuredClone({
      ...moduleState,
      approvalRules: state.approvalRules.filter(
        (rule) => !scope || scope.projectIds.includes(rule.projectId),
      ),
      workflowEffects: Object.entries(state.workflowEffectLedger)
        .filter(([, effect]) => !scope || scope.projectIds.includes(effect.projectId))
        .map(([effectKey, effect]) => ({
          effectKey,
          status: effect.status,
          operation: effect.operation,
          at: effect.at,
          reconciledAt: effect.reconciledAt,
          message: effect.message,
        })),
      workflowTriggerFailures: state.workflowTriggerFailures
        .filter((failure) => {
          const ticket = state.tickets.find((candidate) => candidate.id === failure.ticketId);
          return !scope || scope.projectIds.includes(ticket?.projectId);
        })
        .slice(-100),
      workflowTriggers: Object.entries(state.workflowTriggerLedger)
        .filter(([, trigger]) => {
          const ticket = state.tickets.find((candidate) => candidate.id === trigger.ticketId);
          return !scope || scope.projectIds.includes(ticket?.projectId);
        })
        .map(([triggerKey, trigger]) => ({ triggerKey, ...trigger })),
      sessions: publicSessions,
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
