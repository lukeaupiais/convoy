# Workflows

Owns validation and publication of immutable graph definitions plus deterministic
run transitions. Graph edges, not canvas position or board columns, select the
next node. Agent output advances only through explicit submission or operator
action.

Automations are separate project-owned When / If / Then rules. Each pins one published
workflow version, optionally matches a board and entered column, and records
the principal whose current grants are checked at dispatch. The completed Work
fact is observed through the control plane; multiple matches conflict and an
active run blocks another start. Legacy rules require the offline automation migration; runtime accepts only the
canonical schema. Active-run holds remain visible until explicit retry.

Import and customer-message start rules are scoped to one import binding and
may also select a work type. A wait node can resume an active run from a ticket
event, including an update to linked development work. Workflow actions can
create a linked development ticket in the same project. The customer ticket's
external status remains owned by its source.

Workflow actions resolve through a static registry of versioned activity descriptors.
Descriptors publish bounded input/output schemas, resource needs, effect and approval
policy, lifecycle capabilities, and presentation data; implementations are supplied
by the daemon composition root rather than loaded from workflow content. Run inputs
and completed activity outputs are immutable values. Bindings accept constants or
declared paths from run input and earlier reachable activity outputs, and are checked
at publication and again when resolved for dispatch.

An activity acquires resources only when it becomes active. Daemon transforms do
not create agent sessions or require a workspace; runner activities recheck the
current execution grant and exact workspace before dispatch. A registered activity
that declares an agent resource lazily attaches a real provider session when its
node becomes active, using the stored run principal. Its exact node model, current
provider grant, and declared tools are checked before each adapter prepare/dispatch,
including when a run already has a linked session. Provider-only activities do not
acquire a runner just because the project has a runner placement. Legacy agent nodes
still create their session when activated. Each effect attempt pins its activity
revision, resolved input digest, idempotency identity, and prepared intent before
invoking its adapter. Workflows remains the sole owner of attempts and compatibility
effect evidence. Completed receipts are immutable; waiting effects can be confirmed
against their owner, while uncertain durable effects require adapter reconciliation
and are never replayed automatically. Current project grants and required exact
human-gate approvals are checked for dispatch and reconciliation. Preparing an
approval reservation is resource independent: it checks the active run principal,
project permission, and selected provider model, then pins that model with the exact
intent. It does not allocate a future provider session, runner, workspace, or tool
grant. Adapter `prepare` receives `session: null` and a bounded run projection without
session IDs, workspace paths, runner assignments, or execution grants; an adapter
that needs those values cannot prepare an approval intent and fails the command.
Resource and Library checks run again when the approved activity becomes active; a
grant revoked after review blocks dispatch without replaying or changing the approved
intent.

Agent submissions capture every declared artifact as an immutable, content-addressed
review package. Human decisions apply to that captured submission; the mutable
workspace remains separately checked for stale evidence before advancement.

Workflow definition publication and draft commands are registered through the
control-plane module command registry. Workflows owns canonical run identities,
pinned definitions, activity attempts, run history, run leases, migration from
legacy `session.flow`/`pastRuns`, and the bounded run read model. A session's
`flow` and `pastRuns` are compatibility projections of that owner. The
control-plane checks current project grants and the stored run principal at each
runtime command and dispatch boundary, then delegates run transitions here.

`startWorkflowRun` can execute branch, Work action, human gate, and wait graphs
without creating a session, conversation, provider turn, repository, or runner.
An agent node lazily creates and links its conversation/session when it becomes
active. `getWorkflowRun` reads one run by its stored project scope when it is
outside the bounded snapshot page. Run decisions record the authenticated
principal with the actor label; stale instances fail closed. An uncertain Work
effect stays uncertain through cancellation and restart until its exact effect
key is explicitly reconciled. Restart clears live run leases while retaining
actor and decision evidence.

The built-in **Team delivery** template is an explicitly selected, editable starting graph:
plan ticket → approve plan → implement → verify → human review. Failed checks
and requested changes route back to implementation through the bounded revision
loop. Projects without a configured default do not select a workflow implicitly. It
produces evidence and an accepted handoff only; it never pushes,
merges, deploys, or changes a ticket's authoritative delivery state.

Its default verification command is a portable runner-level whitespace check.
Teams should replace it in a published template revision with the project's own
test command.

A definition can pin `capabilityProfile: { id, version }` from the Library.
The control plane resolves it at the engine's start boundary for manual,
automated, and conversation-only runs. Resume does not resolve a newer revision.
Workflow node `skills` selects from this profile, while node `permissions`
further limits its tools. Missing declared skills fail publication or launch
when a profile is selected.

Agent submissions must choose a configured outgoing route. An omitted outcome
still means `success`, but cannot implicitly terminate a node with custom forward
routes. Terminal success/approval remains valid for nodes with no outgoing routes
or only `failed` / `changes_requested` repair routes. Invalid submissions leave
review evidence and history untouched.


`send_external_reply` sends a configured detail field from an agent's captured
submission after a human approves that exact package. Its input declares the
connection, `sourceNodeId`, and `field`; incoming routes must be human `approved`
edges. The engine preserves the approved submission independently of subsequent
stage summaries. The control plane uses Work's canonical reply command and a
stable request identity, then confirms the matching message in the source thread.
Pending or failed delivery pauses the action; Continue checks delivery without
posting again. An uncertain send requires reply and effect reconciliation before
advancement. Sending does not imply an external status change: declare that as a
separate action after delivery.

Human nodes may configure plain text labels for the existing `approved` and
`changes_requested` outcomes. The labels are part of the published workflow
revision and run snapshot; they affect presentation only. Missing labels use
“Approve” and “Request changes”. They do not add outcomes, select routes, or
grant authority.
