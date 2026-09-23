# Ticket sync bindings: project routing and board projection spec

Status: Proposed. The current manual import accepts a project from the calling
UI. Persistent routing, binding-owned status policy, scheduling, and binding
diagnostics are not implemented.

## Purpose

Define how a configured external ticket source is assigned to a Convoy project,
how remote workflow states become Convoy ticket statuses, and how synchronized
tickets appear on boards without treating boards as synchronization targets.

This specification complements the [board integrations
spec](board-integrations-spec.md) and the [custom ticket source
spec](custom-ticket-source-spec.md). Those documents remain authoritative for
ticket origin, external links, field ownership, provider operations, and remote
observation normalization.

## Decision

Convoy synchronizes a **remote scope** into a **Convoy project** through a
persistent **ticket sync binding**. It does not synchronize remote boards into
Convoy boards.

A Ticket belongs to one project. A Board is a view over tickets from one or more
projects. Therefore project routing is durable synchronization policy, while
board membership, filters, grouping, and card placement remain presentation
policy.

```text
Ticket connection + remote scope
                 |
                 v
        Ticket sync binding
          |             |
          |             -> status and field policy
          v
      Convoy project
          |
          +----> Board A (status-backed view)
          +----> Board B (filtered/local view)
```

## Domain language

**Ticket connection** — Governed access to an external ticket system. It owns
provider selection, credentials, capabilities, and connection health.

**Remote scope** — A stable provider-defined container or query whose tickets
are synchronized together, such as a project, queue, team, or saved query. Its
identity is opaque to Work.

**Ticket sync binding** — Durable Work-owned policy assigning one connection
and remote scope to one Convoy project. Its immutable active revision owns
status mapping, field direction, initial population, matching, and lifecycle
policy. Control-plane attempt state refers to the binding but is not part of it.

**Routing claim** — Durable fact that one binding first assigned a globally
identified remote item to one Convoy ticket and project. Another binding cannot
silently replace that claim.

**Binding revision** — Immutable draft or active version of binding policy.
Attempts pin one active revision and never observe policy changes mid-run.

**Sync attempt** — Control-plane-owned execution record pinned to connection,
manifest, and binding revisions, a lease generation, and an input checkpoint.

**Status mapping** — Total mapping from supported stable remote status IDs to
Convoy ticket status values. Display names are descriptive and never serve as
identities.

**Status-backed board** — A board whose columns project a ticket field, normally
`status`. Its card placement is derived from the ticket value.

**Local board** — A board whose columns store local placement independently of
ticket status. Moving a card changes placement only.

**Unmapped observation** — A valid remote ticket whose remote status or other
required routed value has no binding policy. It is rejected or quarantined with
a diagnostic; it is never silently assigned a fallback.

## Ownership and dependency direction

- Work owns sync bindings and their revisions, routing claims, project routing,
  status and field policy, reconciliation plans, ticket mutation, and conflicts.
- The ticket source adapter owns external protocol translation and returns
  normalized observations plus stable remote scope and status identities.
- The control-plane sync coordinator owns adapter calls, attempts, cursors,
  schedules, fenced leases, retry timing, authorization, and effect
  reconciliation. It coordinates Work using a binding ID, never a UI-selected
  project ID.
- Persistence provides a transaction seam that commits the Work-approved page,
  diagnostics, attempt progress, and durable checkpoint atomically. Work does
  not call adapters or advance cursors.
- Boards consume Work-owned ticket fields and placements. They do not call
  provider adapters or decide synchronization policy.
- The web UI configures and previews bindings through typed commands. It does
  not infer routing from the currently open board.
- Shared contracts contain the binding and diagnostic data shapes only.

The Work interface should be small and deep:

```ts
previewTicketSyncBinding(draft, observations): BindingPreview
saveTicketSyncBindingDraft(input): TicketSyncBindingRevision
activateTicketSyncBinding(bindingId, draftRevision): TicketSyncBindingRevision
planTicketReconciliation(bindingId, revision, observations): ReconciliationPlan
applyTicketReconciliation(plan, commitGuard): ReconciliationResult
```

