# PR4 supplemental assignment: exact prepared activity approval

Owner: existing Luna high `pr6_human_evidence`, assisting PR4 owner after UI authoring completion.
Edit ONLY new `tests/acceptance/workflow-activity-approvals.test.mjs` in
`/tmp/convoy-automation-series/activities`. No product edits/commit. Read spec04/proposal04 and
nearest README/tests README. Enter through bootstrap/public runtime with disposable state.
Coordinate current command shape with PR4 owner: prepareWorkflowActivity accepts workflowRunId,
gateInstance,targetNodeId and returns id,digest,preview; decideWorkflowRun/approveGate accept
activityReservationId/activityReservationDigest. A label never grants authority.

Use two unrelated configured integration activities (procurement authorization and publication
release), each trusted injected metadata with required workflow-gate approval. Pure preparation
must make zero external calls. A human-only independent run must have zero sessions/provider/
runner calls. Current principal/project grant/control lease and exact active gate instance must
guard preparation and decision. Prove decision without preparation fails; missing/forged ID or
digest fails without advancing or invoking adapter; invalid/stale target/gate fails. Exact valid
prepared reservation pins successor attempt identity, validated input and intent/key; approval
and dispatch consume exactly that identity and call the adapter once. Later workflow publication
must not alter the active run's version/material. Restart must preserve reservation/attempt,
clear live lease, never replay effects, and require current valid authority after reacquisition.

Add cross-tenant preparation/decision denial via actual scoped principals where fixture setup
allows. Legacy gates without new required descriptor remain governed by their existing captured
approval path; do not alter existing test files. Bound all waits and cleanup on failure. Report
verified behavior and any blocked spec capability, with failures sent PR4 owner/root for fixes.

Parent review clarification: a prepared approval must expose the complete bounded
material and intended effect that its digest authorizes. A non-Work integration
must not show only an activity label. Generic presentation must not select fields
from Work command names or shapes as a universal heuristic. Never silently truncate
a reply or other effect payload; support compact disclosure of the full captured
material, or fail closed if it exceeds the declared bound. Prepared intents are
secret-free under the trusted implementation contract. Add a non-Work integration
preview assertion and a reply beyond 2,000 characters; the reviewed value must match
what dispatch receives. Keep normal states free of redundant explanatory alerts.
Session-backed preparation must await actual current session control authority and
reject unauthorized/stale callers before saving a reservation.
