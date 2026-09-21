import type {
  ModelOffering,
  ProviderConnection,
  ProviderConnectionOwner,
  RuntimeState,
} from '../../shared/api/runtime';

type OwnerOption = { value: string; label: string };

export function providerAdministrationModel(
  state: Pick<
    RuntimeState,
    'activeContext' | 'currentUser' | 'memberships' | 'organizations' | 'teams'
  >,
) {
  const organizationId = state.activeContext?.organizationId;
  const organization = state.organizations?.find((item) => item.id === organizationId);
  const userId = state.currentUser?.id;
  const roles = (state.memberships ?? [])
    .filter(
      (membership) =>
        membership.organizationId === organizationId &&
        membership.state === 'active' &&
        membership.principal.kind === 'user' &&
        membership.principal.userId === userId &&
        membership.scope.kind === 'organization',
    )
    .flatMap((membership) => membership.roles);
  const canManage = roles.some((role) => role === 'owner' || role === 'admin');
  const owners: OwnerOption[] = [];

  if (organizationId) {
    owners.push({
      value: `organization:${organizationId}`,
      label: `Organization · ${organization?.displayName ?? organizationId}`,
    });
    for (const team of state.teams ?? []) {
      if (team.organizationId === organizationId && team.state === 'active') {
        owners.push({ value: `team:${team.id}`, label: `Team · ${team.displayName}` });
      }
    }
    if (userId) owners.push({ value: `user:${userId}`, label: `Personal · ${userId}` });
  }

  return {
    organizationId,
    canManage,
    owners,
    permissionMessage: canManage
      ? undefined
      : 'Provider changes require an active organization owner or admin membership.',
  };
}

export function parseProviderOwner(value: string): ProviderConnectionOwner {
  const [kind, id] = value.split(':', 2);
  if (kind === 'organization') return { kind, organizationId: id };
  if (kind === 'team') return { kind, teamId: id };
  if (kind === 'user') return { kind, userId: id };
  throw new Error('Choose a valid provider owner.');
}

export function modelRouteCandidateOptions(
  connections: Array<Pick<ProviderConnection, 'id' | 'displayName' | 'state'>>,
  offerings: Array<
    Pick<ModelOffering, 'id' | 'providerConnectionId' | 'displayName' | 'availability'>
  >,
) {
  const visibleConnections = new Map(
    connections
      .filter((connection) => connection.state !== 'revoked')
      .map((connection) => [connection.id, connection]),
  );
  return offerings.flatMap((offering) => {
    const connection = visibleConnections.get(offering.providerConnectionId);
    return connection && ['available', 'degraded'].includes(offering.availability)
      ? [
          {
            value: `${connection.id}:${offering.id}`,
            connectionId: connection.id,
            offeringId: offering.id,
            label: `${connection.displayName} · ${offering.displayName} (${offering.availability})`,
          },
        ]
      : [];
  });
}
