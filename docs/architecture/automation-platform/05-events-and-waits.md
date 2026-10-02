# PR 5 — Registered events, schedules, and correlated waits

## Dependencies

Depends on PR 3 and PR 4.

## Implementation and acceptance

Introduce owner-registered event descriptors and a durable envelope with source+event identity,
schema revision, tenant/project scope, payload, correlation and causation. Route existing Work
facts through it. Add governed manual event submission and a schedule source (durable deadlines,
time zone/interval validation and explicit missed-fire policy). Provide a validated authenticated
webhook ingress through HTTP and an adapter translation seam; never trust caller-supplied tenant,
principal or correlation to widen visibility. Work remains owner of ticket source facts.

Automation When/If/Then subscribes to declared events and pins a workflow; retain one-action
workflow option instead of introducing a second action executor. Typed bounded predicates read
advertised event payload paths. Define concurrency explicitly: initial configurable reject/hold
and independent runs are sufficient; dedupe by event+rule revision; avoid universal one-ticket
lock. Preserve legacy rules and explicit retries for held/conflicting decisions. Bind the
subscription decision to its canonical run identity durably before executing its first activity.
Restart after run creation but before an acknowledgement/decision update must recover that same
run rather than allocate a second one. Test this gap with an applied effect and a lost save or
response; duplicate event delivery alone is insufficient proof.

Wait nodes bind explicit correlation plus event type/predicate or durable timer/deadline. Buffer
or index events so an event arriving just before wait registration is not lost, with bounded
retention/cursor policy. Decide whether wait consumption suppresses start subscriptions explicitly;
do not retain accidental global suppression. Handle duplicates, late events, restart and timeout
without accepting stale attempts. Unauthorized signaling fails closed.

Acceptance: scheduled no-agent inventory workflow, inbound external publication callback and
existing ticket event workflow use the same run engine; duplicate webhook starts once;
auth/tenant spoofing fails; early event wakes correct wait; unrelated correlation never wakes it;
timeout and schedule survive restart; missed-fire policy tested; cascades bounded by causation.

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
