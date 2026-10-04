# PR7 functional workflow UI subphase

Owner: Luna high /root/pr6_human_evidence, after freezing final PR6 draft-retention correction. Shared implementation checkout: /tmp/convoy-automation-series/composition. Main PR7 owner4 retains daemon, contracts, policy, examples, architecture docs and backend acceptance. Coordinate exact public interfaces first; root reviews authored UI separately and owner6's final Spec review excludes its own UI.

Read nearest README, CONTEXT and architecture ownership guidance. This supplements 07-composition.md and pr7-implementation-seams-spec.md. It is an implementation phase of PR7, not another PR.

## Exclusive files

Own apps/web/src/features/workflows/WorkflowEditor.tsx, workflow-codec.ts, any owning-feature authoring helper/styles required, WorkflowRuns.tsx and WorkflowRunInteraction.tsx for generic presentation only, plus narrow relevant tests/web paths agreed with owner4. No daemon/contracts/test-helper edits. Root supplies final reviewed PR6 web delta; integrate it before editing overlapping interaction/runs files. Owner4 has not modified web files.

## Registered waits

Replace fresh ticket-event/active_ticket defaults and three fixed generic choices with explicit registered descriptor selection. Preserve historical configured waits and all exact fields on unrelated edits. Use descriptor revision, scope, declared resource identity and correlationPaths metadata; do not infer owner/name/workType/status/customer behavior. Provide compact usable resource, correlation binding, typed predicate and timeout authoring for registered inventory and publication events. Only display legacy ticket constraints when present as actual saved configuration or explicit Work capability. Preserve absent versus explicit values and pinned revisions. Invalid JSON/paths/types block save with actionable errors, no explanatory paragraphs. Browser author/publish, exact readback, reopen/edit and mobile proof on two unrelated events.

## Composition graph and run presentation

Preserve and render child, parallel and map kinds through codec roundtrip and unrelated edits; never default them to agent. Provide practical compact creation/inspection controls for exact child workflow/version, typed inputs/results, declared join, map item/index fields, bounds, deadline and explicit compensation where published contract supports it. Use existing schema/binding controls or bounded advanced JSON where appropriate, with validation and retained unsaved values. No hardcoded business schemas or template defaults. Preserve workflow run input/result schemas and terminal mappings through editing.

Present actual canonical compositions and slots from WorkflowRun DTO. Show child identity/status, waiting/uncertain/failed state and navigation to child run; controls use existing actor-bound canonical run commands/leases. Do not pretend a parallel graph is one completed agent session. Required unknown reconciliation stays visible and cannot silently replay writes. No duplicate mutable status ledger in UI.

## Presentation compatibility

Remove reply action selection from next-node operation == send_external_reply heuristics in generic interaction UI. Use actual persisted review material and explicit configured/compatibility presentation. Existing exact agent reply approval remains functional; labels come from configuration/declared capability. No new filler or unsupported approval bypass. Fresh graphs remain empty/configured and agent-free unless operator chooses an agent.

## Proof and handoff

Use narrow meaningful codec/web tests for new node and wait fields, plus real browser authoring and mobile run presentation. Credential-free disposable fixture authorizes local workflow publication/editing and human-only response Save/Review; it forbids external effects or customer state. Do not retry the prior observation-only mixed-session Save rejected by automatic review. Preserve shared PR6 edit/lease/private-material guards. Run architecture/build and relevant web groups on exact frozen head; root full suite after integration. Commit only owned files and report immutable base/head and artifacts; no push/merge/deploy. Root reviews UI independently, Standards3 reviews full product excluding own helper, Spec6 reviews backend excluding own UI with root closing UI Spec.

Root mobile acceptance also found the active-context popover's static paragraph explaining that the deployment controls authority and changing selection resolves fresh context. The original user authorized removing this type of UI filler. A narrow additional owned edit to apps/web/src/features/access/ActiveContext.tsx may remove that paragraph while preserving the actual signed-in user, selected context, current authority labels and error/action controls. Read the nearest owning README first. No permission or behavior change, no new test that merely mirrors removal, and no other access-feature scope. Root reviews the actual diff.

The session-backed composition surface must also navigate created canonical child runs. A status-only shared panel without Open run does not close this requirement. Owner6 may add the smallest existing app navigation callback and selection wiring in apps/web/src/app/main.tsx, session/ticket presentation call sites and the owning WorkflowWorkspace/WorkflowRuns components after reading their nearest README. Use public feature surfaces and the existing canonical run controls; preserve parent/session leases, actual child scope and late/context guards. Do not invent an unsupported hash route, dispatch a custom browser event as a hidden routing protocol, or duplicate the HumanTaskPanel/lease state machine. Root independently reviews these extra paths; original workspace dirty files remain untouched.
