/**
 * Deterministic read-only adapter for acceptance tests and future adapter
 * conformance suites. It intentionally exposes no lifecycle operation.
 */
export function createDeterministicCapacityAdapter({ observations = [] } = {}) {
  let index = 0;
  const calls = [];
  return {
    id: 'deterministic-fake',
    kind: 'static',
    calls,
    async observe(input) {
      calls.push(structuredClone(input));
      const selected = observations[Math.min(index, Math.max(observations.length - 1, 0))];
      index += 1;
      return structuredClone(
        selected ?? {
          availableCapacity: input.availableCapacity,
          drainState: input.drainState,
        },
      );
    },
  };
}