The control plane supplies observations to Work and commits an approved plan
with its checkpoint through one transaction seam. `commitGuard` includes the
pinned revisions, attempt identity, and current fencing generation. Provider-
specific scope discovery remains behind the external-ticket adapter; Work
receives only normalized scope descriptors and observations.

## Data model

Conceptual contract:

```ts
type RemoteScope = {
  kind: 'project' | 'queue' | 'team' | 'query';
  id: string;          // stable opaque provider identity
  name?: string;       // presentation only
};

type FieldDirection =
  | 'inbound'
  | 'outbound'
  | 'bidirectional'
  | 'local';

type InitialPopulation =
  | { mode: 'new-only'; after: string }
  | { mode: 'bounded-backfill'; after: string }
  | { mode: 'full-backfill' };

type TicketSyncBinding = {
  id: string;
  organizationId: string;
  activeRevision: number;
  lifecycle: 'active' | 'archived';
};

type TicketSyncBindingRevision = {
  id: string;
  bindingId: string;
  organizationId: string;
  connectionId: string;
  connectionRevision: number;
  manifestRevision?: string;
  remoteScope: RemoteScope;
  projectId: string;
  statusMappings: Record<string, {
    remoteName?: string;
    convoyStatusId: string;
  }>;
  outboundStatusMappings?: Record<string, {
    remoteStatusId?: string;
    remoteTransitionId?: string;
  }>;
  fieldDirections: {
    title: FieldDirection;
    description: FieldDirection;
    status: FieldDirection;
    priority: FieldDirection;
  };
  initialPopulation: InitialPopulation;
  matching: 'durable-link-only' | 'match-only' | 'match-then-create';
  scopeExit: 'retain' | 'archive' | 'review-detach';
  schedule: {
    mode: 'manual' | 'interval';
    intervalMinutes?: number;
  };
  revision: number;
  state: 'draft' | 'active' | 'superseded' | 'archived';
};
```

Cursor, attempt, pause, and diagnostic records refer to `bindingId`, not only to
`connectionId`. One connection may serve several scopes and projects without
sharing cursor or failure state between them.

An external link uses `(connectionId, remoteType, remoteId)` as its global
remote identity. Adapters must supply a connection-global canonical remote ID;
when a provider exposes only scope-local IDs, the adapter namespaces the scope
into that canonical ID. Mutable display keys and scope names are presentation
or provenance, never identity.

Routing provenance is append-only history, not one mutable `bindingId` on the
link. It records the winning routing claim, later observations through other
bindings, and explicit migrations.

## Invariants

1. A binding references one enabled connection and one existing project in the
   same organization.
2. The tuple `(connectionId, remoteScope.kind, remoteScope.id)` has at most one
   active binding. Fan-out is out of scope for the first release.
3. The first committed routing claim for a global remote identity owns its
   Convoy ticket and project. A different binding observing that identity emits
   `routing_collision` and performs no ticket mutation. Concurrent claims are
   serialized by a unique persistence constraint.
4. A binding cannot change `connectionId`, `remoteScope`, or `projectId` after
   it has linked tickets. Create a new binding and run an explicit migration.
5. Archiving a binding stops new synchronization but never deletes tickets,
   links, observations, routing provenance, or attempt history. Referenced
   bindings and revisions are never hard-deleted.
6. Board IDs are not required for synchronization and do not appear in the
   binding's routing identity.
7. Manifest configuration cannot contain Convoy project or board IDs.
8. Repeating the same remote observation through the same binding is
   idempotent.
9. Every attempt uses one immutable active binding revision. Activation and
   rollback are atomic; rollback creates a new revision.
10. Presentation constraints such as board WIP limits cannot reject canonical
    remote reconciliation.

## Remote scope selection

