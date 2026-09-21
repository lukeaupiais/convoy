function capabilities(model, adapter) {
  if (model.verifiedCapabilities) return structuredClone(model.verifiedCapabilities);
  return {
    inputModalities: model.input ?? ['text'],
    outputModalities: model.output ?? ['text'],
    streaming: adapter.capabilities?.includes('streaming') ?? true,
    toolCalls: adapter.capabilities?.includes('tool-calls') ? 'parallel' : undefined,
  };
}

/** Executes provider inspection inside the daemon and records only observed evidence. */
export function createProviderProbe({ administration, credentialBroker, adapters }) {
  if (!administration || !credentialBroker || !adapters)
    throw new Error('Provider probe ports are required.');
  return Object.freeze({
    async run(input) {
      const connection = await administration.prepareProbe(input);
      const credential = await credentialBroker.resolve({
        organizationId: connection.organizationId,
        providerConnectionId: connection.id,
        credentialRef: connection.credentialRef,
        purpose: 'discover-models',
        actor: input.actor,
        context: input.context,
        expectedRevision: connection.revision,
        signal: input.signal,
      });
      const adapter = adapters.adapterFor(connection);
      if (
        typeof adapter.inspectConnection !== 'function' ||
        typeof adapter.discoverModels !== 'function'
      )
        throw new Error(`Provider adapter ${connection.providerId} cannot be actively probed.`);
      const inspection = await adapter.inspectConnection({
        token: credential.value,
        signal: input.signal,
      });
      const models = await adapter.discoverModels({
        token: credential.value,
        signal: input.signal,
      });
      return administration.recordProbe({
        organizationId: connection.organizationId,
        connectionId: connection.id,
        expectedRevision: connection.revision,
        evidence: {
          status: inspection.available === false ? 'degraded' : 'ready',
          source: 'server-active-probe',
          protocol: adapter.protocol,
          inspection: structuredClone(inspection),
        },
        offerings: models.map((model) => ({
          upstreamModelId: model.id,
          displayName: model.name ?? model.id,
          availability: 'available',
          verifiedCapabilities: capabilities(model, adapter),
          capabilityEvidence: { source: 'server-active-probe' },
        })),
      });
    },
  });
}
