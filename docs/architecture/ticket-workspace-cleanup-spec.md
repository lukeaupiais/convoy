# Ticket workspace cleanup

Status: implemented locally, 2026-10-01. The user separately authorized this
implementation. No release or live workflow changes are authorized by this document.

This is the next presentation increment after the
[ticket and run workspace specification](ticket-run-workspace-spec.md). It
supersedes that document's placement of diagnostics, run management, and agent
chat in the initial ticket view. Existing engine, capture, approval, delivery,
draft, and access requirements remain authoritative.

## Problem and outcome

The live ticket view still looks like a stack of controls. Output, file access,
Activity details, decisions, Run management, and History and diagnostics occupy
separate blocks. Approve and Request changes stretch across the available width
on separate rows. Secondary operations compete with the current work and linked
communication. Short synthetic examples concealed the density of real content.

The initial view should answer: what is this ticket, what is happening, what must
I inspect or decide, and what has been communicated? It should not double as an
execution console. Match the mockup's hierarchy and grouping, using real data.
Keep the existing palette and restrained classic controls. No theme redesign.

## Stable layout

```text
Ticket ID                                                   Options
Ticket title                                                Status
Description                               Properties

Current activity                            Runtime status
Configured activity name

Primary content
Supporting output, disclosed when lengthy
Files

Consequence                 [Request changes] [Approve]

Communication
Selected source, messages, delivery state, optional reply

Activity history >
```

The exact labels and actions follow actual records and supported capabilities.
The example buttons are a gate, not a required footer for every workflow.
Question, tool permission, waiting, running, failure, and terminal states reuse
the same slots. Never invent an approval for a node without one.

## What stays and what moves

| Information or control | Placement |
| --- | --- |
| Title, ticket status, description | Initial ticket context; long description expands in place. |
| Project, priority, assigned agent when present | Quiet properties column; no redundant Context heading. |
| Configured current node name and runtime state | One activity heading; independent of ticket status. |
| Primary captured output and supported pending interactions | One activity panel. |
| Captured files and supporting references | Compact material access in the panel; existing inspector for files. |
| Exact operation-selected outgoing content and destination | Visible at its approval; separate from delivered communication. |
| Linked messages, observed delivery state, manual reply | Communication below the activity panel. |
| Concise workflow history | One collapsed Activity history section below communication, or below activity when no communication exists. |
| Node prompts and workflow instructions | Execution details. |
| Execution logs, full verification receipts, investigation detail, runner/session identifiers, live workspace diffs | Execution details. |
| Pause and cancel | Existing ticket options menu, when supported. |
| Workflow/effect recovery | A conditional Recovery entry in that menu opens the existing execution recovery interface. Do not embed recovery forms in the menu or initial view. |
| Existing agent conversation | Secondary Open chat action in the ticket options menu. |
| Source metadata and technical identifiers | Ticket properties/details; retain destination identity next to an operation when needed to understand its consequence. |
| Source configuration | Existing integrations surface; do not introduce another source editor. |

An actual blocking problem is an exception to secondary placement: retain a
concise, actionable state in the initial view and an entry to the owning recovery
surface. Uncertain external sends must remain visible in their communication
scope, including the existing source-match reconciliation controls. These are
part of reply safety, not optional execution diagnostics.

## Presentation rules

### Activity panel

Use one outer boundary, with internal spacing and at most a footer separator.
Remove nested card borders around ordinary output and decisions. State appears
once beside Current activity; the literal configured node name appears beneath.
Agent chat and Activity instructions do not occupy the heading.

Respect validated presentation bindings, including declared primary content.
Do not turn every string into a visible labelled block. Without a binding, render
the captured summary normally; long supporting text uses a short verbatim excerpt
with Show more/Show less. Preserve full content without rewriting it or inventing
a new summary. Other unbound details and references remain accessible through one
supporting-output disclosure within the panel, only when present.

For the existing supported reply effect, its exact configured sending field must
remain visible once, including without bindings or with another primary field.
Do not clamp or conceal that field behind the supporting-output disclosure.
Its special availability comes from the declared operation, not a field name,
customer, or workflow label. No new operation renderer registry is required.

Files use a compact row with captured names/count and access to the existing
inspector. Hide the row when there are no captured files. Keep source instance,
revision, stale-capture notices, authorized fetching, download fallback, keyboard
access, and parent-dialog focus behavior unchanged.

Place decision buttons together, compactly, in a horizontal footer. Primary
action styling communicates precedence; do not expand buttons to the panel width.
Wrap naturally on narrow screens. Request changes reveals its feedback input
only after selection. Multiple legitimate question/tool/gate interactions remain
distinct and available; do not hide one using a guessed priority.

Consequence copy says only what approval will authorize. Use the real destination
name/remote identity available from the operation. Remove repeated tutorials,
generic success prose, default Summary/Primary result/Configured reply labels
where placement already identifies the content, and duplicate status sentences.
Keep configured labels that distinguish multiple outputs. Do not remove actual
failures, unresolved outcomes, or access limitations to achieve visual neatness.

### Communication and history

Keep communication outside the activity panel, so operator output cannot be
mistaken for stakeholder-visible messages. No internal comments capability is
introduced. Select a source explicitly when multiple linked sources are present;
use source metadata to identify it. Keep the reply composer closed until Reply
is chosen or a retained draft exists. Show destination context when necessary.

