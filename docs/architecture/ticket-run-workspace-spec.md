# Ticket and run workspace — implementation specification

Status: implemented locally, with live ticket host integration verified on
2026-10-01. This document authorizes
no deployment or live workflow changes. The audit table below records the starting
gaps and intended changes, rather than an inventory of remaining defects.
The general [workflow interaction specification](workflow-interaction-spec.md)
remains authoritative for engine capabilities and submission identity. This
specification defines the next presentation increment and its necessary gaps.

The implemented [ticket workspace cleanup](ticket-workspace-cleanup-spec.md)
supersedes the presentation placement described here for diagnostics, run
management and agent chat. The lifecycle
and identity requirements in this document remain authoritative.

## Objective and constraints

Make the initial ticket view sufficient to inspect current work, inspect captured
files, make supported decisions, and read or reply to a linked external thread.
Use the same workflow-owned activity surface in standalone session/run views.
Opening a ticket always starts in this consolidated view, including a ticket
awaiting review. Execution diagnostics are an explicit navigation choice.

Convoy is multipurpose. The examples are test fixtures, not workflow categories.
Never select layout, renderer, buttons, or lifecycle from a node name, board name,
work type, customer, customer-defined ticket status, filename, or detail key.
Business semantics must not be inferred from content. Slot availability may follow
actual data and declared capabilities; authoritative runtime state selects supported
controls, not a business-specific layout.
An activity is an existing workflow node, not a new domain object.

Keep the established layout and palette. Use square edges, restrained bevels,
inset fields, and compact desktop controls. Retain readable spacing, visible
focus, contrast, and responsive stacking; no global reskin or decorative chrome.

## One structural contract

```text
Context: ticket/run title, description, available properties
Current activity: configured node name and authoritative run state
  Output: summary and configured detail fields, if present
  Materials: captured artifacts/references, if present
  Interaction: supported decision, answer, or tool permission, if present
Communication: available connected threads, if present
Activity details: history, diagnostics and mutable workspace changes, disclosed
```

Optional slots disappear when their data or capability is absent. They retain
order and styling when present. No empty review, agent, or communication section
is required. A run without a ticket retains its run context and history; ticket
properties and external-ticket communication are not fabricated.

Ticket status, board placement, workflow state, tool permission, and reply delivery
are independent observations. Updating one must not implicitly rewrite another.
Multiple pending interactions, when legitimately present, retain their distinct
identities; do not choose one by guessing a priority from content.

## What supplies each element

| Element | Authoritative source | Rendering rule |
| --- | --- | --- |
| Activity name | `WorkflowStep.name` in the pinned definition, selected by `flow.nodeId` | Literal text; never a layout selector. |
| Run state | `session.flow.status` plus current pending question/tool records | Compact familiar label; unknown states remain observable without invented controls. |
| Summary/details | Captured `WorkflowSubmission`, resolved by source node, instance and revision | Reuse `workflowRunOutput`; preserve exact content. |
| Prominent output | Source node's validated `presentationBindings` | Only summary, declared detail field, or artifact; optional label and one primary selection. |
| Artifact preview | Captured artifact identity and MIME | Markdown, plain text, JSON; metadata/download fallback otherwise. |
| Decisions | Current gate, exact supported edges, existing callbacks and daemon validation | Approve/revision only where supported; missing required material blocks approval. |
| Question | `session.pendingQuestion` and question ID | Answer through the existing command. |
| Tool permission | `session.pending`, approval ID, args and optional rule | Allow once/deny; persistent allowance only when an actual scoped rule permits it. |
| Thread | Ticket link and matching connection/thread records | Label from available source metadata; isolate by connection. |
| Delivery | Canonical `TicketReply` and matching remote message | Time and status are separate; queued is not delivered. |
| Agent dialogue | Existing conversation/session IDs and Chat feature | Open the real linked session; no fabricated embedded transcript or new session lifecycle. |

Presentation bindings cannot add content, grant authority, choose transitions,
or define custom components. Do not add `quote`, `supportReply`, `codeReview`,
`useCase`, or a per-workflow template registry. Detail fields are strings, not
HTML instructions or implicit JSON-based business layouts.

Show primary content once. Show other bound fields without exposing internal keys;
retain unbound details and optional investigation/verification behind disclosure.
Do not duplicate a proposed message as both a bound field and a special reply card.
For a supported approved-reply effect, the operation-selected exact sending field
must remain readily inspectable at its gate even without presentation bindings or
when another field is primary. Surface it once through the ordinary detail renderer
with the real supported destination/consequence; do not require live workflow edits.

