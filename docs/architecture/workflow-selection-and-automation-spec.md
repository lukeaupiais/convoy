# Project workflows and start automations

Status: **decision accepted; first implementation slice in place** (2026-09-21).
## Decision

Use one versioned **workflow run** for dependent agent stages, checks, approvals,
evidence, and bounded revision routes. Let a project publish multiple workflow
definitions with different stages. Use separately managed **start automations**
to select a published workflow when a ticket or board event occurs. A board is an
event source and a view of tickets, not the owner of workflow progress. Keep the
stage list as the normal editor; use a graph view for complex routes and run
inspection.

This gives an operator a simple `When -> If -> Start workflow` interface without
turning every stage into an independently triggered run. For example:

```text
Project: Agent platform
Start automation: Ticket enters QA board / Ready column
Condition: ticket belongs to Agent platform
Action: start QA review v3

QA review v3: inspect change -> run project checks -> human review
                failed check -> return to inspect, within its revision limit
```

The start automation decides *whether to create a run*. The selected workflow
owns *what happens within that run*. A board move never proves that a check
passed, an artifact was accepted, or a human approved a submission.

## Goals and constraints

- A project can offer several named processes and choose a default. An explicit
  ticket launch can choose any eligible published definition; an automation can
  select one on a matching event.
- Projects with different stages publish different definitions. Initially,
  `Create from template` makes an independent draft with provenance; editing a
  template does not mutate project variants. Add typed project parameters only
  after repeated settings, such as check commands or reviewer roles, prove a
  stable shared interface. Do not introduce live inheritance in this slice.
- A run records the exact workflow ID and version. An automation records its
  own revision and targets an exact published workflow version. Publishing a
  newer version does not silently retarget an automation or an active run.
- Project, organization, board, and column eligibility is enforced in the
  daemon at publication **and** launch. A client selector is only a view.
- Keep local and SSH worker semantics, exact approval identity, session leases,
  workspace ownership, and explicit reconciliation of uncertain effects.
- Preserve `.convoy/` data and `CONVOY_*` compatibility names.

Out of scope for the first delivery: a general automation action catalog,
automations chained from workflow effects, parallel/join workflow execution,
live template inheritance, automatic retries of uncertain mutations, and
automatic board movement on workflow completion.

## Proposed domain model

**Workflow definition** remains owned by Workflows: a published, immutable
process with stages, outcome routes, revision limit, and optional project scope.
Organization definitions may be shared with eligible projects. A project-scoped
definition may only run for that project. Team metadata cannot widen access.

**Start automation** is a separate Workflows-owned definition with a stable ID,
revision, owning organization and required project, enabled state, event match,
optional board/column and typed ticket filters, and one action:
`start_workflow(workflowId, workflowVersion)`. The first release deliberately has
one action and one target. It also names a governed execution principal or
project policy whose current grants must be resolved at start time. The actor
who moved a board card does not implicitly grant their authority to future
agent work. It should not expose arbitrary daemon commands.

**Start decision** is a durable record for each observed event and candidate
automation: rule ID/revision, event ID, ticket/project/board IDs, match or
non-match reason, selected workflow ID/version, and terminal result. Results
include `filtered`, `started`, `blocked_active`, `conflict`, `failed_before_start`,
and `needs_reconciliation`. Decisions and run IDs remain queryable even if a
rule is disabled or superseded.

**Workflow run** remains the durable instance of one pinned definition. Stage
completion is an internal transition of that run. An external event may be used
as evidence or to resume a waiting stage only through an explicit, correlated
run command with the expected stage instance and pinned revision; a general
start automation cannot advance an arbitrary active run.

The public data shapes belong in `packages/contracts`; domain matching,
eligibility, and transition decisions belong in Workflows. Work owns tickets,
boards, placement, and completed mutation facts. The control plane passes those
facts through an injected observation seam and coordinates the atomic save.
Web and CLI consume contracts only. Runner and provider details remain in
adapters. New daemon code imports other modules through their `index.mjs`
surfaces.

## Selection and event semantics

1. **Manual ticket launch:** list only definitions eligible for the ticket's
   organization and project. Preselect the project default, then an eligible
   organization default. Show the exact version, stage summary, required runner
   capability, and approvals before launch. Revalidate eligibility, ticket
   revision, and selected version in the daemon when `runTicket` executes.
2. **Automation launch:** require a project in the rule. If a board is named,
   validate that the board contains that project; if a column is named, validate
   that it belongs to the board. A board spanning projects needs one explicit
   project-scoped rule per intended project. Match the completed Work fact's
   *before* and *after* values so `entered column` is distinct from `left
   column` and `still in column after update`.
