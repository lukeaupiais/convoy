import { createPlacement } from './placement.mjs';
import { createExecutionPolicy } from './policy.mjs';
import { createEnvironmentAccess } from './access.mjs';
import { createRunnerEnrollment } from './enrollment.mjs';
import { createChannelGrants } from './channel-grants.mjs';
import { createRunnerChannelAuthorization } from './runner-channel-authorization.mjs';
import { createCapacity } from './capacity.mjs';

const commands = [
  'connectRemote',
  'registerRunner',
  'probeRunner',
  'saveEnvironment',
  'saveRunnerPool',
  'updateRunner',
  'setPlacement',
  'setExecutionProfile',
  'setScheduler',
];

/**
 * Execution owns runner registration, placement policy, and scheduling state.
 * Session lifecycle commands are a separate, session-owned interface because
 * they require an already-authorized session lease.
 */
export function createExecution(dependencies) {
  const policy = createExecutionPolicy(dependencies);
  const access = createEnvironmentAccess(dependencies);
  const capacity = createCapacity({ ...dependencies, provider: dependencies.capacityProvider });
  const placement = createPlacement({ ...dependencies, policy, access, capacity });
  const enrollment = createRunnerEnrollment(dependencies);
  const channelGrants = createChannelGrants(dependencies);
  const runnerChannels = createRunnerChannelAuthorization({ enrollment, channelGrants });
  return {
    id: 'execution',
    commands,
    placement,
    policy,
    access,
    enrollment,
    channelGrants,
    runnerChannels,
    capacity,
    snapshot({ scope } = {}) {
      const value = {
        ...placement.snapshot(),
        runners: placement.snapshot().runners.map((runner) => ({
          ...runner,
          ...(runner.machineIdentity
            ? {
                machineIdentity: Object.fromEntries(
                  Object.entries(runner.machineIdentity).filter(
                    ([key]) => key !== 'credentialDigest',
                  ),
                ),
              }
            : {}),
        })),
        executionProfiles: policy.profiles(),
        runnerEnrollments: (dependencies.state.runnerEnrollments ?? []).map(
          ({ tokenDigest: _secret, ...value }) => structuredClone(value),
        ),
        channelGrants: (dependencies.state.channelGrants ?? []).map(
          ({ tokenDigest: _secret, actorKey: _actorKey, ...value }) => structuredClone(value),
        ),
        capacityRequests: capacity.requests(),
        capacityStatuses: capacity.statuses(),
      };
      if (!scope) return value;
      const organizationId = scope.organizationId;
      const environmentIds = new Set(
        value.environments
          .filter((environment) => environment.organizationId === organizationId)
          .map((environment) => environment.id),
      );
      return {
        ...value,
        scheduler: dependencies.state.schedulers?.[organizationId] ?? dependencies.state.scheduler,
        environments: value.environments.filter(
          (environment) => environment.organizationId === organizationId,
        ),
        runnerPools: value.runnerPools.filter((pool) => pool.organizationId === organizationId),
        environmentAccessBindings: value.environmentAccessBindings.filter(
          (binding) => binding.organizationId === organizationId,
        ),
        runnerEnrollments: value.runnerEnrollments.filter(
          (enrollment) => enrollment.organizationId === organizationId,
        ),
        channelGrants: value.channelGrants.filter(
          (grant) => grant.organizationId === organizationId,
        ),
        capacityRequests: value.capacityRequests.filter(
          (request) => request.organizationId === organizationId,
        ),
        capacityStatuses: value.capacityStatuses.filter(
          (status) => status.organizationId === organizationId,
        ),
        runners: value.runners.filter(
          (runner) =>
            runner.organizationId === organizationId && environmentIds.has(runner.environmentId),
        ),
      };
    },
    command(command) {
      return placement.command(command);
    },
    runnerSelection(session, runnerId) {
      const runner = dependencies.state.runners.find((candidate) => candidate.id === runnerId);
      if (!runner || !runner.online) throw new Error('Probe an available runner first.');
      if (
        !runner.projectIds.includes(session.projectId) ||
        !placement.env(runner.environmentId).enabled ||
        !runner.enabled ||
        !access.authorize(session, placement.env(runner.environmentId), 'use', {
          executionProfile: policy.selected(session),
          repository: runner.repository,
        }).allowed
      )
        throw new Error('Runner is disabled or not authorized for this project.');
      return { placement: placement.policy({ mode: 'pinned', runnerId: runner.id }) };
    },
    prepare(session) {
      return placement.prepare(session);
    },
    release(session) {
      return placement.release(session);
    },
  };
}
