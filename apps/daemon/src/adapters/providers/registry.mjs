/** Selects a protocol adapter from a provider connection without owning routing policy. */
export function createProviderAdapterRegistry(registrations = {}) {
  const factories = new Map(Object.entries(registrations));

  return Object.freeze({
    adapterFor(connection) {
      const factory = factories.get(connection?.providerId);
      if (!factory)
        throw new Error(
          `No provider adapter is registered for ${connection?.providerId ?? 'unknown'}.`,
        );
      const adapter = factory({ connection: structuredClone(connection) });
      if (!adapter || typeof adapter.generate !== 'function')
        throw new Error(`Provider adapter ${connection.providerId} cannot generate.`);
      return adapter;
    },
  });
}