3. **Multiple matches:** if more than one enabled start automation matches the
   same ticket event, start none and record a `conflict` for operator resolution.
   Do not use implicit list order or silently choose the latest workflow.
4. **Existing active run:** start none, record `blocked_active` with the active
   run link, and expose an operator action to review it. Do not auto-queue or
   replay the event in the first release.
5. **Duplicate event:** deduplicate on the stable Work event ID plus rule ID and
   revision. Persist the start decision before dispatch. An uncertain dispatch
   requires readback and explicit reconciliation; no automatic second start.
   Resolve the automation principal's project, model, runner, and profile grants
   at dispatch; deny and record the decision if any grant has been revoked.
6. **Workflow-created Work mutation:** keep the current no-recursive-trigger
   behavior. Record that source in the event fact so matching is explainable.
7. **Rule or workflow change:** edits create a new revision. An enabled rule
   continues to target its pinned workflow version until an authorized update
   explicitly retargets it. Already started runs never change definition.

## Operator interface

**Automations list:** one row per rule with name, project, optional board and
column, `When / If / Then` summary, enabled state, target version, last decision,
and last error. Create from a project or board context. The editor previews a
representative event and shows whether it matches, conflicts, or would be
blocked by an active run. Enabling and retargeting are separate publish actions.

**Workflows list and editor:** show organization/project scope, latest published
version, draft, default status, linked start automations, and active runs. Start
with a stage list and visible entry summary: manual launch and linked rules.
Each stage shows type, required evidence, success route, alternate routes, and
approval authority. `Create from template` produces a project-owned draft;
publishing shows a plain-language diff and impact on linked rules. Advanced
graph editing remains available for routes the list cannot express cleanly.

**Run view:** lead with a chronological timeline: source event and rule revision,
workflow version, stage transitions, captured evidence, exact approval package,
wait/failure reason, effect status, and allowed recovery action. A graph is a
secondary dependency/progress view. A skipped or conflicting start appears in
automation history even though no workflow run exists.

## Acceptance proof

- Two projects can publish different stage sequences, and a ticket in each
  sees only eligible definitions and its own default. A direct cross-project
  `runTicket` command is denied without creating a session or effect.
- One ticket can appear on two boards with different columns. Moving it on one
  board matches only that board's explicit project rule; its other board
  placement and authoritative ticket status remain unchanged unless the Work
  command itself specifies a field-backed change.
- Entering a named column starts the pinned workflow exactly once. Leaving it,
  updating the ticket while it remains there, or receiving a duplicate event
  does not start another run. A broader rule overlap yields a visible conflict.
- A matching event during an active run produces a durable `blocked_active`
  decision with the run link. No implicit replacement, queue, or retry occurs.
- Publishing workflow v4 or disabling a rule leaves a running v3 process and
  its approval package intact. Retargeting the rule affects only later events.
- Restart after a pending or uncertain start/effect requires readback and
  explicit reconciliation. Failed-start retry uses its original pinned workflow
  version and cannot replay the initiating board mutation.
- The same stage, approval, and recovery outcomes hold on local and SSH workers;
  no browser-side state is needed to enforce them.

## Current implementation and limits

The first slice adds Workflows-owned start rules, one-time conversion of
historical embedded triggers, project and version eligibility for ticket
launches, rule editing in the workflow studio, project-specific ticket workflow
selection, and durable `conflict` and `blocked_active` decisions. Rules pin the
workflow version and the publishing principal; current project, model, profile,
and required runner access is checked before dispatch. Column entry uses before
and after board placement. The stage view follows the entry and primary route;
alternate stages are identified and require graph editing to reorder.
Acceptance coverage exercises pinned starts, restart, conflicts, active runs,
cross-project denial, failed retry, and workflow-created ticket events.

Current limits:

- Give Work a stable event ID and explicit before/after facts for every relevant
  ticket mutation. Current deduplication uses idempotency key or ticket revision.
- Add decision reconciliation for a start left `pending` by a crash, a run link
  and recovery actions in the operator view, and richer rule history including
  filtered decisions. Keep replay fail-closed.
- Specify how a nonpersonal organization selects and rotates its automation
  principal, including approval of delegated runner and provider authority.
- Add overlap preview, publish impact review, project-variant provenance, and
  a run timeline.
- Cover cross-organization and team isolation and local/SSH parity directly in
  acceptance tests, beyond the current project-scope and recovery cases.