A connection represents governed account or endpoint access and must not own
one selected team, queue, or project. A binding supplies one bounded scope
description. Examples include a Linear team, a support queue, a provider
project, or a saved query.
The adapter is responsible for translating that descriptor into provider
requests.

Adapters declare scope and lifecycle capabilities:

```ts
type TicketSourceCapabilities = {
  scopeKinds: Array<'project' | 'queue' | 'team' | 'query'>;
  stablePagination: boolean;
  authoritativeSnapshots: boolean;
  explicitDeletionEvents: boolean;
  explicitScopeExitEvents: boolean;
  refreshOne: boolean;
  create: boolean;
  updateFields: string[];
  transitionStatus: boolean;
};
```

Binding activation validates its policy against these capabilities. The first
delivery must move Linear `teamId` from connection configuration into the
binding scope; scope discovery cannot be deferred while bindings depend on it.

For a custom HTTP source, the initial implementation may express scope through
a separately validated list-operation parameter set. Binding values may fill
only declared scope variables; they cannot replace hosts, credentials, paths,
selectors, or arbitrary headers.

If an endpoint returns tickets from several scopes, the observation must carry
a stable `remoteScopeId`. Work rejects records outside the binding's configured
scope. Per-ticket routing expressions and arbitrary routing code are out of
scope. Administrators should create one binding per remote scope.

Different scopes may still overlap. Scope equality prevents duplicate bindings
for the same selector but does not prove disjoint membership. Routing claims,
not configuration assumptions, resolve overlap safely.

## Project routing

All tickets first imported through a binding receive its `projectId`. Later
observations locate the ticket through its external link and preserve that
project assignment.

Changing the destination project is an explicit migration with a preview that
reports affected tickets, board visibility changes, workflow references, and
conflicts. Editing a binding must never mass-move linked tickets implicitly.

Manual **Sync now**, scheduled sync, and webhook-triggered reconciliation all
execute the same saved binding. None accepts a caller-supplied project override.

## Convoy status definitions

Statuses are project-owned definitions with stable IDs and mutable labels:

```ts
type ProjectStatusDefinition = {
  id: string;
  projectId: string;
  name: string;
  category: 'todo' | 'active' | 'done';
  revision: number;
};
```

Tickets reference `statusId`; boards and UI render the current name. This
prevents a rename, capitalization change, or translation from breaking a
binding. Existing free-form ticket status strings require a migration to
project status definitions before binding-owned mappings become authoritative.

## Status mapping

The adapter returns both a stable remote status ID and an optional display name:

```ts
type RemoteStatus = {
  id: string;
  name?: string;
};
```

The binding maps the ID to a stable project status definition:

```json
{
  "new": { "remoteName": "New", "convoyStatusId": "status-backlog" },
  "assigned": { "remoteName": "Assigned", "convoyStatusId": "status-ready" },
  "working": { "remoteName": "Working", "convoyStatusId": "status-doing" },
  "waiting_customer": {
    "remoteName": "Waiting for customer",
    "convoyStatusId": "status-doing"
  },
  "review": { "remoteName": "Review", "convoyStatusId": "status-review" },
  "resolved": { "remoteName": "Resolved", "convoyStatusId": "status-done" }
}
```

Many remote statuses may map to one Convoy status. A remote rename does not
break mapping because identity is stable. If a provider cannot supply stable
status IDs, the adapter must explicitly document and normalize its best stable
key; Convoy still treats label changes as a mapping change requiring review.

Status mapping rules:

- Preview must enumerate every observed remote status, its mapped Convoy value,
  affected count, and unmapped count.
- Enabling scheduled sync requires no unmapped status among the previewed scope.
- An unmapped status never defaults to `Backlog`, the first column, or the last
  known mapping.
- During sync, a newly encountered unmapped status rejects that observation and
  records an actionable binding diagnostic. The rest of a page follows the
  custom-source page atomicity policy; the initial safe behavior is to reject
  the page and pause scheduled sync.
