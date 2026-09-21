import type { ModelOffering, ModelRoute, ProviderConnection } from '../../shared/api/runtime';

function ownerLabel(owner: ProviderConnection['owner']) {
  return owner.kind === 'organization'
    ? 'Organization'
    : owner.kind === 'team'
      ? 'Team'
      : 'Personal';
}

export function providerConnectionRows(
  connections: ProviderConnection[],
  offerings: ModelOffering[],
) {
  return connections.map((connection) => {
    const models = offerings.filter((offering) => offering.providerConnectionId === connection.id);
    const available = models.filter((offering) => offering.availability === 'available').length;
    const limits = [
      connection.governance.maximumConcurrency
        ? `${connection.governance.maximumConcurrency} concurrent`
        : undefined,
      connection.governance.monthlyBudgetUsd !== undefined
        ? `$${connection.governance.monthlyBudgetUsd} monthly budget`
        : undefined,
    ].filter(Boolean);
    return {
      id: connection.id,
      name: connection.displayName,
      providerId: connection.providerId,
      owner: ownerLabel(connection.owner),
      endpoint: connection.endpoint
        ? [connection.endpoint.origin, connection.endpoint.region].filter(Boolean).join(' · ')
        : 'Provider default',
      state: connection.state,
      offeringSummary: `${models.length} ${models.length === 1 ? 'model' : 'models'} · ${available} available`,
      governance: limits.join(' · ') || 'No published limits',
      lastProbeAt: connection.lastProbeAt,
    };
  });
}

export function modelRouteRows(routes: ModelRoute[], offerings: ModelOffering[]) {
  return routes.map((route) => ({
    id: route.id,
    name: route.name,
    purposes: route.purposes.join(', ') || 'General',
    state: route.state,
    candidates:
      route.candidates
        .map((candidate) => {
          const offering = offerings.find((value) => value.id === candidate.offeringId);
          return offering
            ? `${offering.displayName} (${offering.availability})`
            : `${candidate.offeringId} (unavailable)`;
        })
        .join(' -> ') || 'No candidates',
    fallback: (route.policy.fallback ?? 'never').replaceAll('-', ' '),
    limit:
      route.policy.maximumEstimatedCostUsdPerTurn !== undefined
        ? `$${route.policy.maximumEstimatedCostUsdPerTurn} maximum estimated cost per turn`
        : 'No published per-turn cost limit',
  }));
}
