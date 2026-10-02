# PR 6 — Configured human tasks and generic evidence

## Dependencies

Depends on PR 1, PR 3 and PR 4.

## Implementation and acceptance

Extend human activities beyond hardcoded approved/changes_requested: pinned configured outcome
IDs/labels, optional typed form schema, explicit reviewer assignment/eligibility, deadlines and
exact reviewed input/output/effect refs. Add governed respond-to-human-task interface; maintain
legacy approveGate/requestChanges via the same owner. UI renders compact configured controls and
bounded form widgets from shapes, never customer types or next-operation inspection. Human-task UI must operate independent runs without requiring a Session.flow or ticket:
use run read/control commands and a minimal workflow-owned run/task selection surface. Keep form
submission separate from authority; labels never imply permission. Preserve revision loops.

Generalize captured evidence refs to content-addressed documents, validated adapter response
snapshots and immutable activity receipts. Keep file/line and sealed runner verification as
specific evidence producers. Evidence captures from non-agent activities may be reviewed by a
human. Bind an approval to exact captured material and intended effect input identity. Changes
invalidate approval; metadata editing or activity retries cannot widen it. Preserve existing
submission shapes and old captured artifact access without forcing repository resources.
Domain-specific investigation/check policies stay explicitly selected policy, not universal
human-task requirements. No arbitrary HTML/UI definitions in manifests.

Acceptance: a procurement form and publication choice with different outcomes and reviewer roles
work; no-agent API output is reviewable; actor eligibility/cross-tenant/stale attempt fail;
changed material/effect requires fresh approval; immutable old output remains visible; existing
agent plan and reply approval regressions pass; no new explanatory UI paragraphs.

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