- Mapping changes are saved as draft binding revisions and previewed before
  atomic activation. Reconciliation identity includes both remote version and
  binding-policy revision, so an unchanged remote observation is re-evaluated
  under a newly activated mapping.
- **Remap now** is a durable, resumable attempt pinned to one activated revision;
  it is not an incidental settings write. Partial failure cannot leave a cursor
  or mapping revision half-committed.
- The external link retains raw remote status ID and name, mapped project status
  ID, and semantic category. This preserves provider detail while enabling
  cross-project reporting.

## Board projection

### Status-backed boards

For synchronized workflows, the recommended board groups by `statusId`. Each
column declares the stable project status it represents:

```ts
columns: [
  { id: 'backlog', name: 'Backlog', value: 'status-backlog' },
  { id: 'ready', name: 'Ready', value: 'status-ready' },
  { id: 'doing', name: 'In progress', value: 'status-doing' },
  { id: 'review', name: 'In review', value: 'status-review' },
  { id: 'done', name: 'Done', value: 'status-done' },
]
grouping: { mode: 'field', field: 'statusId' }
```

Remote reconciliation changes the ticket status; the board projection then
moves the card automatically. No separate board-placement mutation is written.
A column may use a different display name from its value.

If a mapped status has no matching column, the board configuration is
incomplete. Preview and board settings should report this. The ticket remains
valid and visible according to board filters, but the UI must show it in an
explicit **Unmapped** lane rather than silently using the first column.
The lane is a computed presentation state, not a persisted fake placement.
Filters and WIP counts treat it explicitly.

Remote reconciliation is authoritative and is never rejected because a
projecting board has reached a WIP limit. Convoy commits the ticket update and
shows an over-limit diagnostic on the board. WIP rejection remains applicable
to interactive local moves.

### Local boards

Local boards retain independent placement. An imported ticket that has no
placement appears in a configured incoming column, or in an explicit unplaced
lane when no incoming column exists. Remote status changes do not move it.
The unplaced lane is computed and replaces today's silent first-column fallback;
an optional `incomingColumnId` must reference a column on that board.

Moving a card on a local board never changes a ticket field and never sends an
external update. The same ticket may have different local placements on several
boards.

### Board membership

A synchronized ticket appears on every board whose project membership and
filters include it. Adding or removing a board does not change the binding,
ticket origin, external link, or remote item. A board may provide a shortcut to
configure bindings for one of its projects, but it must show and save the
project destination explicitly.

## Direction and card moves

The first binding release is inbound only. Remote-owned status changes flow
from the remote source into the Convoy ticket and then into status-backed board
projection.

On a status-backed board, a ticket whose status direction is `inbound` cannot
be dragged to another status. The UI explains that its status is controlled by
the named source. Taking local ownership is a separate explicit policy change,
never a side effect of drag-and-drop. Local-board moves remain available because
they change presentation only.

Future outbound status updates require all of the following:

- the connection declares an update or transition capability;
- the binding gives `status` an `outbound` or `bidirectional` direction;
- every outbound Convoy status has an unambiguous reverse mapping to one remote
  transition or status ID;
- the actor has permission and the UI names the external effect;
- the effect uses durable idempotency, remote-version preconditions, read-back,
  and uncertain-outcome reconciliation.

A many-to-one inbound mapping does not imply a reverse mapping. For example,
both `working` and `waiting_customer` may map to `In progress`; moving a card to
`In progress` cannot choose between them. Configuration must require an
explicit outbound target or keep the move local.

Field direction is configured independently per field and validated against
connection capabilities. A generic `update` capability does not authorize a
status transition. Status requires a transition capability and one explicit
outbound remote target for each writable Convoy status.

## Identity, initial population, and matching

Durable external links are the default and authoritative matching mechanism.
Titles, display keys, board columns, descriptions, and timestamps are not
identities.

Every new binding explicitly chooses an initial population policy:

