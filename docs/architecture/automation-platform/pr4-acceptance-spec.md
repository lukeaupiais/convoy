# PR 4 acceptance coverage assignment

This supplements [04-activities-and-data.md](04-activities-and-data.md). The implementation
owner remains pr4_activities. The assigned helper owns only
`tests/acceptance/workflow-registered-activities.test.mjs` in the activities worktree.
Read tests/README.md and the production public runtime/registration interface. Do not edit
production code or another test file. Do not commit while the implementation owner is editing;
return the file and results for that owner to include in the frozen PR.

Use disposable persistence and production bootstrap/runtime command facades, with trusted
injected fake integration registrations. No private owner imports or production test hooks.
Use two unrelated configurations: procurement/vendor assessment and document processing, with
different project, workflow, activity and data vocabulary. An integration added through
registration executes without adding a core operation switch. Typed amount, boolean and list
outputs must bind into later registered inputs. If a workflow declares a result schema and
mapping, assert its persisted terminal result is validated and derived from declared sources.

Assert no sessions, provider invocations, runner assignment or workspace for no-resource
activities. In a mixed graph, an early internal/transform activity executes before a later
repository capability waits for resources, without acquiring those resources early. Do not
mock a completed production result to make this pass.

Cover incompatible bindings rejected before dispatch; missing pinned capability revision
visible/unavailable and fail closed; restart after an integration performs one external write
and loses acknowledgement leaves the same uncertain attempt/effect identity and no replay.
Explicit adapter reconciliation may provide matching evidence; caller-supplied output cannot
substitute for a receipt. Preserve existing canonical Work/reply regressions through the
existing affected groups rather than duplicating those entire tests.

The implementation is in progress. Failures caused by an unfinished seam are reported as such
with exact commands and assertions. They are not accepted as final proof. Keep fixture ports,
providers and effects bounded, register cleanup early, and never access live .convoy state.

## Owner attempt boundary assignment

A second helper owns only `tests/modules/workflow-activity-attempts.test.mjs` in the activities
worktree, using the Workflows public index and its public attempt methods. This helper does
not edit production code or other tests and does not commit. Test exact run/node/instance/ref
and immutable input/intent/idempotency keys, rejected mutation before state changes, completed
receipt duplicates and rejection of changed output/state, late callbacks after cancellation,
uncertain resolution only via authoritative adapter/owner reconciliation, and rejection of
not-applied resolution after a completed receipt. Cover bounded waiting confirmation updates
without widening the dispatch identity. Fixtures use declared bounded schemas and two unrelated
data shapes. The implementation owner includes accepted files in its final frozen commit.

## Active resource launch assignment

The owner-boundary helper may additionally own only
`tests/acceptance/workflow-active-resource-requirements.test.mjs`. Exercise the public runtime
with a provider-only current agent node and a later repository/check node. The configured
project has no runner placement and the active node declares no repository artifact/check or
runner tool need. The provider turn must begin without acquiring a runner/workspace; future
requirements cannot block it. Use bounded injected provider/runner fixture ports, assert no
runner dispatch and preserve cleanup. Report actual unresolved boundary conflicts to root;
do not bypass execution grants or edit product code to manufacture proof.
