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

External effects are requested through injected callbacks and recorded so restart
recovery can avoid uncertain replay.

Agent submissions capture every declared artifact as an immutable, content-addressed
review package. Human decisions apply to that captured submission; the mutable
workspace remains separately checked for stale evidence before advancement.

Workflow definition publication and draft commands are registered through the
control-plane module command registry. Active-run controls remain coordinator
operations because they require a session lease and can span Work and Execution.
After that lease gate, active-run start, stop, decisions, trigger retries, and
effect reconciliation are Workflow session commands.

The built-in **Team delivery** template is an editable, additive starting graph:
plan ticket → approve plan → implement → verify → human review. Failed checks
and requested changes route back to implementation through the bounded revision
loop. It produces evidence and an accepted handoff only; it never pushes,
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