- `new-only`: observe items created or changed after an activation watermark;
- `bounded-backfill`: import no earlier than a confirmed timestamp;
- `full-backfill`: enumerate the authoritative scope subject to bounded pages.

Preview reports the selected boundary and estimated or observed volume. Ongoing
scope eligibility is independent from this initial boundary.

The default matching policy is `durable-link-only`: an unlinked remote item
creates a new Convoy ticket. `match-only` and `match-then-create` are advanced,
explicit adoption modes with deterministic provider identifiers or
administrator-confirmed candidates. They never use fuzzy or title-only matches,
and preview every proposed adoption before activation.

## Binding revision lifecycle

Binding configuration follows:

```text
draft -> validate -> preview -> activate
                           \-> discard
active -> new draft -> activate as next immutable revision
active -> archive
```

- Editing an active binding creates a draft; it never mutates active policy.
- Preview pins the draft revision and source watermark. Its counts are evidence
  from that point in time, not a promise that the source cannot change.
- Activation is compare-and-set against the active and draft revisions.
- Attempts pin one active binding revision, connection revision, and manifest
  revision. A configuration change either fences the old attempt before its
  next commit or lets it finish wholly under the old revision; policy is never
  mixed within one attempt.
- Rollback copies an earlier policy into a new revision and activates it. Audit
  history remains immutable.
- Mapping activation declares whether cursor lineage continues or a bounded
  remap/reconciliation attempt is required.

## Configuration experience

The administrator flow should be:

```text
Choose connection
  -> choose or enter remote scope
  -> choose Convoy project
  -> fetch bounded sample
  -> map all remote statuses
  -> choose field directions
  -> choose initial population and matching policy
  -> preview ticket changes and board projection
  -> activate as a manual binding
  -> Sync now
  -> optionally enable schedule
```

Preview includes:

- remote scope identity and sample size;
- target organization and project;
- would-create, would-update, unchanged, conflict, rejected, and out-of-scope
  counts;
- remote status IDs, names, mapped values, and counts;
- initial population boundary, matching policy, and estimated volume;
- boards that currently include the target project;
- missing status-backed columns and local-board incoming placement behavior;
- field directions, capability validation, and whether any outbound effect is
  possible;
- confirmation that no remote mutation occurs for an inbound-only binding.

The UI must not imply that checking a connection in Board settings creates a
sync route. Board creation destinations and ticket sync bindings are separate
policies and should have separate labels.

## Scheduling and execution

- New bindings start in manual mode.
- A successful preview and manual sync are required before scheduling.
- The control plane schedules by binding ID and obtains a binding-scoped lease.
  Every acquisition issues a monotonically increasing `leaseGeneration` fencing
  token.
- Cursor, backoff, pause state, and last-success time are binding-scoped.
- One failed scope does not pause other bindings using the same connection.
- Authentication or connection-wide failures may mark all affected bindings as
  unavailable without merging their attempt histories.
- Manual and scheduled runs share the same planning and reconciliation path.
- Continuous scheduling requires a supervised Convoy daemon; it does not
  require moving Convoy persistence into the source system.

Every page commit validates the attempt ID, pinned connection/manifest/binding
revisions, enabled state, and current lease generation. A stale worker whose
lease expired cannot commit tickets, observations, diagnostics, attempt state,
or a cursor after a newer worker acquires the lease.

### Checkpoints and pagination

The adapter declares whether its continuation is a stable cursor, a snapshot
watermark, or unstable offset pagination. The coordinator separately records:

- durable input checkpoint;
- attempt-local proposed next checkpoint;
- provider snapshot or watermark identity when available;
- overlap window when stable pagination is unavailable.

For each page, normalized observations are planned by Work. Ticket and link
mutations, routing claims, diagnostics, attempt progress, and checkpoint
advancement then commit in one transaction. A crash yields either the complete
page plus checkpoint or neither. Replayed and reordered observations are safe
through global identity, remote version, binding revision, and idempotent plans.

