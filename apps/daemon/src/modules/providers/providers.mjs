import { createHash } from 'node:crypto';

const OWNER_KEYS = { user: 'userId', team: 'teamId', organization: 'organizationId' };

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

function clone(value) {
  return structuredClone(value);
}

function owner(owner) {
  const key = OWNER_KEYS[owner?.kind];
  const populated = Object.values(OWNER_KEYS).filter((candidate) => owner?.[candidate]);
  if (!key || !owner[key] || populated.length !== 1)
    throw new Error('A provider connection must have exactly one owner scope.');
  return { kind: owner.kind, [key]: owner[key] };
}

function secretReference(input) {
  if (!input || typeof input.kind !== 'string')
    throw new Error('A credential secret reference is required.');
  const allowedKeys = input.kind === 'none' ? ['kind'] : ['kind', 'reference', 'version'];
  if (
    (input.kind !== 'none' && (typeof input.reference !== 'string' || !input.reference)) ||
    Object.keys(input).some((key) => !allowedKeys.includes(key))
  ) {
    throw new Error('Credential material must be represented by a secret reference.');
  }
  return Object.fromEntries(
    allowedKeys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
  );
}

function revision(record) {
  const { revision: _ignored, ...content } = record;
  return digest(content);
}

function tenantRecord(records, organizationId, id, label) {
  const record = records.find(
    (candidate) => candidate.id === id && candidate.organizationId === organizationId,
  );
  if (!record) throw new Error(`${label} not found.`);
  return record;
}

function ownerAllows(connection, context) {
  if (connection.owner.kind === 'organization')
    return connection.owner.organizationId === context.organizationId;
  if (connection.owner.kind === 'team') return connection.owner.teamId === context.teamId;
  return connection.owner.userId === context.userId;
}

function capabilitiesAllow(offering, required = {}) {
  return Object.entries(required).every(([name, expected]) => {
    const actual = offering.verifiedCapabilities?.[name];
    return Array.isArray(expected)
      ? expected.every((value) => actual?.includes(value))
      : actual === expected;
  });
}

function intersection(left = [], right = []) {
  return left.some((value) => right.includes(value));
}

