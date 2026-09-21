# Control plane

The control plane coordinates use cases over injected ports. `runtime.mjs` is a
thin command/snapshot façade. `agent-execution.mjs` owns one provider/tool turn;
`agent-turns.mjs` owns durable human gates and context compaction;
`workflow-effects.mjs` owns fail-closed workflow effects. This layer must not
import HTTP, bootstrap, or infrastructure adapters directly.

Coordinates use cases that cross domain modules: starting an agent turn,
dispatching a workflow node, assigning a runner, and projecting a client snapshot.
It is the transaction/orchestration layer, not a home for every rule.

- `runtime.mjs` exposes the command, snapshot, stream, and shutdown façade.
- `module-command-registry.mjs` assigns a runtime command to exactly one domain
  module at composition time; duplicate ownership fails at startup.
- `runtime-command-validation.mjs` is the executable boundary schema for every
  public runtime command.
- `agent-execution.mjs` runs the provider loop and dispatches visible tools.
- `state-schema.mjs` owns persisted-state defaults and migrations.
- `snapshot-query.mjs` projects internal state into client read models.
- `ticket-run.mjs` coordinates idempotent ticket-to-workflow execution.
- `work-execution.mjs` and `workflow-references.mjs` expose narrow cross-owner
  queries instead of allowing Work to traverse another module's storage.

Extract cohesive policy back into its owning module. Keep mutation ordering,
cross-module transactions, and fail-closed uncertainty handling here.
