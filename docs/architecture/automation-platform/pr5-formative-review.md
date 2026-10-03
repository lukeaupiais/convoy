# PR5 formative Standards review

Reviewer: existing Luna high /root/pr4_activities. Read-only, no edits.
Implementation is still in progress in /tmp/convoy-automation-series/events.
Saved scope:05-events-and-waits.md and pr5-interface-design.md in this plan folder.
The working tree may change; this is early feedback, not immutable final acceptance.

Inspect ownership and generic seams: Workflow event journal/subscription decisions/
waits/schedules versus Work outbox facts; CP authentication/routing versus domain
matching; existing Identity service credentials and fixed webhook binding; HTTP only
transport; typed bounded predicates and tenant/resource/correlation enforcement;
source-event tuple identity, immutable scope, bounded journal/dedupe and cursor expiry;
canonical reserved run identity before effects; single serialized runtime tick and
same engine, no parallel executor. Preserve legacy configured event rules and current
principals/grants. Check against no-agent inventory and publication callbacks.

Report only confirmed boundary bugs or high-risk seams with files/lines and concrete
trigger/impact. Distinguish unfinished wiring from an actual wrong design. Coordinate
with root; do not ask the implementing owner to stop or alter their worktree.
Final Standards/Spec reviews occur against immutable base/head after freeze.
