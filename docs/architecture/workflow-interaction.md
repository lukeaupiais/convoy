# Workflow interaction and ticket workspaces

The Workflows web feature owns run interaction and material presentation. Tickets
and session hosts compose its public interface. Layout and actions follow actual
data, declared capabilities, pinned presentation metadata, and runtime state.
Board names, work types, customer statuses, field names, and content do not select
business-specific renderers or authority.

## Presentation

The initial ticket workspace shows ticket context, available workflow activity,
captured output and files, supported pending interactions, linked communication,
and concise disclosed history. Empty optional sections are omitted. Instructions,
logs, runner identifiers, mutable workspace changes, and operational recovery
remain accessible through execution details and supported menu actions.

Published node presentation bindings may select a summary, declared detail field,
or captured artifact, with an optional label and one primary selection. Bindings
select existing material; they cannot add content, make it required, grant
permission, or change transitions. Configured human outcome labels and typed
response fields come from the pinned definition. Questions, workflow decisions,
and tool approvals retain their distinct identities and commands.

## Captured material and decisions

Material is resolved by source node, execution instance, and submission revision.
A decision applies to the exact captured revision. Later summaries do not replace
approved material, and a new revision needs a new decision. A mutable workspace
diff is diagnostic context, not the immutable submitted package.

Captured Markdown, text, and JSON have previews; other formats use metadata and
download. Inspection preserves the selected revision during unrelated snapshot
updates and identifies superseded captures. Missing required material blocks the
affected decision. Preview and download recheck authorized content access.

The inspector supports keyboard file selection, focus containment, Escape, and
focus return. Closing it inside a ticket dialog closes only the inspector. Narrow
screens use a full-width overlay. Content is escaped or rendered through the safe
Markdown renderer rather than executing captured HTML or SVG.

## Communication and recovery

Operator output and external messages are separate. Thread selection, replies,
drafts, uncertain outcomes, and reconciliation are scoped to the same ticket and
connection. Capability and authority checks determine whether manual reply is
available. Drafts survive snapshot changes, and late acknowledgements cannot clear
newer text or a different destination's draft. Retries preserve the request identity.

For an [approved workflow reply](approved-workflow-replies.md), the exact sending
text and supported destination remain inspectable at approval. Approval authorizes
that captured operation; delivery needs confirmation from its source. Uncertain
sends remain visible and block duplicate sends in their scope until reconciled.

Ticket status, board placement, workflow state, tool authorization, and reply
delivery are independent observations. UI availability is a convenience: the
daemon revalidates authority, leases, active instances, and exact material on every
command. A restart or disconnect cannot restore a stale approval or imply a safe
retry of an uncertain effect.
