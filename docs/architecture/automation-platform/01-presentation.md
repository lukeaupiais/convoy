# PR 1 — Configured workflow presentation

## Dependencies

Independent; base is the plan commit.

## Implementation and acceptance

Remove shared-renderer operation-specific decision labels and configurable-material assumptions.
The prior UI cleanup is part of this PR; import its exact tracked diff from the root checkout,
then replace the newly added send_external_reply label/tooltip heuristic with explicit pinned
human-node presentation metadata. Do not discard the existing reply-material integrity logic.

Add narrowly scoped optional decision presentation fields for existing approved and
changes_requested outcomes (e.g. outcome-to-label map); settle the exact shape in contracts,
normalizer, codec and editor together. Validate bounded plain text labels, supported outcomes,
and unknown keys. Default labels remain Approve / Request changes. Labels never grant authority
or choose transitions. Preserve metadata through draft/publish/reload and pin it in a run.
The generic interaction view consumes metadata and decisions, without inspecting a neighboring
operation to choose a label. Configured Approve & send works for any configured graph, and is
not automatically injected into existing published customer graphs. Destination identification
can remain in operation details; do not recreate explanatory paragraphs or hide authorization.
Update feature/domain docs and meaningful tests. Do not widen decision outcomes here.

Acceptance: two unrelated workflows render distinct configured labels despite arbitrary board,
workType and status names; defaults still work; invalid configuration is rejected; stale/missing
review material still disables decision; cleanup does not remove real errors, authority warnings,
or recovery requirements. No renderer infers the label from send_external_reply.

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
