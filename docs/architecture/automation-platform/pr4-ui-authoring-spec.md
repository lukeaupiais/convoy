# PR4 supplemental assignment: functional typed activity authoring

Owner: existing Luna high agent `pr6_human_evidence`, assisting PR4 owner. This is part of spec04,
not a new PR. Worktree `/tmp/convoy-automation-series/activities`; edit only
`apps/web/src/features/workflows/WorkflowEditor.tsx`, workflow-owned authoring helpers exported
through its public surface if needed, and narrowly relevant `tests/web/` coverage. Coordinate
with PR4 owner before editing. Read nearest README, user AGENTS, CONTEXT, architecture, tests README.

A generic action selects a registered exact activity revision and authors typed bindings.
Make the authoring controls functional during ordinary keyboard editing, using actual descriptor
schemas and explicit configuration only. Preserve legacy action UI and exact pinned published
nodes. Changing activity deliberately clears its prior descriptor digest for new publication;
editing an unchanged activity never silently clears its existing digest or changes revision.

Object/array JSON input must retain invalid intermediate local text while typing. Show concise
current validation errors and prevent save/publish/autosave from silently using an older valid
value while a displayed edit is invalid. Apply the same rule to run input schema text. Use the
existing draft/edit ownership; do not add a second definition owner or a large generic form engine.
Optional omitted bindings display Omit truthfully; null values can be authored as null. Switching
sources must preserve the selected binding's actual semantics and safe declared path. Unavailable
selected pins remain visibly selected with current unavailable state even when catalog projection
is truncated; do not choose a replacement. Do not derive controls from customer/board/status strings.

Remove the newly added selection-helper paragraph; use compact labels and current-state errors.
Only retain configured description content if useful to choosing the activity. Raw effect/location
metadata belongs in compact secondary details rather than instructional paragraphs.

Verify meaningful ordinary-edit behavior, invalid edit/save guards, optional omit, null, activity
switch digest handling and unavailable selection. Reuse frontend conventions; no tests that merely
mirror trivial expressions. Report exact changed files/results and known limitations; no commit,
push or product changes outside assigned UI. PR4 owner integrates the files in its scoped commit;
root performs independent review/build and browser verification.

## Additional delegated gate control scope

Owner4 is adding the governed `prepareWorkflowActivity` command with workflowRunId, exact active
gate instance and configured targetNodeId. Coordinate its final contract before wiring. Extend
only workflow-owned interaction actions/presentation and existing ticket/session binding adapters
as necessary: use declared required approval metadata and owner-projected reservation eligibility,
never inspect an operation code or board/customer string. Preparation returns bounded id/digest/
preview; require that exact reservation identity when approving a new required activity. Render a
compact prepare/review action and current prepared state. Keep legacy gates functional. Independent
run command use is verified in acceptance; full independent Runs/form surface is PR6, not this scope.
Read each feature's README and use its public index. Root must review every additional file and
ordinary gate behavior. Do not introduce instructional paragraphs or promise delivery at approval.

## Codec and empty draft clarification

Authoring ownership includes `workflow-codec.ts`: preserve runInputSchema, resultSchema and
resultBindings through fromWorkflow/toWorkflow/save/publish. A schema displayed in the editor
must reach publication unchanged rather than fall back to an empty contract. The unconfigured
blank template must have empty nodes/edges and no entry; adding a stage explicitly chooses its
kind through existing controls. Preserve explicit development templates and stored workflows.
An empty draft may be saved but cannot be published. Test round-trip data contract preservation
and empty draft behavior, and verify no agent is seeded by entering an unconfigured editor.