## Current implementation audit and required changes

| Area | Existing implementation | Gap and minimum change | Owner |
| --- | --- | --- | --- |
| Initial ticket view | `TicketDetails` shows a gate-only preview using `lastSubmission`, then `onRun` navigates to execution. | Replace the preview with the public workflow activity component for all supported run states. Reuse existing command callbacks; avoid two copies of the interaction and run controls. | Tickets host, Workflows presentation |
| Shared activity surface | `WorkflowRunInteraction` is already used in ticket execution and sessions. | Give it one compact hierarchy across states; keep operational management/diagnostics in disclosure. Ticket and session hosts supply context, not business renderers. | Workflows, Sessions |
| Output identity | `workflowRunOutput` resolves pinned gate output and paused approved output; other states use `lastSubmission`. | Preserve the actual reviewed material after approval and while its effect is pending. Resolve from retained history/reference when a gate-completion summary would otherwise replace it. Avoid stale material after a genuinely new activity produces output. Test lifecycle explicitly. | Workflows presentation; Workflows domain only if required identity is missing |
| Message presentation | Renderer discovers `send_external_reply` on the approved edge and uses a hard-coded separate exact-reply section. | Use its configured source field through the ordinary detail renderer. Retain the operation's exact capture/approval safety. Display its real sending consequence once. Do not create generic effect semantics for unsupported operations. | Workflows; control plane if destination context is unavailable |
| Decision data | Gates, questions, tool requests and callbacks already exist. | Extract bounded presentation selectors from existing records. UI availability is convenience, not authority; daemon checks remain mandatory. Do not add an engine-wide action registry. | Workflows web feature and existing owners |
| Material inspection | Artifact viewer fetches captured content and renders supported MIME types inline. | Reuse this content selection/fetch logic in one accessible inspector with file switching, details and download. Bind it to the reviewed source instance/revision, not a mutable path or current worktree. | Workflows |
| Thread selection | Work stores threads by connection and ticket; UI selects the first thread by ticket and chooses read/reply connections independently. | Select one explicit connection and its link; filter thread, replies, uncertainty and reconciliation candidates by that same identity. Never mix one source's messages with another source's composer. | Tickets web feature |
| Reply time/author | Remote messages provide role/time/status; `TicketReply` lacks typed `createdAt`, although Work already persists it. Author display names/recipient names are not in the current thread contract. | Add optional `createdAt` to the shared reply shape, with safe missing-value fallback. Do not invent names or use status as time. Source name and linked remote ID are sufficient initially; richer adapter metadata is optional future work. | Contracts, Work/adapter if adding metadata |
| Reply lifecycle | Work provides posting, syncing and explicit reconciliation; workflow effects wait for confirmed delivery. | Keep canonical records in the selected thread; deduplicate remote IDs within that connection. Expose pending/unknown outcomes and source-match reconciliation without generic delivery assertions. | Tickets, existing Work operations |
| Duplicate-send guard | Work rejects reuse of an unresolved request ID; current UI checks uncertainty across the whole ticket. A new request ID is not itself blocked by Work when another unresolved reply exists. | Scope the UI guard to the selected connection. Add an owning Work-domain guard against a new unresolved send in that ticket/connection scope, including concurrent requests. Inspect canonical reply status, preserve idempotent replays, and avoid blocking unrelated connections. | Work, control plane verification |
| Restart/continue | Existing runtime commands revalidate instance, lease and uncertain effects; renderer offers commands by state/callback. | Retain those checks and exact command semantics. Do not implement mockup `Restart` by changing ticket status or resetting local UI state. Show unresolved mutation context rather than promising a safe retry. | Existing runtime/Workflows owners |
| Styling | Feature CSS and shared theme exist; mockup embeds their styles plus overrides. | Implement local feature styles and reuse existing theme tokens/controls. Do not ship the embedded stylesheet, dummy content, mockup scripts or scenario selector. | Tickets/Workflows owning styles |

Audited source entry points:

- `apps/web/src/features/tickets/TicketDetails.tsx`
- `apps/web/src/features/tickets/TicketExecution.tsx`
- `apps/web/src/features/sessions/RuntimeViews.tsx`
- `apps/web/src/features/workflows/WorkflowRunInteraction.tsx`
- `apps/web/src/features/workflows/workflow-interaction.ts`
- `packages/contracts/src/model/workflows.ts`, `session.ts`, `work.ts`
- `apps/daemon/src/modules/work/catalog.mjs`
- `apps/daemon/src/modules/workflows/workflows.mjs`
- `apps/daemon/src/control-plane/workflow-effects.mjs`

