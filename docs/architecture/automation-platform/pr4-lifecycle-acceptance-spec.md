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
