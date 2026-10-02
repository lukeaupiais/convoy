# PR 4 — Registered activities, typed data, and effect attempts

## Dependencies

Depends on PR 3; integrate PR 2 for message activities.

## Implementation and acceptance

Replace the fixed workflow action cascade with a small registered, versioned activity interface.
Definitions advertise input/output JSON schemas, execution location/requirements, effect and
approval policy, cancellation/confirmation/reconciliation capabilities and minimal presentation.
Runtime implementations are injected/registered, never arbitrary manifest-loaded code. Register
existing Work actions through their owning canonical commands plus one unrelated deterministic
data-transform implementation and a fake integration adapter exercised in acceptance tests.
Reuse Library reviewed capability validation where relevant; do not invent duplicate grants.
Pin activity identity/revision and validate input/output at publication/dispatch/completion.
Expose registered descriptors in the authorized client read model and populate workflow action
selection/typed input authoring from them. A fresh generic action must not silently select
inspect_changes or describe itself as a board operation. Keep development/support templates
available as explicit selections; no customer or repository template is a universal default.
Unavailable registered revisions remain visible and fail closed rather than changing activity.

Give runs typed inputs and activity outputs, explicit immutable output references, and bounded
bindings to run input/prior activity output. No eval, secret material in snapshots, prototype
traversal or undeclared references. Initially support constants and safe paths, not a huge DSL.
Preserve existing submission fields/commands through compatibility translation.

Resolve resources per active activity: internal action/transform requires no runner/provider;
agent declares provider and optional tools/workspace; shell/check declares runner; repository
resources are acquired only if required. Do not collect every future graph node requirement at
launch. Keep exact execution grants and local/SSH parity.

Generalize the existing effect ledger into activity attempts with validated input identity,
intent persisted before dispatch, confirmed/waiting/failed/uncertain state distinctions and
adapter-owned reconciliation. No auto-retry uncertain effects. Confirmation failure is not
proof of effect failure. Preserve existing reply request keys and checks.

Acceptance: Work adapter and unrelated transform/integration adapter execute via one interface;
new registered activity needs no action-switch edits; typed amount/boolean/list outputs bind to
later inputs; invalid/missing output fails closed; revision unavailable blocks; no-runner
activity works in a mixed graph while future repository activity awaits resources; disconnect
and restart never duplicate a write; current reply and runner workflows regressions pass.

## Constraints shared by every PR

Read AGENTS.md (the user supplied root guidance applies in every checkout), CONTEXT.md,
the nearest README, and docs/architecture/README.md. Convoy is a general platform.
No board names, workType values, statuses, customer labels, role strings, or development/support
semantics may select generic behavior. Demonstrate each shared seam with at least two unrelated
configured examples. Workflows owns deterministic definitions/runs/transitions; Work owns
work items/boards; Execution owns resource policy; Library owns capabilities; Conversations
owns dialogue; the control plane coordinates them; adapters own protocols. Use public indexes.
Contracts contain shapes, not application logic. Keep feature presentation inside its feature.

Preserve canonical commands, authorization, tenant isolation, exact approval binding, leases,
immutable definition/capability revision pinning, local/SSH parity, bounded output, cancellation,
and fail-closed restart/disconnect semantics. Never silently replay a possibly applied mutation.
Do not edit live .convoy data or customer configuration. No dynamic unreviewed daemon plugins,
arbitrary eval, bypass credentials, or parallel replacement execution engine.
Published existing graphs and active run identities/material must remain valid. Compatibility
projections must be derived from one authoritative owner, never separately mutable copies.

Use focused module tests for rules and acceptance tests for cross-owner behavior. Read
 tests/README.md. Run npm run check:architecture, npm run build, and focused relevant groups.
Run the full suite after final integration; document baseline/environment failures. Do not
weaken checks. Do not add filler UI copy. Do not push, merge, deploy, or message external users;
root will review commits, publish draft PRs, and verify remote CI. Commit only scoped changes.
Each handoff identifies base/head commits, spec path, changed ownership, tests/results,
compatibility behavior, and known limitations. Ask root about genuine specification conflicts.