function costOf(outcome) {
  const value = outcome.usage?.costUsd;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function createProviders({
  state,
  save = async () => {},
  event = () => {},
  now = () => new Date().toISOString(),
  createId = (prefix) => `${prefix}_${crypto.randomUUID()}`,
}) {
  state.providerConnections ??= [];
  state.providerProbeEvidence ??= [];
  state.modelOfferings ??= [];
  state.modelRoutes ??= [];
  state.providerGrants ??= [];
  state.providerOutcomes ??= [];

  const administration = {
    async ensureSubscriptionCompatibility({
      organizationId = 'personal',
      userId = 'local',
      providerId,
      displayName,
      credentialRef,
      models,
    }) {
      const connectionId = `connection_${organizationId}_chatgpt_subscription`;
      let changed = false;
      let connection = state.providerConnections.find(
        (candidate) => candidate.id === connectionId && candidate.organizationId === organizationId,
      );
      if (!connection) {
        connection = {
          id: connectionId,
          organizationId,
          providerId,
          displayName,
          owner: { kind: 'user', userId },
          credentialRef: secretReference(credentialRef),
          state: 'ready',
          governance: { personalUse: 'allowed' },
          createdAt: now(),
        };
        connection.revision = revision(connection);
        state.providerConnections.push(connection);
        changed = true;
      }
      const catalogRevision = digest({
        connectionId,
        connectionRevision: connection.revision,
        models: models.map((model) => ({ id: model.id, input: model.input })),
      });
      if (!connection.catalogRevision) {
        connection.catalogRevision = catalogRevision;
        connection.revision = revision(connection);
        changed = true;
      }
      for (const model of models) {
        const offeringId = `offering_${organizationId}_${model.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        let offering = state.modelOfferings.find(
          (candidate) => candidate.id === offeringId && candidate.organizationId === organizationId,
        );
        if (!offering) {
          offering = {
            id: offeringId,
            organizationId,
            providerConnectionId: connection.id,
            upstreamModelId: model.id,
            displayName: model.name ?? model.id,
            verifiedCapabilities: {
              inputModalities: [...(model.input ?? ['text'])],
              outputModalities: ['text'],
              toolCalls: 'parallel',
              structuredOutput: false,
              reasoning: true,
              streaming: true,
            },
            capabilityEvidence: { source: 'subscription-compatibility-catalog', observedAt: now() },
            availability: 'available',
            observedAt: now(),
            catalogRevision: connection.catalogRevision,
          };
          state.modelOfferings.push(offering);
          changed = true;
        }
        const existingRoute = state.modelRoutes.find(
          (candidate) => candidate.id === model.id && candidate.organizationId === organizationId,
        );
        if (!existingRoute) {
          const route = {
            id: model.id,
            organizationId,
            name: model.name ?? model.id,
            purposes: ['coding'],
            selectors: [{ compatibilityAlias: model.id }],
            candidates: [{ connectionId: connection.id, offeringId: offering.id }],
            policy: { fallback: 'never' },
            state: 'active',
            createdAt: now(),
          };
          route.revision = revision(route);
          state.modelRoutes.push(route);
          changed = true;
        }
      }
      if (changed) await save();
      return clone(connection);
    },
    async recordSubscriptionProbe({ organizationId, connectionId, modelId, available, message }) {
      const connection = tenantRecord(
        state.providerConnections,
        organizationId,
        connectionId,
        'Provider connection',
      );
      if (connection.credentialRef?.kind !== 'subscription')
        throw new Error('Provider connection is not a subscription connection.');
      const offering = state.modelOfferings.find(
        (candidate) =>
          candidate.organizationId === organizationId &&
          candidate.providerConnectionId === connectionId &&
          candidate.upstreamModelId === modelId &&
          candidate.catalogRevision === connection.catalogRevision,
      );
      if (!offering) throw new Error('Subscription model offering not found.');
      const observedAt = now();
      offering.availability = available ? 'available' : 'unavailable';
      offering.observedAt = observedAt;
      offering.capabilityEvidence = { source: 'subscription-active-generation-probe', observedAt };
      connection.lastProbeAt = observedAt;
      connection.revision = revision(connection);
      const evidence = {
        id: createId('probe'),
        organizationId,
        providerConnectionId: connectionId,
        observedAt,
        catalogRevision: connection.catalogRevision,
        evidence: {
          status: available ? 'ready' : 'degraded',
          source: 'subscription-active-generation-probe',
          modelId,
          ...(message ? { message: String(message).slice(0, 1000) } : {}),
        },
      };
      state.providerProbeEvidence.push(evidence);
      await save();
      event({
        type: 'provider-connection-probed',
        organizationId,
        connectionId,
        revision: connection.revision,
        catalogRevision: connection.catalogRevision,
      });
      return {
        connection: clone(connection),
        evidence: clone(evidence),
        offering: clone(offering),
      };
    },
    async prepareProbe(input) {
      const connection = tenantRecord(
        state.providerConnections,
        input.organizationId,
        input.connectionId,
        'Provider connection',
      );
      if (connection.revision !== input.expectedRevision)
        throw new Error('Provider connection revision changed.');
      if (connection.state === 'revoked') throw new Error('Provider connection is revoked.');
      return clone(connection);
    },
    async createConnection(input) {
      if (!input.organizationId || !input.providerId || !input.displayName || !input.credentialRef)
        throw new Error('Provider connection fields are required.');
      const record = {
        id: createId('connection'),
        organizationId: input.organizationId,
        providerId: input.providerId,
        displayName: input.displayName,
        owner: owner(input.owner),
        endpoint: input.endpoint,
        credentialRef: secretReference(input.credentialRef),
        state: 'pending',
        governance: clone(input.governance ?? {}),
        createdAt: now(),
      };
      record.revision = revision(record);
      state.providerConnections.push(record);
      await save();
      event({
        type: 'provider-connection-created',
        organizationId: record.organizationId,
        connectionId: record.id,
        revision: record.revision,
      });
      return clone(record);
    },
    async recordProbe(input) {
      const connection = tenantRecord(
        state.providerConnections,
        input.organizationId,
        input.connectionId,
        'Provider connection',
      );
      if (connection.revision !== input.expectedRevision)
        throw new Error('Provider connection revision changed.');
      if (connection.state === 'revoked') throw new Error('Provider connection is revoked.');
      if (!['ready', 'degraded', 'unavailable'].includes(input.evidence?.status))
        throw new Error('Probe evidence status is invalid.');
      const observedAt = now();
      const catalogRevision = digest({
        connectionId: connection.id,
        connectionRevision: connection.revision,
        evidence: input.evidence,
        offerings: input.offerings ?? [],
        observedAt,
      });
      const evidence = {
        id: createId('probe'),
        organizationId: connection.organizationId,
        providerConnectionId: connection.id,
        observedAt,
        catalogRevision,
        evidence: clone(input.evidence),
      };
      const offerings = (input.offerings ?? []).map((inputOffering) => {
        if (
          !inputOffering.upstreamModelId ||
          !inputOffering.displayName ||
          !inputOffering.verifiedCapabilities
        )
          throw new Error('Observed model offering fields are required.');
        return {
          id: createId('offering'),
          organizationId: connection.organizationId,
          providerConnectionId: connection.id,
          upstreamModelId: inputOffering.upstreamModelId,
          displayName: inputOffering.displayName,
          verifiedCapabilities: clone(inputOffering.verifiedCapabilities),
          capabilityEvidence: clone(
            inputOffering.capabilityEvidence ?? {
              source: input.evidence.source ?? 'active-probe',
              observedAt,
            },
          ),
          availability: inputOffering.availability ?? 'unverified',
          observedAt,
          catalogRevision,
          estimatedCostUsd: inputOffering.estimatedCostUsd,
        };
      });
      connection.state = input.evidence.status;
      connection.lastProbeAt = observedAt;
      connection.catalogRevision = catalogRevision;
      connection.revision = revision(connection);
      state.providerProbeEvidence.push(evidence);
      state.modelOfferings.push(...offerings);
      await save();
      event({
        type: 'provider-connection-probed',
        organizationId: connection.organizationId,
        connectionId: connection.id,
        revision: connection.revision,
        catalogRevision,
      });
      return {
        connection: clone(connection),
        evidence: clone(evidence),
        offerings: clone(offerings),
      };
    },
    async createRoute(input) {
      if (!input.organizationId || !input.name || !input.candidates?.length)
        throw new Error('Model route fields are required.');
      for (const candidate of input.candidates) {
        const connection = tenantRecord(
          state.providerConnections,
          input.organizationId,
          candidate.connectionId,
          'Provider connection',
        );
        const offering = tenantRecord(
          state.modelOfferings,
          input.organizationId,
          candidate.offeringId,
          'Model offering',
        );
        if (offering.providerConnectionId !== connection.id)
          throw new Error('Route candidate offering does not belong to its connection.');
      }
      const record = {
        id: createId('route'),
        organizationId: input.organizationId,
        name: input.name,
        purposes: [...(input.purposes ?? [])],
        selectors: clone(input.selectors ?? []),
        candidates: clone(input.candidates),
        policy: clone(input.policy ?? {}),
        state: 'active',
        createdAt: now(),
      };
      record.revision = revision(record);
      state.modelRoutes.push(record);
      await save();
      event({
        type: 'model-route-created',
        organizationId: record.organizationId,
        routeId: record.id,
        revision: record.revision,
      });
      return clone(record);
    },
    async setCredentialReference(input) {
      const connection = tenantRecord(
        state.providerConnections,
        input.organizationId,
        input.connectionId,
        'Provider connection',
      );
      if (connection.revision !== input.expectedRevision)
        throw new Error('Provider connection revision changed.');
      if (connection.state === 'revoked') throw new Error('Provider connection is revoked.');
      connection.credentialRef = secretReference(input.credentialRef);
      connection.revision = revision(connection);
      await save();
      event({
        type: 'provider-credential-reference-set',
        organizationId: connection.organizationId,
        connectionId: connection.id,
        revision: connection.revision,
      });
      return clone(connection);
    },
    async revokeConnection(input) {
      const connection = tenantRecord(
        state.providerConnections,
        input.organizationId,
        input.connectionId,
        'Provider connection',
      );
      if (connection.revision !== input.expectedRevision)
        throw new Error('Provider connection revision changed.');
      if (connection.state === 'revoked') return clone(connection);
      connection.state = 'revoked';
      connection.revokedAt = now();
      connection.revocationReason = input.reason ?? 'administrative';
      connection.revision = revision(connection);
      await save();
      event({
        type: 'provider-connection-revoked',
        organizationId: connection.organizationId,
        connectionId: connection.id,
        revision: connection.revision,
      });
      return clone(connection);
    },
  };

  const routing = {
    async describeRoute(context, routeId) {
      const route = state.modelRoutes.find(
        (candidate) =>
          candidate.id === routeId &&
          candidate.organizationId === context?.organizationId &&
          candidate.state === 'active',
      );
      if (!route) return undefined;
      const offerings = route.candidates
        .map((candidate) =>
          state.modelOfferings.find(
            (offering) =>
              offering.id === candidate.offeringId &&
              offering.organizationId === route.organizationId,
          ),
        )
        .filter(Boolean);
      const supportsImages =
        offerings.length > 0 &&
        offerings.every((offering) =>
          offering.verifiedCapabilities?.inputModalities?.includes('image'),
        );
      return {
        id: route.id,
        name: route.name,
        input: supportsImages ? ['text', 'image'] : ['text'],
      };
    },
    async listEligibleRoutes(context, purpose) {
      return clone(
        state.modelRoutes
          .filter(
            (route) =>
              route.organizationId === context.organizationId &&
              route.state === 'active' &&
              (!route.purposes.length || route.purposes.includes(purpose)),
          )
          .map((route) => ({ id: route.id, name: route.name, revision: route.revision })),
      );
    },
    async resolveGrant(request) {
      const { context } = request;
      const existing = state.providerGrants.find(
        (grant) =>
          grant.organizationId === context.organizationId &&
          grant.sessionId === request.sessionId &&
          grant.turnId === request.turnId,
      );
      if (existing) {
        if (existing.routeId !== request.routeId)
          throw new Error('Turn already has a provider grant for another route.');
        return clone(existing);
      }
      const route = tenantRecord(
        state.modelRoutes,
        context.organizationId,
        request.routeId,
        'Model route',
      );
      if (
        route.state !== 'active' ||
        (route.purposes.length && !route.purposes.includes(request.purpose))
      )
        throw new Error('Model route is not eligible for this purpose.');
      const constraints = request.constraints ?? {};
      let selected;
      let budgetDenied = false;
      for (const candidate of route.candidates) {
        const connection = state.providerConnections.find(
          (value) =>
            value.id === candidate.connectionId && value.organizationId === context.organizationId,
        );
        const offering = state.modelOfferings.find(
          (value) =>
            value.id === candidate.offeringId && value.organizationId === context.organizationId,
        );
        if (!connection || !offering || offering.providerConnectionId !== connection.id) continue;
        if (
          connection.state !== 'ready' &&
          !(connection.state === 'degraded' && route.policy.allowDegraded)
        )
          continue;
        if (
          !['available', 'degraded'].includes(offering.availability) ||
          offering.catalogRevision !== connection.catalogRevision
        )
          continue;
        if (!ownerAllows(connection, context)) continue;
        if (
          connection.governance.allowedProjectIds?.length &&
          !connection.governance.allowedProjectIds.includes(context.projectId)
        )
          continue;
        if (
          route.policy.allowedProviderIds?.length &&
          !route.policy.allowedProviderIds.includes(connection.providerId)
        )
          continue;
        if (
          route.policy.allowedConnectionIds?.length &&
          !route.policy.allowedConnectionIds.includes(connection.id)
        )
          continue;
        if (
          route.policy.allowedModelIds?.length &&
          !route.policy.allowedModelIds.includes(offering.upstreamModelId)
        )
          continue;
        if (
          !capabilitiesAllow(offering, constraints.requiredCapabilities) ||
          !capabilitiesAllow(offering, candidate.requiredCapabilities)
        )
          continue;
        const allowedResidencies =
          candidate.allowedResidencies ??
          route.policy.allowedResidencies ??
          constraints.allowedResidencies;
        if (
          allowedResidencies?.length &&
          !intersection(allowedResidencies, offering.verifiedCapabilities.dataResidencies)
        )
          continue;
        const estimatedCostUsd = offering.estimatedCostUsd ?? 0;
        if (
          route.policy.maximumEstimatedCostUsdPerTurn != null &&
          estimatedCostUsd > route.policy.maximumEstimatedCostUsdPerTurn
        )
          continue;
        if (
          constraints.maximumEstimatedCostUsd != null &&
          estimatedCostUsd > constraints.maximumEstimatedCostUsd
        )
          continue;
        if (
          constraints.remainingBudgetUsd != null &&
          estimatedCostUsd > constraints.remainingBudgetUsd
        )
          continue;
        const spend = state.providerOutcomes.reduce(
          (totals, outcome) => {
            const outcomeGrant = state.providerGrants.find((grant) => grant.id === outcome.grantId);
            if (!outcomeGrant || outcomeGrant.organizationId !== context.organizationId)
              return totals;
            const cost = costOf(outcome);
            totals.organization += cost;
            if (outcomeGrant.projectId === context.projectId) totals.project += cost;
            if (outcomeGrant.userId === context.userId) totals.user += cost;
            if (context.teamId && outcomeGrant.teamId === context.teamId) totals.team += cost;
            return totals;
          },
          { organization: 0, project: 0, user: 0, team: 0 },
        );
        const budget = route.policy.budget ?? {};
        if (
          (budget.organizationUsd != null &&
            spend.organization + estimatedCostUsd > budget.organizationUsd) ||
          (budget.projectUsd != null && spend.project + estimatedCostUsd > budget.projectUsd) ||
          (budget.userUsd != null && spend.user + estimatedCostUsd > budget.userUsd) ||
          (budget.teamUsd != null && spend.team + estimatedCostUsd > budget.teamUsd)
        ) {
          budgetDenied = true;
          continue;
        }
        selected = { connection, offering, estimatedCostUsd };
        break;
      }
      if (!selected)
        throw new Error(
          budgetDenied
            ? 'Model route budget is exhausted.'
            : 'No policy-compliant model route candidate is available.',
        );
      const issuedAt = now();
      const expiresAt = new Date(
        Date.parse(issuedAt) + (route.policy.grantTtlMs ?? 300_000),
      ).toISOString();
      const grant = {
        id: createId('grant'),
        organizationId: context.organizationId,
        sessionId: request.sessionId,
        turnId: request.turnId,
        routeId: route.id,
        providerConnectionId: selected.connection.id,
        modelOfferingId: selected.offering.id,
        userId: context.userId,
        teamId: context.teamId,
        projectId: context.projectId,
        routeRevision: route.revision,
        connectionRevision: selected.connection.revision,
        catalogRevision: selected.offering.catalogRevision,
        policyRevision: context.policyRevision,
        purpose: request.purpose,
        constraints: clone(constraints),
        attempt: 1,
        estimatedCostUsd: selected.estimatedCostUsd,
        issuedAt,
        expiresAt,
      };
      grant.digest = digest(grant);
      state.providerGrants.push(grant);
      await save();
      event({
        type: 'provider-grant-resolved',
        organizationId: grant.organizationId,
        grantId: grant.id,
        digest: grant.digest,
      });
      return clone(grant);
    },
    async resolveFallbackGrant(previousGrantId) {
      const previous = state.providerGrants.find((candidate) => candidate.id === previousGrantId);
      if (!previous) throw new Error('Provider grant not found.');
      const existing = state.providerGrants.find(
        (candidate) => candidate.previousGrantId === previousGrantId,
      );
      if (existing) return clone(existing);
      const outcome = state.providerOutcomes.find(
        (candidate) => candidate.grantId === previousGrantId,
      );
      if (!outcome?.fallbackAllowed)
        throw new Error('Fallback is not permitted for this provider outcome.');
      const route = tenantRecord(
        state.modelRoutes,
        previous.organizationId,
        previous.routeId,
        'Model route',
      );
      if (route.state !== 'active' || route.revision !== previous.routeRevision)
        throw new Error('Model route authority changed before fallback.');
      const previousIndex = route.candidates.findIndex(
        (candidate) =>
          candidate.connectionId === previous.providerConnectionId &&
          candidate.offeringId === previous.modelOfferingId,
      );
      const context = {
        organizationId: previous.organizationId,
        userId: previous.userId,
        teamId: previous.teamId,
        projectId: previous.projectId,
      };
      const constraints = previous.constraints ?? {};
      let selected;
      for (const candidate of route.candidates.slice(previousIndex + 1)) {
        const connection = state.providerConnections.find(
          (value) =>
            value.id === candidate.connectionId && value.organizationId === previous.organizationId,
        );
        const offering = state.modelOfferings.find(
          (value) =>
            value.id === candidate.offeringId && value.organizationId === previous.organizationId,
        );
        if (!connection || !offering || offering.providerConnectionId !== connection.id) continue;
        if (
          connection.state !== 'ready' &&
          !(connection.state === 'degraded' && route.policy.allowDegraded)
        )
          continue;
        if (
          !['available', 'degraded'].includes(offering.availability) ||
          offering.catalogRevision !== connection.catalogRevision ||
          !ownerAllows(connection, context)
        )
          continue;
        if (
          connection.governance.allowedProjectIds?.length &&
          !connection.governance.allowedProjectIds.includes(previous.projectId)
        )
          continue;
        if (
          route.policy.allowedProviderIds?.length &&
          !route.policy.allowedProviderIds.includes(connection.providerId)
        )
          continue;
        if (
          route.policy.allowedConnectionIds?.length &&
          !route.policy.allowedConnectionIds.includes(connection.id)
        )
          continue;
        if (
          route.policy.allowedModelIds?.length &&
          !route.policy.allowedModelIds.includes(offering.upstreamModelId)
        )
          continue;
        if (
          !capabilitiesAllow(offering, constraints.requiredCapabilities) ||
          !capabilitiesAllow(offering, candidate.requiredCapabilities)
        )
          continue;
        selected = { connection, offering };
        break;
      }
      if (!selected) throw new Error('No policy-compliant fallback route candidate is available.');
      const issuedAt = now();
      const grant = {
        id: createId('grant'),
        organizationId: previous.organizationId,
        sessionId: previous.sessionId,
        turnId: previous.turnId,
        routeId: previous.routeId,
        providerConnectionId: selected.connection.id,
        modelOfferingId: selected.offering.id,
        userId: previous.userId,
        teamId: previous.teamId,
        projectId: previous.projectId,
        routeRevision: route.revision,
        connectionRevision: selected.connection.revision,
        catalogRevision: selected.offering.catalogRevision,
        policyRevision: previous.policyRevision,
        purpose: previous.purpose,
        constraints: clone(constraints),
        estimatedCostUsd: selected.offering.estimatedCostUsd ?? 0,
        issuedAt,
        expiresAt: new Date(
          Date.parse(issuedAt) + (route.policy.grantTtlMs ?? 300_000),
        ).toISOString(),
        attempt: (previous.attempt ?? 1) + 1,
        previousGrantId: previous.id,
      };
      grant.digest = digest(grant);
      state.providerGrants.push(grant);
      await save();
      event({
        type: 'provider-fallback-grant-resolved',
        organizationId: grant.organizationId,
        grantId: grant.id,
        previousGrantId: previous.id,
        digest: grant.digest,
      });
      return clone(grant);
    },
    async prepareDispatch(grantId, current = {}) {
      const grant = state.providerGrants.find((candidate) => candidate.id === grantId);
      if (!grant) throw new Error('Provider grant not found.');
      const outcome = state.providerOutcomes.find((candidate) => candidate.grantId === grant.id);
      if (outcome)
        throw new Error(
          outcome.reconciliationRequired
            ? 'Provider outcome is uncertain and requires reconciliation before retry.'
            : 'Provider grant already has terminal outcome evidence.',
        );
      const { digest: recordedDigest, ...unsigned } = grant;
      if (digest(unsigned) !== recordedDigest) throw new Error('Provider grant digest is invalid.');
      if (Date.parse(now()) >= Date.parse(grant.expiresAt))
        throw new Error('Provider grant expired.');
      const route = tenantRecord(
        state.modelRoutes,
        grant.organizationId,
        grant.routeId,
        'Model route',
      );
      const connection = tenantRecord(
        state.providerConnections,
        grant.organizationId,
        grant.providerConnectionId,
        'Provider connection',
      );
      const offering = tenantRecord(
        state.modelOfferings,
        grant.organizationId,
        grant.modelOfferingId,
        'Model offering',
      );
      if (connection.state === 'revoked') throw new Error('Provider connection is revoked.');
      if (
        route.revision !== grant.routeRevision ||
        connection.revision !== grant.connectionRevision ||
        offering.catalogRevision !== grant.catalogRevision
      )
        throw new Error('Provider grant authority changed before dispatch.');
      if (current.policyRevision && current.policyRevision !== grant.policyRevision)
        throw new Error('Provider policy changed before dispatch.');
      return {
        grant: clone(grant),
        connection: {
          id: connection.id,
          organizationId: connection.organizationId,
          providerId: connection.providerId,
          owner: clone(connection.owner),
          endpoint: clone(connection.endpoint),
          credentialRef: clone(connection.credentialRef),
          revision: connection.revision,
        },
        offering: {
          id: offering.id,
          upstreamModelId: offering.upstreamModelId,
          catalogRevision: offering.catalogRevision,
        },
      };
    },
    async recordOutcome(grantId, input) {
      const grant = state.providerGrants.find((candidate) => candidate.id === grantId);
      if (!grant) throw new Error('Provider grant not found.');
      const previous = state.providerOutcomes.find((candidate) => candidate.grantId === grant.id);
      if (previous) throw new Error('Provider grant already has terminal outcome evidence.');
      const classifications = [
        'not-sent',
        'rejected',
        'interrupted-known',
        'uncertain',
        'completed',
      ];
      if (!classifications.includes(input.classification))
        throw new Error('Provider outcome classification is invalid.');
      const route = tenantRecord(
        state.modelRoutes,
        grant.organizationId,
        grant.routeId,
        'Model route',
      );
      const fallbackAllowed =
        input.classification === 'not-sent'
          ? route.policy.fallback !== 'never'
          : input.classification === 'rejected' && route.policy.fallback === 'not-sent-or-rejected';
      const record = {
        id: createId('outcome'),
        organizationId: grant.organizationId,
        grantId: grant.id,
        classification: input.classification,
        providerRequestId: input.providerRequestId,
        usage: clone(input.usage ?? {}),
        evidence: clone(input.evidence ?? {}),
        observedAt: now(),
        fallbackAllowed,
        reconciliationRequired: input.classification === 'uncertain',
      };
      record.digest = digest(record);
      state.providerOutcomes.push(record);
      await save();
      event({
        type: 'provider-outcome-recorded',
        organizationId: record.organizationId,
        grantId: grant.id,
        classification: record.classification,
        digest: record.digest,
      });
      return clone(record);
    },
  };

  return {
    id: 'providers',
    administration,
    routing,
    snapshot(contextOrOrganizationId, { includeAll = false } = {}) {
      const context =
        typeof contextOrOrganizationId === 'string' ? undefined : contextOrOrganizationId;
      const organizationId = context?.organizationId ?? contextOrOrganizationId;
      const belongs = (record) => record.organizationId === organizationId;
      const visibleConnection = (connection) =>
        belongs(connection) && (!context || includeAll || ownerAllows(connection, context));
      const connectionIds = new Set(
        state.providerConnections.filter(visibleConnection).map((connection) => connection.id),
      );
      const offeringIds = new Set(
        state.modelOfferings
          .filter(
            (offering) => belongs(offering) && connectionIds.has(offering.providerConnectionId),
          )
          .map((offering) => offering.id),
      );
      const routeIds = new Set(
        state.modelRoutes
          .filter(
            (route) =>
              belongs(route) &&
              route.candidates.some(
                (candidate) =>
                  connectionIds.has(candidate.connectionId) &&
                  offeringIds.has(candidate.offeringId),
              ),
          )
          .map((route) => route.id),
      );
      const grantIds = new Set(
        state.providerGrants
          .filter(
            (grant) =>
              belongs(grant) &&
              routeIds.has(grant.routeId) &&
              (includeAll || !context || grant.userId === context.userId),
          )
          .map((grant) => grant.id),
      );
      return {
        providerConnections: state.providerConnections
          .filter(visibleConnection)
          .map((connection) => ({
            ...clone(connection),
            credentialRef: { kind: connection.credentialRef.kind },
          })),
        modelOfferings: state.modelOfferings
          .filter((offering) => belongs(offering) && offeringIds.has(offering.id))
          .map(clone),
        modelRoutes: state.modelRoutes
          .filter((route) => belongs(route) && routeIds.has(route.id))
          .map(clone),
        providerOutcomes: state.providerOutcomes
          .filter((outcome) => belongs(outcome) && grantIds.has(outcome.grantId))
          .map(clone),
      };
    },
  };
}