Offset-only providers use bounded overlap windows plus identity/version
deduplication. Convoy must not claim that an unstable offset prevents skips;
scheduled full reconciliation remains required where supported.

Duplicate canonical remote identities in one page, an unmapped required value,
or a stale commit guard rejects the page without advancing its checkpoint.

### Ordering and limits

- Provider version or snapshot ordering wins over arrival time. Older webhook
  or poll observations cannot replace newer confirmed observations.
- Binding-level rate limits compose with connection-wide and provider-wide
  budgets so several bindings cannot collectively overload one account.
- Attempt, observation, diagnostic, and tombstone histories have bounded,
  policy-defined retention while preserving audit-required summaries.
- A paused scheduled binding may be retried manually only through an explicit
  acknowledge-and-retry action that records the actor and does not bypass the
  failed checkpoint.

## Failure and lifecycle behavior

- Revoked connection: pause affected bindings; retain tickets and links.
- Deleted or inaccessible project: archive the binding and require a migration;
  never select another project automatically.
- Remote scope disappears: pause with a scope diagnostic; do not interpret all
  tickets as deleted.
- Remote item moves out of scope: record that state only from an explicit scope-
  exit event or a successfully closed authoritative snapshot. Otherwise retain
  `lastObservedInScopeAt` and report staleness, not a definitive move.
- Status becomes unmapped: stop before mutation according to page atomicity and
  surface the status ID and affected count.
- Board no longer includes the project: synchronization continues; only that
  board's visibility changes.
- Binding is archived: fence new page commits and start no new attempts;
  existing tickets remain normal Convoy tickets with historical links.

Normalized lifecycle evidence distinguishes `active`, `archived`, `deleted`,
and `scope-exit`. One missing incremental page is never evidence of any of
these. A provider 404 may mean deletion, movement, or lost authorization and is
not a tombstone unless the adapter can prove its semantics.

An authoritative full snapshot may produce absence observations only after all
pages close successfully under one snapshot generation. A partial or failed
snapshot produces none. The first release never hard-deletes a Convoy ticket in
response to remote lifecycle evidence. Binding policy may retain it, archive it,
or request reviewed detachment while preserving its external link and audit
history.

If a provider can reuse remote IDs after deletion, its adapter must supply an
incarnation/generation identity. Otherwise activation requires the provider's
guarantee that canonical IDs are never reused.

## Conflict and observation model

Each mapped field retains:

- last observed remote value and remote version;
- last applied remote value and binding revision;
- local ticket revision at the last successful reconciliation;
- current local value and revision;
- active field direction.

Work computes conflicts per field. Independent local and remote edits to
different fields merge. An inbound field applies the newer remote observation;
a local field only records it; a bidirectional field conflicts when both sides
changed since their shared baseline. Conflict resolution uses compare-and-set
against both the local revision and remote observation version. Retrying a
resolved remote version cannot recreate the conflict.

## Migration and rebinding

Changing a binding's scope or project creates a durable migration plan rather
than editing the binding. The plan records source and target binding revisions,
ticket/link revisions, routing claims, project-owned references, board
visibility changes, cursor policy, conflicts, and rollback constraints.

Execution fences both sides from concurrently mutating migrating identities.
It is all-or-nothing when the bounded set fits one transaction; otherwise it is
resumable in idempotent batches with an explicit cutover point. A stale preview,
destination identity collision, or changed ticket revision refuses execution
or requires a new plan. Routing provenance remains append-only through cutover
and rollback.

Disabling the current routing owner never transfers ownership to an overlapping
binding. Reassignment requires this explicit migration path.

## Outbound effect ledger

Future outbound operations use a durable control-plane effect record created
before any provider mutation:

```text
planned -> dispatched -> confirmed
                    \-> uncertain -> reconciled
                    \-> failed
```

The record pins actor, ticket/link identity, binding revision, expected remote
version, requested transition or field patch, idempotency key, and read-back
evidence. Process loss after dispatch cannot authorize a blind retry. Webhook or
poll echoes of a Convoy-originated effect confirm or reconcile that effect
rather than automatically creating a conflict.

