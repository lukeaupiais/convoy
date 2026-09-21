# Architecture

Convoy is a central control plane with portable workers. The daemon owns durable
coordination and credentials; a worker executes repository operations in a local
or SSH environment; web and CLI clients observe and command the same sessions.

```text
Web / CLI
    | typed commands, snapshots, SSE
    v
Daemon HTTP -> Control plane -> Domain modules
                         |       |
                         |       -> persisted state
                         v
                  runner adapter -> local/SSH worker -> repository worktree
                         |
                         -> provider adapter -> model API/subscription
```

## Dependency rules

1. Applications may use packages; packages never use applications.
2. Web code may use contracts, never daemon/worker/runner implementation.
3. Daemon modules own domain rules and do not import adapters, HTTP, bootstrap, or
   the control plane.
4. The control plane coordinates modules and injected adapters.
5. HTTP translates protocols but does not authorize domain behavior.
6. Sibling modules communicate through their `index.mjs` public surfaces; web
   features expose cross-feature UI through `index.ts`.
7. Feature presentation stays in its feature directory rather than shared themes.
8. Local and SSH runners implement one worker protocol and equivalent semantics.
9. Provider adapters speak provider protocols directly; they never embed Codex
   CLI, Pi, OpenCode, Claude Code, or another agent harness.

`npm run check:architecture` enforces the mechanical subset: forbidden dependency
directions, module/feature public imports, command type/validator parity, feature
CSS ownership, control-plane responsibility seams, cycles, legacy source roots,
and the presence of strategic README files.

The exact subscription/provider seam is documented in
[`provider-boundary.md`](provider-boundary.md).
The target multi-provider, organization, client-connection, credential, routing,
and remote-resource model is specified in
[`model-providers-organizations-and-client-access.md`](model-providers-organizations-and-client-access.md).
The model-facing execution and approval contract is documented in
[`tool-harness.md`](tool-harness.md).
The module command ownership seam is documented in
[`module-command-registry.md`](module-command-registry.md).
The extension contract is documented in [`extensions.md`](extensions.md).
Execution profiles, resolved grants, runner authority, and the static capacity-provider seam are
documented in [`execution-access.md`](execution-access.md).

## Ownership boundaries

Authoritative state has one owner. Work owns projects/tickets/boards; workflows
owns graph definitions and transitions; conversations owns durable dialogue and
steering; execution owns placement and runner eligibility; library owns capability
and instruction revisions. The control plane can transact across owners but should
not duplicate their rules.

## Safety invariants

The daemon revalidates tool visibility, approval identity, lease ownership, runner
assignment, and revisions at execution time. Worker or daemon loss marks unfinished
operations as lost/interrupted. Potential mutations require inspection and explicit
reconciliation before retry. These are architecture constraints, not UI features.

## Change guidance

Add a concept to the module that can hide its complexity behind the smallest
useful interface. Add an adapter when the difference is external technology, not
product policy. Add a package only when more than one application genuinely needs
the abstraction. Record consequential boundary changes as a focused document in
this directory.
