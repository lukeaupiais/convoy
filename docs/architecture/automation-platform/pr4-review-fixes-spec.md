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