## Authorization and audit

- Organization administrators may create connections and bindings or change
  remote scopes, project routing, mappings, field directions, and schedules.
- Project administrators may run or pause a binding only when organization
  policy grants that authority; project membership never exposes credentials.
- Manual sync records the requesting principal. Scheduled sync records its
  trigger and pinned binding revision.
- Audit history distinguishes connection changes, binding changes, mapping
  activation, manual runs, schedule changes, conflict resolution, and future
  outbound effects.

## Delivery slices

### Slice 1: persistent manual binding

- Work-owned binding identity plus immutable draft/active revision persistence.
- Account connection and remote scope separation, including moving Linear team
  selection into binding scope and adding typed custom-source scope parameters.
- One remote scope to one Convoy project.
- Project status definitions with stable IDs; binding-owned status mapping and
  field direction.
- Initial population and durable-link matching policy.
- Preview and manual **Sync now** by binding ID.
- Global remote identity, routing claims/collisions, and append-only provenance.
- Status-backed board projection diagnostics, virtual unmapped/unplaced lanes,
  externally owned drag protection, and non-blocking WIP diagnostics.
- Migration of the current UI-supplied project import into explicit bindings.

### Slice 2: binding-scoped scheduling

- Durable attempt history, cursor semantics, fenced leases, jitter, backoff,
  pause state, atomic page checkpoints, and bounded reconciliation.
- Connection-wide health projected onto affected bindings.

### Slice 3: lifecycle and migration

- Provider-supported remote scope discovery beyond typed manual input.
- Tombstone, authoritative-snapshot, scope-exit, and staleness policy.
- Explicit binding/project migration preview and execution.
- Draft rollback and resumable remap attempts.

### Slice 4: controlled outbound status transitions

- Explicit reverse mappings and transition capabilities.
- Durable effect ledger, read-back, conflict handling, and uncertain-outcome
  repair.

## Acceptance criteria

### Routing and identity

1. An administrator binds one remote support queue to Project A. Manual sync
   always imports into Project A regardless of which page initiated it.
2. The same connection has a second queue bound to Project B. Its tickets,
   cursor, failures, and schedule remain independent from Project A.
3. Two differently identified scopes overlap on one canonical remote item. One
   routing claim wins, one Convoy ticket exists, and the other binding records
   `routing_collision` without mutation.
4. Two attempts race to claim the same previously unseen remote item. The
   persistence constraint selects one project atomically; the loser leaves no
   partial ticket, link, placement, or checkpoint.
5. Archiving the routing owner does not transfer ownership to another binding.
6. A provider exposes scope-local numeric IDs. Its adapter namespaces them into
   connection-global canonical identities so two scopes do not collide.

### Mapping and boards

7. Two remote statuses map to `In progress`. Both tickets appear in the
   `In progress` column on a status-backed board.
8. A remote status is renamed but retains its ID. Synchronization continues
   using the existing mapping and updates the displayed remote name.
9. A previously unseen remote status arrives. Convoy does not default or move
   the ticket; it records an actionable diagnostic and does not advance beyond
   the rejected page.
10. Mapping `working` changes from one project status to another while the
    remote version remains unchanged. Reconciliation re-evaluates the retained
    observation under the new binding revision and applies the remap.
11. A ticket's project appears on two boards. One status-backed board moves the
   card when status changes; the other local board preserves its placement.
12. A board excludes the bound project. Sync continues successfully and the
   ticket simply does not appear on that board.
13. A remote update enters a status-backed column already at its WIP limit. The
    ticket update commits and the board reports over-limit state; the page and
    cursor are not rejected by presentation policy.
14. A mapped status has no board column. The ticket appears in a computed
    Unmapped lane, never the first column.
15. A local board has no incoming column or placement. The imported ticket
    appears in a computed Unplaced lane.
