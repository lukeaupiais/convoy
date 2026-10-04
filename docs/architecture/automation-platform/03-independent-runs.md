# PR 3 — Workflow-owned durable runs

## Dependencies

Independent foundation; base is the plan commit.

## Implementation and acceptance

Move authoritative WorkflowRun identity/state/history/lifecycle into the Workflows owner,
independent of a conversation or agent Session. Add run and activity-attempt contracts and a
small public Workflows interface for starting/reading/advancing runs. Coordinate governed
standalone start/cancel/continue/decision commands through the control plane with executable
validation, command authorization, tenant scoping and stale-run/attempt checks. Use explicit
project/organization/principal and exact published workflow revision. Optional links reference
tickets/conversations; they are not required for starting a no-agent run.

Existing session-based callers must route through the same owner and receive a compatibility
flow projection. Import persisted session.flow once with exact identities, history, review refs,
leases and pinned definitions preserved; no separately mutable duplicate. Create agent sessions
only when an agent activity actually activates; retain agent continue/new/reuse semantics.
No-agent workflows must not allocate a fake chat/session/model/provider/worktree. Existing
runner workflows and uncertain-restart handling remain valid. Independent run control needs a
governed run-specific control/lease equivalent; do not bypass existing session ownership.

Deliver a runnable standalone branch/Work-action/human workflow through the public runtime,
and a bounded run snapshot/query available to clients. Full generic activity catalog is PR 4;
new events are PR 5; arbitrary forms are PR 6; parallelism is PR 7. Scope this foundation to
existing node kinds with no session required for non-agent work. Add CONTEXT language only for
new real concepts; no mass rename.

Acceptance: no-agent procurement graph completes with no sessions/providers/repos/runners;
human-only publication run can be approved with exact material/attempt identity and actor;
a mixed run lazily creates one agent session; old active gate resumes unchanged after load;
unauthorized cross-tenant access and stale decisions fail; cancellation and uncertain recovery
work; session UI projection still shows truthful state. Exercise actual runtime acceptance.

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