## Communication and effects

Operator output is visible in Convoy. A configured draft is not yet an external
message. Approval authorizes only the exact supported configured effect; it is
not delivery and is not permission to merge/apply/publish arbitrary resources.

For `send_external_reply`, retain the declared connection, source node and field,
immutable captured text, canonical request/effect identity, and confirmed-delivery
barrier. Destination labels must come from available linked-source metadata.
If information needed to name the exact destination is not available, show the
connection and linked remote identity; do not invent a person's name.

No new general consequence field is required for the first increment. Ordinary
gates remain Approve/Request changes with no invented downstream promise. The
existing supported reply operation may expose its actual consequence. If resolving
that context requires a contract addition, add only data to the existing workflow
read model, resolved by the owning domain/control plane and respecting access.
Never infer an effect from a detail field name or an arbitrary downstream graph.

Manual reply is a separate operator command, available only with the connection's
reply capability and existing authority. It does not consume or alter approval
of an agent draft. Unknown outcomes block duplicate sends in their exact scope.
A reply may appear as pending/sending before delivery; these are observed states,
not claimed receipt. Reconciliation either matches an actual remote ID and exact
body through Work or explicitly confirms not posted, using the existing command.
Manual submission retries preserve their request ID and exact submitted body
until acceptance or canonical reconciliation resolves the attempt. A lost HTTP
acknowledgement must not generate a fresh request ID for the same submitted draft
and post a duplicate accepted message. This is in-memory request correlation, not
a new persistence subsystem.
The UI never marks a send delivered by clicking a simulated status button.

A Work rejection before dispatch is definitely unposted, not an uncertain send.
The new unresolved-send guard must communicate that bounded fact through the
existing Work/control-plane seam. The coordinator must not leave an uncertain
effect without a canonical reply to reconcile. Preserve the approval and exact
request identity, show the blocking existing reply, and allow explicit continuation
after that reply is reconciled. Do not retry automatically or create a universal
error/effect registry. Errors after an actual dispatch remain fail-closed uncertain.
Test a manual pending/unknown reply blocking an approved workflow effect, then
reconciliation of the existing reply, explicit recovery, and exactly one workflow send.

A single linked thread needs no decorative audience tab. Multiple eligible
connections can use an explicit selector. Drafts and selected destinations are
scoped by ticket identity and connection identity, plus deployment/active context
when the owning shell can reuse the feature across them. Drafts survive selection
changes and snapshot updates; switching tickets never transfers draft content.
Capture the originating scope and draft version when submitting. Clear only that
accepted submitted draft; a late acknowledgement must not clear newly typed text
or another scope's draft. Preserve input on rejection. In-memory draft state is
sufficient; no durable draft domain or storage is introduced. On reconnect, refresh authoritative state before enabling sends.
Do not silently switch the destination after capability/link removal; retain the
draft with a disabled unavailable destination until the operator chooses another.

Internal ticket comments are not implemented and are outside this increment.
Do not show an Internal composer or claim team visibility. Human-agent Conversation
remains the Chat-owned feature with its own access and control lifecycle.

## Inspector and lifecycle details

Keep a selected captured artifact open when snapshots update unrelated state.
If its submission is superseded, retain the inspected revision with a clear stale
notice and access to the current material; an old inspector must not authorize a
new gate. A missing exact source or required artifact blocks the affected decision.
A failed optional supporting preview does not automatically block an unrelated gate.

Reuse authorized captured-content access. Handle loading, not found, forbidden,
unsupported MIME, malformed JSON and download failures. Plain text stays escaped;
Markdown follows the existing safe renderer. Do not preview executable HTML/SVG.
No PDF/image/media, CSV table, syntax-aware diff or custom JSON business viewer is
promised. A captured patch is text; a live workspace diff is diagnostic context.

Inspector opens without losing ticket scroll, traps focus, closes with Escape,
returns focus to its opener, and switches files by keyboard. On narrow screens it
uses a full-width overlay without horizontal document overflow. Restore neither
an obsolete approval nor stale fetched content after session/source changes.
The enclosing ticket dialog must yield its Escape and Tab handlers to the open
native inspector: closing the inspector must not close the ticket underneath.
Long summaries use generic expansion controls while retaining the complete
captured text. Exact operation-selected sending fields remain readily visible.

