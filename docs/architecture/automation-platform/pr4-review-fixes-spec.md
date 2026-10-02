# PR4 immutable review fixes

Review base: ebca318c8f330176fa21d1780a06960e3aec9986.
Reviewed head: bdaf31d9c194f164aaf2e1a7bb4341d1a9e0bdd5.
Owner: Luna high pr4_activities; root independently verifies and two-axis reviewers re-review
an immutable corrective delta before publication. No push/merge/deploy by the implementer.

## Spec blocker: declared active agent resources

Registered actions with an agent descriptor must lazily acquire/attach a real authorized
provider Session at their active node through the existing canonical acquisition seam.
Stored run principal, current model/provider authority and declared tools/workspace must be
checked before adapter dispatch. Do not create sessions for daemon/integration/runner nodes
or inspect future graph nodes to choose resources. A provider-only registered action must not
acquire a runner simply because its project has a runner placement configured. Preserve exact
workflow/descriptor pins and all lease/approval/restart/cancellation behavior.

Public runtime acceptance must prove a standalone permitted agent-resource activity dispatches,
provider/model grant revocation or unavailable authority fails closed before adapter dispatch,
and resource acquisition occurs only at that active node. Existing runner-only and no-agent
examples continue creating zero provider sessions. The parent's untracked agent-resource test
currently asserts the unsupported permanent wait and must be rewritten to these functional
positive/negative requirements rather than committed as acceptance of that limitation.

## Standards blocker: Work effect ownership

The control-plane activity adapter must not classify Work-owned effects by directly reading
state.ticketStatusChanges, ticketReplies, ticketRequests or ticketRelations. Extend narrow
Work public receipt/confirmation queries to return canonical proof for the exact prepared
command/request/run/instance/body/connection/remote target identity. Preserve immutable original
mutation results and existing Work idempotency and authorization. Work owns reply delivery,
status/create/relation outcomes and exact canonical evidence; the activity adapter maps the
owner result into generic activity outcomes. Move latest-delivered candidate selection into a
Work-owned query as well. No duplicate effect executor, Work state store or provider protocol.
Run existing uncertain/spoofed/queued reply, status, creation/relation and recovery regressions;
prove the public owner queries reject mismatched identities and retain immutable result output.

## Parent UI finding: control loss and first preparation

Gate all active prepared material by current control eligibility, including component-local
cached reservations. Clear/invalidate stale async responses on gate/control loss. Ticket UI
must retain a functional explicit claim-and-fresh-prepare path; gaining control during that
first preparation must not erase a valid response. Compact functional controls only; add no
helper paragraphs. Verify lease loss, first claim, stale response and gate changes through the
actual interaction surface or narrow browser-facing state logic plus a disposable browser case.

## Handoff

Commit only the scoped corrective delta and tests. Run check:architecture, build and focused
owner/activity/resource/UI/legacy acceptance groups; report logs and exact SHA. Root will re-run
required checks on the frozen corrected head and publish the reviewed draft only after both
review axes clear.

## Provider model authoring compatibility

Preserve an explicitly configured node.model through the generic editor codec for a registered
activity; the new active agent-resource path uses that exact model and must not silently fall
back after an unrelated edit. Render a compact model selector only when the selected descriptor
actually declares agent resources. Other action activities receive no agent instructions or
session-mode scaffolding. Verify the codec roundtrip and explicit unavailable model preservation.

## Second frozen review findings at be008d3

Registered agent-action tools need an explicit pinned Library-governed permission policy in
the action definition and editor codec. A descriptor declares required resources; it grants no
authority. Normalize/validate the canonical permission enum with a conservative default, expose
a compact selector only for agent resources that need tools/workspace, and recheck current
provider and execution grants at the active node. Add public-runtime nonempty-tool permitted
and denied acceptance, including actual workspace acquisition only when declared.

Work's latest-delivered evidence query must select the newest exact canonically delivered
reply for the run/project/connection. A newer queued/pending reply must not displace an older
confirmed delivery. A stale reply.deliveryStatus flag must not hide a matching exact outbound
thread message that already proves delivery. Keep selection/refresh inside Work; the status
command still refreshes and validates the chosen exact identity before mutation. Cover both
orderings and missing/spoofed/cross-project evidence. No raw Work arrays in control-plane policy.

Owner4 handles backend and Work tests; helper3 owns the provider-resource acceptance file;
helper6 owns the UI permission codec/editor correction. Root independently reviews helper
changes and both reviewers inspect the immutable backend corrective delta before publication.

## Approval preparation and active resource acquisition

An exact intent reservation at a prior human gate must not allocate the target activity's
provider session, runner or workspace. Preparation is a pure bounded calculation from its
validated input and identity; resource-dependent adapter preparation fails the explicit
command immediately. Keep current principal/project/provider authorization checks using
canonical project APIs without a fake Session. After approval advances to the action, acquire
its declared resources and recheck full current provider, Library and Execution authority
before dispatch. A prepared preview never grants tools or execution permission.

Public-runtime proof covers a human gate followed by an approved registered agent action
with declared workspace/read tools: preview has zero sessions/runner acquisition, approval
activates normal resources and consumes the exact reserved intent once. Revoking current
authority after preview prevents dispatch. Previously acquired resources may not substitute
for the target's current policy. Helper3 owns these acceptance cases; owner4 owns the phase
boundary and documentation; root reviews helper tests independently.

## Final material/context corrections

The exact selected provider model must appear in the shared private preview shape and the
rendered approval material, with a compact state line and the prepared values. No additional
helper explanation is needed. The preparation callback receives a resource-free projection,
including for an already-linked session: session:null, no owner API, no live Session ID,
workspace, runner, assignment or execution-grant data. Its bounded run facts include canonical
identity/scope and only the exact captured decision submission needed by Work compatibility.
Current authorization checks still run on the real owner run before invoking the callback.
Prove this boundary with an existing-resource fixture and public session-backed preparation.

## Canonical adapter model selection

Registered callbacks receive the exact currently authorized model as context.model on
preparation, dispatch, confirmation and reconciliation. Compute that choice once through the
canonical authorization seam, including the reservation's pinned provider choice; adapters
must not each reproduce a node/flow/session fallback. An already-linked session may retain
its dialogue default model and lease identity, but that metadata does not select the current
activity's provider. Do not create a fake Session or silently switch the session default.
Public-runtime acceptance uses two different permitted models in consecutive activities with
one linked session and asserts both adapters receive their own exact authorized selection.