16. Dragging an inbound-owned ticket on a status-backed board is disabled and
    produces no local status change or external mutation.
17. A user invokes Sync now from a board shortcut. The saved binding's project
   is used; the board cannot override it.

### Revisions and execution safety

18. A binding with linked tickets cannot silently change its scope or project.
   Convoy requires an explicit migration preview.
19. Binding revision v2 activates while an attempt runs under v1. The attempt
    either finishes wholly under v1 or is fenced before its next commit; no page
    mixes revisions.
20. Attempt A stalls, loses its lease, and later returns after attempt B commits.
    A cannot mutate tickets, diagnostics, attempt state, or checkpoint.
21. The daemon stops during a page transaction. Recovery contains either every
    planned mutation plus the checkpoint or none of them.
22. Replaying the same page with reordered observations produces the same
    ticket and checkpoint state.
23. A duplicate identity or unmapped required value rejects the whole page and
    leaves its durable checkpoint unchanged.
24. An item is inserted remotely between unstable offset pages. Bounded overlap
    and later reconciliation observe it without creating a duplicate.
25. Archiving a binding leaves tickets, origin, links, routing provenance, and
    audit history intact while fencing new commits.

### Lifecycle and conflicts

26. Missing from one incremental run causes no deletion or scope-exit state.
27. A completed authoritative snapshot may produce an absence observation; a
    failed snapshot produces none.
28. Explicit deletion evidence follows retain/archive/review-detach policy and
    never hard-deletes the Convoy ticket in the first release.
29. A provider without scope-exit evidence records staleness. A provider with an
    explicit scope-exit event records the versioned transition.
30. Independent local and remote edits to different fields merge. Concurrent
    edits to one bidirectional field produce one versioned conflict.
31. A stale conflict-resolution command fails compare-and-set rather than
    overwriting a newer local or remote value.
32. A migration preview becomes stale or collides with a destination identity.
    Execution refuses or requires a new plan and preserves routing provenance.

### Population and outbound behavior

33. `new-only`, bounded-backfill, and full-backfill bindings expose their exact
    boundary in preview and do not silently broaden it.
34. Durable-link matching never adopts a title-similar ticket. An advanced
    adoption mode previews every deterministic match before activation.
35. Moving a card on a local board produces no external mutation.
36. An inbound many-to-one status mapping exposes no outbound transition until
    an administrator configures an explicit reverse target and the connection
    supports transitions.
37. Process loss after an outbound provider success but before local
    acknowledgement leaves an uncertain effect that reconciles by read-back;
    it does not blindly repeat the transition.

## Migration from current behavior

The current manual import receives `connectionId` and `projectId` from the UI.
Migration should:

1. Add binding persistence and commands. Extend existing external link identity
   with `remoteType: ticket`; where current provider IDs are already connection-
   global, preserve them exactly. Any required scope namespacing is previewed
   and migrated without duplicating tickets.
2. Introduce stable project status definitions and map existing status strings
   to project-owned IDs before activating binding mappings.
3. Separate account access from scope: move Linear `teamId` into binding scope
   and add declared, typed scope parameters for custom sources.
4. Migrate custom manifest `values.status` and `ownership` into a draft binding.
   The manifest thereafter emits stable remote status identity and performs
   representation normalization only; the administrator resolves any ambiguous
   conversion before activation.
5. Require users to create a binding before the next manual import; do not infer
   a durable route from historical board placement.
6. Offer a prefilled project based on existing linked tickets only when all
   tickets for the connection agree; the administrator must confirm it.
7. Establish routing claims and append-only binding provenance for existing
   links without rewriting their canonical external identity.
8. Replace board-level **Import tickets** with **Configure sync** or **Sync now**
   for an existing binding.
9. Replace silent first-column placement with explicit Unmapped and Unplaced
   projection states before externally mapped statuses depend on them.
10. Remove caller-supplied `projectId` from the sync command after migration.

No migration may embed provider-specific or organization-specific logic in
Convoy.
