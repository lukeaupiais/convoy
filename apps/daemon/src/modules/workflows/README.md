# Workflows

Owns validation and publication of immutable graph definitions plus deterministic
run transitions. Graph edges, not canvas position or board columns, select the
next node. Agent output advances only through explicit submission or operator
action.

Start automations are separate project-owned rules. Each pins one published
workflow version, optionally matches a board and entered column, and records
the principal whose current grants are checked at dispatch. The completed Work
fact is observed through the control plane; multiple matches conflict and an
active run blocks another start. Historical embedded triggers migrate once to
rules, then only rules are evaluated.

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
