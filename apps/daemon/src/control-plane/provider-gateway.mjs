function actor(context) {
  if (context?.principal?.kind) return structuredClone(context.principal);
  if (context?.workloadIdentityId)
    return { kind: 'workload', workloadIdentityId: context.workloadIdentityId };
  if (context?.servicePrincipalId)
    return { kind: 'service-principal', servicePrincipalId: context.servicePrincipalId };
  return { kind: 'user', userId: context?.userId };
}

function publicGrant(grant) {
  return Object.freeze({ id: grant.id, digest: grant.digest });
}

function auditEntry({ input, context, grant, plan, outcome, classification, usage, requestId }) {
  return {
    organizationId: grant.organizationId,
    actor: actor(context),
    context: {
      teamId: context.teamId,
      projectId: context.projectId,
      sessionId: input.sessionId,
      turnId: input.turnId,
    },
    action: outcome === 'resolved' ? 'provider.grant.resolve' : 'provider.dispatch',
    resource: { kind: 'provider-grant', id: grant.id },
    decision: 'allow',
    outcome,
    revisions: {
      membershipRevision: context.membershipRevision,
      policyRevision: grant.policyRevision,
      routeRevision: grant.routeRevision,
      connectionRevision: grant.connectionRevision,
      providerGrantDigest: grant.digest,
    },
    provider: {
      providerId: plan?.connection.providerId,
      connectionId: grant.providerConnectionId,
      modelOfferingId: grant.modelOfferingId,
      routeId: grant.routeId,
      grantId: grant.id,
      requestId,
      outcomeClass: classification,
    },
    traceId: input.traceId,
    correlationId: input.correlationId,
    observations: {
      usage,
      failureClass: classification,
      reconciliationRequired: classification === 'uncertain',
    },
  };
}

/** Central daemon-only model dispatch. Secrets exist only between broker and adapter. */
export function createProviderGateway({
  routing,
  credentialBroker,
  adapters,
  authorizeContext = async () => true,
  audit = async () => {},
  legacyModels = [],
  legacyGenerate,
}) {
  if (!routing || !credentialBroker || !adapters || typeof legacyGenerate !== 'function')
    throw new Error('Provider gateway ports are required.');
  const legacyById = new Map(legacyModels.map((model) => [model.id, model]));

  async function describeModel(selection, context) {
    const legacy = legacyById.get(selection);
    if (legacy) return structuredClone(legacy);
    const route = await routing.describeRoute(context, selection);
    return route ? structuredClone(route) : undefined;
  }
  const isLegacyModel = (selection) => legacyById.has(selection);

  async function* generate(input) {
    if (legacyById.has(input.model)) {
      yield* legacyGenerate(input);
      return;
    }
    const { context, purpose, sessionId, turnId, constraints, ...providerInput } = input;
    if (!context || !purpose || !sessionId || !turnId)
      throw new Error('Routed model dispatch context is required.');
    if (!(await authorizeContext(context, purpose)))
      throw new Error('Provider dispatch is no longer authorized.');
    let grant = await routing.resolveGrant({
      context,
      routeId: input.model,
      purpose,
      sessionId,
      turnId,
      constraints,
    });

    while (grant) {
      let dispatched = false;
      let terminal = false;
      let yielded = false;
      let plan;
      try {
        plan = await routing.prepareDispatch(grant.id, { policyRevision: context.policyRevision });
        await audit(auditEntry({ input, context, grant, plan, outcome: 'resolved' }));
        if (!(await authorizeContext(context, purpose, plan)))
          throw new Error('Provider dispatch is no longer authorized.');
        const credential = await credentialBroker.resolve({
          organizationId: plan.grant.organizationId,
          providerConnectionId: plan.connection.id,
          credentialRef: plan.connection.credentialRef,
          purpose: 'generate',
          actor: actor(context),
          sessionId,
          turnId,
          grantId: grant.id,
          policyRevision: context.policyRevision,
          signal: input.signal,
        });
        if (input.signal?.aborted) {
          const aborted = new Error('Request was aborted before provider dispatch.');
          aborted.providerOutcome = 'interrupted-known';
          throw aborted;
        }
        const adapter = adapters.adapterFor(plan.connection);
        if (!(await authorizeContext(context, purpose, plan)))
          throw new Error('Provider dispatch is no longer authorized.');
        dispatched = true;
        await audit(auditEntry({ input, context, grant, plan, outcome: 'started' }));
        for await (const item of adapter.generate({
          ...providerInput,
          model: plan.offering.upstreamModelId,
          token: credential.value,
          providerGrant: publicGrant(grant),
          sessionId,
          turnId,
        })) {
          yielded = true;
          if (item.type === 'result') {
            terminal = true;
            await routing.recordOutcome(grant.id, {
              classification: 'completed',
              providerRequestId: item.providerRequestId,
              usage: item.usage,
            });
            await audit(
              auditEntry({
                input,
                context,
                grant,
                plan,
                outcome: 'completed',
                classification: 'completed',
                usage: item.usage,
                requestId: item.providerRequestId,
              }),
            );
          }
          yield item;
        }
        if (!terminal) throw new Error('Provider stream ended before a terminal response.');
        return;
      } catch (error) {
        if (terminal) throw error;
        const classification = yielded
          ? 'uncertain'
          : (error.providerOutcome ?? (dispatched ? 'uncertain' : 'not-sent'));
        let recorded;
        try {
          recorded = await routing.recordOutcome(grant.id, {
            classification,
            providerRequestId: error.providerRequestId,
            usage: error.usage,
            evidence: { message: error.publicMessage ?? 'Provider dispatch failed.' },
          });
        } catch (outcomeError) {
          if (!/terminal outcome evidence/.test(outcomeError.message))
            throw new AggregateError(
              [error, outcomeError],
              'Provider failed and its outcome evidence could not be recorded.',
            );
        }
        await audit(
          auditEntry({
            input,
            context,
            grant,
            plan,
            outcome: classification === 'uncertain' ? 'uncertain' : 'failed',
            classification,
            usage: error.usage,
            requestId: error.providerRequestId,
          }),
        );
        if (recorded?.fallbackAllowed && !yielded) {
          grant = await routing.resolveFallbackGrant(grant.id);
          continue;
        }
        throw error;
      }
    }
  }
  return Object.freeze({ describeModel, isLegacyModel, generate });
}
