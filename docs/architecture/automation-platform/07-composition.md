# PR 7 — Child runs, parallel joins, and bounded iteration

## Dependencies

Depends on PR 3–6; last in delivery order.

## Implementation and acceptance

Extend workflow composition through the same run/attempt owner. Add exact-version child workflow
calls with typed input/output mappings, explicit parent-child identity and governed scope. Add
parallel fork/join activities with all/first-success semantics specified, plus bounded collection
iteration (max items, concurrency and deadline). Track durable active attempts rather than one
scalar current node. Publish-time validate graph/data references and limits. Preserve legacy
single-node flow projections without falsely presenting parallel work as one completed session.

Define deterministic completion/failure/cancellation for child/fork/iteration; preserve all
attempt identities on restart. Retry only declared safe failures. Compensation consists of
explicit configured activities, never invented rollback. Unknown effects block dependent join
completion until reconciled. Reuse per-activity scheduling/authority; enforce organization and
run concurrency/budget limits, including uncertain attempts. Agent sessions must not be shared
concurrently unless existing lease semantics actually permit it; reject unsafe reuse.

Acceptance: procurement executes two no-agent assessments then joins; document-processing maps
bounded items with optional agents; parent-child pinned version unchanged after publication;
restart mid-parallel work does not duplicate completed writes; cancellation propagates;
partial failure and uncertainty produce correct joins; oversized map rejected; cross-tenant
child call and conflicting agent-session reuse rejected; legacy linear graphs remain valid.

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
