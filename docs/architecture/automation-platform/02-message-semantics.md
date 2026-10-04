# PR 2 — Explicit integration message semantics

## Dependencies

Independent; base is the plan commit.

## Implementation and acceptance

Replace core interpretation of authorRole strings user/customer with explicit normalized message
semantics from the adapter/configuration. Inspect all producers/consumers: source manifests,
custom HTTP and Linear adapters, Work thread baseline/fact generation, reply reconciliation,
workflow effect delivery confirmation, contracts and ticket UI. Introduce an explicit direction
or participant relationship (inbound/outbound/unknown is a candidate). Preserve original role
as display data. Provider-specific roles are mapped by adapters or source manifests, not core.
Unknown/absent mapping must not be guessed into inbound events or accepted delivery proof.

Define compatibility for old manifests and saved threads without silently changing source
history or fabricating inbound events. Provider-owned compatibility normalization is acceptable;
customer role strings may not become platform defaults. Mapping configuration must be validated
and surfaced for configuration, with source ownership and intent identity maintained. Reuse
canonical reply attempts and source thread commands, never a second messaging subsystem.

Acceptance: arbitrary procurement participant roles and internal publication participant roles
produce inbound facts and outbound confirmation from explicit mapping; unknown roles do not
start work or confirm delivery; first read remains baseline-only; duplicate messages are
idempotent; queued is not delivered; existing provider compatibility works; restart preserves
attempt identity. Tests cover customer-defined labels absent from platform code.

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
