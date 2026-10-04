# PR4 supplemental assignment: policy-driven cancellation and recovery

Owner: existing Luna high `pr3_runs`, assisting PR4 owner. Worktree
`/tmp/convoy-automation-series/activities`. Edit ONLY new
`tests/acceptance/workflow-activity-lifecycle.test.mjs`. No production changes or commits.
Read spec04/proposal04, user AGENTS, tests README and bootstrap README. Enter through the
production bootstrap/runtime public facade with disposable state and trusted injected activity
registrations. No customer/live state. Coordinate exact changed command shape with owner4.

Prove actual async lifecycle, using controlled barriers rather than private state mutation:
1. A deterministic pure activity paused in dispatch, then public cancelWorkflowRun under current
   exact actor/lease, observes aborted signal and stops. Run is truthfully cancelled, no externally
   applied uncertainty/effect requirement, no downstream dispatch, and no new session/runner.
2. Abrupt/crash-style persisted running pure attempt recovers safely on restart and may recompute
   pinned deterministic output without operator effect reconciliation. Preserve run/attempt identity
   and never recompute/duplicate a completed receipt. Use real persistence fixture recovery with a
   fault/barrier, not manufacturing a private terminal status in state.
3. An injected durable-effect adapter applies then loses acknowledgement. Cancellation/restart
   retains uncertainty and exact intent/key; automatic retries never dispatch again. Only a matching
   canonical adapter receipt can settle it. A late completion after cancel records proven outcome
   without advancing downstream. Test real in-flight public cancellation if feasible.
4. Cancellation before dispatch prevents an external call and does not manufacture unknown effect.
   Assert actual dispatch count and owner state. Keep tests bounded and cleanup on all failure paths.

Use two unrelated activity schemas/configurations. Assert current permission/lease guards where
relevant; preserve existing exact attempt APIs. Do not weaken failed assertions to accept broad
statuses. Report actual runtime evidence vs blocked capability, send findings owner4/root, and run
file after owner fixes. Do not change tests owned by another agent.

Supplemental Spec-review crash gaps, assigned to the same Luna high helper:
- An approved required-gate durable activity loses acknowledgement after applying.
  Reconciliation must use its exact persisted consumed reservation and current
  authority; it may not lose approval proof or dispatch the effect again.
- A process dies after its validated completed receipt is durably saved but before
  its graph transition is saved. Restart must finish the same run/attempt using
  that immutable receipt without redispatch. Exercise the actual checkpoint with
  a child process and bounded fault barrier rather than editing status strings.

Required-approval continuation proof, assigned to the same lifecycle helper:
- A required-gate integration returns waiting after dispatch, then confirmation on
  authorized Continue completes the same reserved attempt without dispatch replay.
- A first dispatch loses acknowledgement before actual application. It stays unknown
  until the adapter canonically establishes not-applied. Authorized Continue retries
  the exact same instance/key/reservation; two dispatch calls apply the effect once.
Consumed reservation identity remains usable proof for these continuations and
reconciliation. A label or an unrelated earlier approval is insufficient.

Cancellation remains a run lifecycle decision while effect confirmation progresses.
A cancelled durable activity may later receive canonical applied-but-still-waiting
evidence, then a complete receipt; neither reconciliation may reactivate its run
or start downstream work. Record truthful attempt evidence, preserve cancellation,
and never replay the original effect. Add the public command acceptance case.