Preserve ticket/connection/deployment/context isolation, capability checks,
stable retry request IDs, draft versions, late acknowledgement handling, remote
message deduplication, pending/unknown delivery states, and reconciliation.

History is a concise projection of existing flow history: configured node name,
observed outcome and recorded time when available. No commands, receipt bodies,
or shell output. Full history and diagnostics remain in Execution details.
Do not create an empty history section or fabricate cross-system audit events.

## Implementation boundaries and sequence

1. **Make destinations reachable.** Add explicit Execution details access to the
   existing ticket options menu; opening a ticket must still default to Details.
   Move Open chat and supported pause/cancel access there. Recovery navigates to
   the existing canonical recovery surface. Reuse Tickets-owned command wiring,
   claim/lease rules, confirmations, and runtime-availability checks. The app
   shell composes public feature interfaces; it must not acquire workflow policy.
2. **Separate the activity from execution detail.** Workflows owns the compact
   activity presentation and any extracted diagnostics component. Export through
   its public index. TicketExecution and session hosts retain access to instructions,
   receipts, mutable changes and recovery; extraction must not discard functionality.
   Use a small bounded presentation interface, not scenario templates or a universal
   widget/action registry. Standalone runs reuse the same compact activity structure.
3. **Clean the panel.** Apply the hierarchy, content disclosure, material row,
   concise consequence and compact footer. Styles stay in the owning feature;
   shared theme and palette stay unchanged.
4. **Compose ticket history after communication.** Resolve from the linked run's
   existing history, using Workflow-owned selectors/presentation rather than
   duplicating runtime semantics in Tickets. No new event store or domain model.
5. **Verify through the actual host.** Check real ticket entry points, nested
   inspector behavior and long content. A standalone fixture is supplementary,
   not proof that the ticket workspace matches the design.

Read the nearest README before source changes. Web features cross their public
index surfaces; contracts remain data only. No daemon, persistence, workflow
definition or adapter changes are expected for this presentation increment.
If missing data is discovered, report the bounded gap rather than fabricate it.

## Acceptance criteria

- Opening a review-pending ticket lands in Details. Execution details and existing
  agent conversation are reachable explicitly. Menu actions retain canonical
  authority, exact identities, confirmations and disconnect behavior.
- Initial ticket view contains context, one activity panel, optional communication
  and concise disclosed history. No instructions, log dumps, runner identifiers,
  verification receipts, mutable diff or routine management block appears there.
- The activity heading, primary content, files and current action are visually
  clear. Normal output and gate controls are not separately boxed. Decision
  buttons share a compact row on desktop and wrap without overflow on mobile.
- Long output does not dominate the initial viewport; full captured content remains
  inspectable. Exact sending text is visible once for unbound and non-primary
  fixtures; declared primary bindings remain respected.
- Running, waiting, question, tool permission, gate, missing material, failed,
  paused and terminal states show truthful supported interactions. Include no
  ticket, no artifact, no thread and no human gate cases; no empty placeholders.
- Two unrelated configurations with different node names, field names, work types
  and statuses use the same structure. No business strings select layout or actions.
- Captured inspection works from the actual ticket dialog: Escape closes only the
  inspector, focus returns, file switching works, and superseded captures remain
  truthful. Check loading, missing/forbidden content and download fallback.
- Communication preserves drafts, source identity, uncertain-send visibility and
  reconciliation. Moving diagnostics does not hide a blocking recovery state.
- Compare actual rendered ticket screenshots with the mockup for hierarchy, visual
  grouping, density and controls, using representative long content. Check a narrow
  viewport and keyboard navigation. Differences in fixture names/content are expected;
  differences in structural grouping must be explained, not waved away by passing tests.
- Run `npm run check:architecture`, `npm run build`, and relevant focused web
  regressions. Existing Work/Workflow acceptance coverage remains required if
  command wiring or lifecycle behavior changes. Report baseline/environment failures.

## Out of scope

New workflow capabilities, customer-specific layouts, new comments, durable
draft storage, rich custom artifact renderers, invented stakeholder names,
automatic sends/retries, live workflow edits, global theme changes and deployment.

## Local validation

The implemented ticket host was inspected in Chrome on 2026-10-01 with tickets
900022 (external clarification review) and 900009 (multi-document plan review).
Both use one activity panel, compact decisions and collapsed history; only the
linked ticket shows Messages. The rendered hierarchy was compared with the
mockup. Actual captured JSON and Markdown files loaded and switched in the
nested inspector. Escape closed only the inspector and restored focus to Inspect.
Execution details retained instructions, mutable changes and execution events.
The options menu was checked both open and hidden.

Supplementary intercepted fixtures verified exact outgoing content without a
binding and with a different primary binding, compact actions, a 390px viewport,
full-screen narrow file inspection, forbidden-content handling and download
fallback. Menu command checks covered declined cancellation, visible command
failure and successful retry. No review, send, pause or cancellation was executed
against the live tickets during this validation. Blocked effect recovery was
reviewed against the canonical command boundary: it offers Messages access,
not generic applied/not-applied confirmation.

Architecture and production build checks passed, as did focused ticket navigation,
menu, thread, artifact, workflow codec and interaction tests, Workflow module tests
and board/workflow acceptance tests. The existing large-bundle build warning
remains. Changes are local and uncommitted.