History is independent of communication: it remains accessible when no external
thread or ticket exists. Agent-session access opens the existing conversation;
activity detail must not simulate new writable dialogue from summaries.

## Ownership and implementation sequence

1. **Resolve data and preserve identity.** Extend workflow web selectors at their
   existing seam; specify post-approval selection and explicit supported command
   state. Fix scoped thread selection and necessary optional timestamp typing.
   Add the narrow Work guard for unresolved sends, with focused tests.
2. **Consolidate hosts.** Extract/reuse the actual command wiring from ticket
   execution so ticket details can mount the public workflow surface. Keep full
   execution diagnostics accessible, but remove the duplicate review destination.
   Standalone sessions use the same activity component.
3. **Build the inspector and communication surface.** Keep both in their owning
   features. Integrate selected-source thread, reply, reconciliation and draft
   state; retain the existing guarded workflow-effect delivery behavior.
4. **Apply the visual treatment.** Feature-local classic control styling with
   existing palette, accessible focus/contrast and responsive layout.
5. **Validate actual fixtures and delivery.** Use published/pinned unrelated
   configurations through canonical seams. No automatic edits to live definitions,
   no production/customer messages, no release as part of UI implementation.

Web features cross public `index.ts` boundaries. Daemon domains cross public
`index.mjs` boundaries. HTTP translates commands; it does not decide policy.
Contracts contain data only. Do not duplicate source capture, approval identity,
reply idempotency or reconciliation inside a new UI/presentation service.

## Acceptance and regression criteria

- At least two unrelated configurations with different node names, detail field
  names, boards/work types/statuses produce the same surface structure. No business
  string controls visibility, renderer or command selection.
- Running, waiting, review, question, tool permission, incomplete output, paused,
  failed/interrupted and terminal runs show real state and supported commands.
  Include no-ticket, no-agent, no-artifact and no-human-step fixtures.
- Attachments do not change the action set. Primary binding is respected; summary,
  configured details, references and optional assessments stay inspectable.
- A supported sending field is shown exactly once without bindings and with an
  unrelated primary binding. Destination/consequence come from the actual operation.
- A new revision requires a new decision; stale/missing captured sources cannot
  reuse approval. The approved output remains readable through delayed effects.
- Markdown/text/JSON and fallback downloads are exercised against the real endpoint,
  including forbidden/missing content and stale fetch cancellation.
- Two connections with overlapping remote message IDs remain isolated. Read-only
  threads have no send control. Connection and ticket changes preserve correctly
  scoped drafts without cross-ticket/context leakage. Late acceptance clears only
  the originating submitted draft version. Lost HTTP acknowledgement retries reuse
  the same canonical request ID and body.
- Approval sends nothing until the configured effect executes. Confirm delayed
  delivery, dropped connection after posting, source-match reconciliation and no
  duplicate sending across retries, new IDs or concurrent commands. A blocked
  pre-dispatch workflow send recovers explicitly after the existing manual reply
  is reconciled, without inventing a remote reply or marking an unposted effect uncertain.
- Ticket and board state change only through existing source-owned commands; no
  client-side workflow completion/reset changes them implicitly.
- Keyboard-only inspection and audience selection, readable focus, narrow viewport
  and dark/light behavior where supported are checked with the actual app.

Use existing focused web tests for selectors, Work/Workflow module tests for policy,
and acceptance tests for crossed ownership/lifecycle behavior. Keep existing exact
reply acceptance coverage. Before handoff run `npm run check:architecture`,
`npm run build`, and the smallest relevant test groups; report baseline failures.

## Mockup fidelity limits and deferred work

`output/mockups/ticket-review-mockup.html` is an ignored local visual reference,
not a production dependency or normative data contract. Its scenarios approximate
runtime state; its local approval/restart/reconciliation handlers are not engine
implementations. Names, people, timestamps, source matches and content are fixtures.
Its read-only agent transcript disclosure is not the production Chat integration.
Do not copy those handlers, fixture adapters, output arrays or mutable status flags.

Deferred: internal ticket comments; arbitrary human forms/choices/signatures;
new event adapters; automatic PR/file mutation approvals; richer media renderers;
universal effect/resource registries; custom per-workflow presentation templates.
The next implementation does not need these to satisfy the workspace design.

The local `CONTEXT.md` Artifact/Submission vocabulary has been aligned with the
general interaction specification without renaming stored entities. Because that
file is ignored, this tracked specification remains the implementation scope
reference.
