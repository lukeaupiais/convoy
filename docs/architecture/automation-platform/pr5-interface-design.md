# PR 5 implementation proposal — registered events and correlated waits

PR 5 adds event sources around the PR 3 durable WorkflowRun and PR 4 registered activity-attempt engine. Workflow definitions, subscriptions, schedules, accepted event journal, dedupe, and wait transitions remain owned by Workflows. Work retains ticket and board facts in its outbox. Source-specific integrations translate their protocols into validated event envelopes. The control plane authenticates and authorizes sources, coordinates owner calls, and routes accepted events to the existing WorkflowRun engine; it does not own a second journal or add another executor.

## Event descriptor and envelope

Use a descriptor registry injected when Workflows is constructed. Descriptors are reviewed in-process registrations from owning modules or adapters, never code loaded from a workflow manifest. Each descriptor has an immutable revision and advertises the fields and typed predicate operators callers may use.

```ts
type EventDescriptor = {
  id: string;
  revision: number;
  label: string;
  source: { owner: string; adapter?: string };
  tenantScope: 'organization' | 'project' | 'resource';
  payload: { path: string; type: 'string' | 'number' | 'boolean' | 'enum'; values?: string[] }[];
  correlationPaths: string[];
  maxPayloadBytes: number;
};

type WorkflowEventEnvelope = {
  id: string;
  descriptor: { id: string; revision: number };
  source: { id: string; eventId: string };
  organizationId: string;
  projectId?: string;
  resourceRef?: { kind: string; id: string };
  origin?: { kind: 'user' | 'workload'; id: string };
  occurredAt?: string;
  receivedAt: string;
  payload: Record<string, unknown>;
  correlation?: { key: string; value: string };
  causation?: { eventId: string; runId?: string; depth: number; rootEventId: string };
};
```

The descriptor is the contract for schema validation, tenant source, correlation, and bounded predicates. An envelope is immutable after acceptance. The event journal deduplicates on `(source.id, source.eventId)`, independently of descriptor revision, so upgrading an adapter cannot replay the same source event into a new run. The first accepted envelope stores its descriptor revision and payload digest. A repeat with the same identity and same payload/schema identity returns the original event/decision; a changed payload or incompatible schema identity is rejected and audited as a source conflict unless the source supplies a genuinely new event ID. `receivedAt` is set by Convoy; source time is informational and cannot make a late event fresh. Derive organization/project/resource from the registered source binding or canonical owner fact. Caller-provided tenant, principal, source identity, correlation, causation, or descriptor revision cannot widen routing or visibility.

Event descriptors expose only explicitly declared payload paths with simple types and bounded enum values. Validate payload shape, nesting, collection size, and total bytes at ingress. Conditions use a compact data shape such as `{ path, operator: 'equals' | 'notEquals' | 'greaterThan' | 'lessThan' | 'exists', value }`; operators must be valid for the advertised type. Cap condition count and scalar sizes. No expressions, arbitrary JSON path traversal, coercive comparison, secret paths, or executable predicates.

## Publication and owner boundaries

Add a small Workflow-owned `acceptEvent(envelope)` interface that validates the registered descriptor, enforces immutable dedupe, writes the bounded durable event journal, and returns matched start decisions and wait deliveries. Workflows owns the event ledger writes, subscription matching, automation decision records, and wait state transitions. The control plane supplies authenticated source context, checks tenant policy, coordinates owner calls and delivery/recovery, and exposes public commands; it does not own a second event ledger. HTTP only validates transport framing and invokes the webhook adapter. Use public module indexes for all owner calls.

Work emits typed facts only after its canonical command succeeds. Preserve its current event IDs (`ticket_created`, `ticket_updated`, `ticket_moved`, `board_placement_changed`, `ticket_imported`, `ticket_source_updated`, and `ticket_message_received`) as aliases to registered Work descriptors so existing rules and clients remain readable. Work provides a stable source event ID tied to the committed fact and payload derived from the authoritative ticket, board, or import binding. The control plane journals that fact with an idempotent outbox identity before acknowledging delivery; retries route the same identity. Do not duplicate ticket state in the event journal. Existing `AutomationEvent` and `when.event` rules remain accepted through the compatibility resolver and explicit migration path; historical decisions and retry identities are retained.

Every subscriber sees the same accepted envelope independently. Consuming an event to resume a wait does not suppress a matching automation start. Each subscriber has its own idempotency key and decision. There is no accidental global consume flag.

## Governed manual and webhook sources

Manual submission is a canonical `submitWorkflowEvent` command. Organization/project context comes from the authenticated active context; the control plane checks the caller's current membership, project access, and permission to submit that descriptor. The caller may supply a bounded idempotency key, scoped by the server to the authenticated source principal and descriptor, so retried commands resolve to the original event; the caller cannot choose the principal or source scope. Workflows validates only the declared payload and records the authenticated principal as `origin`. The client cannot choose another tenant, workload principal, descriptor revision, source identity, or correlation value. A manual event can start configured subscriptions and wake an explicitly matching wait, but it cannot bypass workflow/activity authorization.

Webhook ingress uses a Workflows-owned binding to one registered descriptor and one fixed organization/project/resource scope. The binding names a service principal and stores only its identity reference, never another credential. A callback sends the existing `Authorization: Bearer svc_…` credential: HTTP authenticates it through the existing Identity session port (`runtime.identitySessions.authenticate` → `identity.authenticateCredential`), then invokes a dedicated ingress runtime command with that authenticated principal. The control plane requires the principal to be a service principal whose ID matches the binding, rechecks it is active, and authorizes the bound project through the current Organizations membership/permission path before calling `acceptEvent`. Service-principal credential digest, expiry, rotation, and revocation remain Identity-owned; membership and project authority remain Organizations-owned. Reject cookie-only authentication on the webhook route. A body field named `organizationId`, `projectId`, `principal`, `correlation`, or `causation` is never authoritative. The field map reads only declared source fields, and Convoy assigns source identity/correlation/causation from the binding and validated mapping. Failed authentication, principal mismatch, revoked binding/principal, invalid payload, cross-tenant scope, and stale credentials fail closed before journal mutation.

## Durable schedules

Schedules are revisioned Workflow-owned event subscriptions, not process-local timers. Support two explicit forms initially:

```ts
type Schedule =
  | { kind: 'interval'; everySeconds: number; anchorAt: string }
  | { kind: 'calendar'; frequency: 'daily' | 'weekly' | 'monthly'; localTime: string;
      timeZone: string; weekday?: number; dayOfMonth?: number };
type MissedFirePolicy = 'skip' | 'coalesce_once' | { catchUp: { maxFirings: number } };
```

Validate interval bounds and UTC anchor; validate `timeZone` against the runtime's IANA database; validate calendar fields by frequency and use only day 1–28 for monthly schedules to avoid invalid dates. Resolve each local occurrence to a persisted UTC `scheduledFor`. Define deterministic daylight-saving behavior: skip nonexistent local times and choose the earlier instant for an ambiguous repeated time. Persist `(scheduleId, revision, scheduledFor)` as the firing identity before routing, along with `nextFireAt` and missed-fire cursor, so restart or a worker race cannot fire twice. Editing a schedule creates a new revision and leaves prior firing decisions inspectable.

`skip` records missed slots and advances to the next future slot. `coalesce_once` emits one event for all missed slots and records the covered range. `catchUp` emits at most the configured bounded number of individual due slots per scheduler pass; any remaining slots are handled by the same bounded policy on later passes. Never create an unbounded burst or silently change policy after restart. Due records, trigger decisions, and cursor advancement must commit atomically or be safely replayable by firing identity.

Wait deadlines use the same durable scheduler with one-shot timer identities tied to `(runId, workflowVersion, nodeId, attemptInstance)`. A timeout and an event arriving at the same boundary are serialized; the first committed terminal transition wins and the losing delivery is recorded stale. Restart restores due timers and schedule cursors from persisted state rather than recreating wall-clock delays in memory.

## Correlated waits and early-event buffer

A wait definition pins the event descriptor revision, project/resource scope, optional typed predicate, correlation expression, and optional timeout/missed-timeout outcome. Correlation is an explicit exact `(key, value)` pair sourced from the run's start event/input, a prior typed activity output, or a descriptor-advertised event field. Do not infer it from ticket/work type/status strings. A wait instance is keyed by `(runId, workflowVersion, nodeId, attemptInstance)` and persists its scope, correlation, predicate, event cursor, deadline, and status before the engine yields. Its eligibility cursor comes from the run start or the relevant producing attempt's persisted start/dispatch point, before an external activity can emit the awaited event. It must not begin only at wait activation, or a fast callback can be lost or incorrectly treated as stale.

The bounded event journal keeps accepted envelopes for a configured retention window and count/byte cap, indexed by descriptor, tenant scope, and correlation. On wait registration, Workflow checks both new deliveries and retained envelopes since the wait's persisted eligibility cursor, closing the race where a correlated event arrives just before the wait becomes visible to the router. Match exact tenant/resource scope, descriptor revision compatibility, correlation, predicate, and eligible time; then atomically store the event identity and advance the exact attempt. Duplicate delivery is a no-op. Unrelated correlations, other tenants, expired journal entries, and stale attempts do not resume the run. Journal expiry records the high-water cursor so an old event cannot be mistaken for a missing new one.

The eligibility cursor is set from the relevant event-producing attempt before dispatch (or from the run start for an externally correlated run), not when a delayed router registers its index or when the wait activates. `receivedAt` and the durable cursor bound early matching; untrusted `occurredAt` cannot extend the buffer window. If required early evidence has expired before indexing, fail/hold the wait as unavailable with an inspectable decision rather than silently continue.

## Start decisions, concurrency, and causal bounds

An automation subscription pins a descriptor revision, bounded predicate, authorized scope, principal, workflow revision or one-action selection, and explicit concurrency policy. Every decision key includes event identity and rule revision. Persist `started`, `held`, `rejected/conflict`, or `failed` before acknowledging routing; explicit retry refers to the exact decision and cannot alter the original event or pinned rule/workflow revision.

Support three explicit policies: `reject` records a conflict when the configured scope is already at capacity; `hold` records a durable hold requiring explicit retry and never starts automatically later; `independent` permits another run for each distinct event up to a configured per-subscription maximum, after which its declared overflow policy is applied. Concurrency scope is the subscription's explicitly selected scope. Never infer a one-run-per-ticket lock from event payload, board, or work type. A successful decision creates a WorkflowRun through the existing start interface and records the governed principal and exact workflow/activity pin.

Keep the existing one-action automation option by translating it into a one-node pinned WorkflowRun using the PR 4 registered activity and normal attempt/effect pipeline. It shares start authorization, dedupe, run history, cancellation, uncertainty, and retries with graph workflows; it does not dispatch through a second action executor. Existing `start_workflow` subscriptions retain their pinned definition semantics.

Carry `rootEventId`, causal depth, and the bounded chain of event/run references through effects that emit further events. Reject already-seen causal `(ruleRevision, event identity)` pairs and stop routing when the configured maximum depth or per-root event count is reached. Record the bounded-cascade decision for inspection. Causation metadata is assigned by Convoy's effect coordinator, not accepted from manual/webhook callers.

## Unrelated examples

1. **Inventory reconciliation:** a durable daily schedule in an explicit IANA time zone starts a no-agent workflow that calls a registered inventory snapshot activity, transforms bounded typed outputs, and records a result. It needs no chat session, repository, or runner. Restart and missed-fire behavior must preserve its scheduled-slot identity.
2. **Publication callback:** an authenticated publication provider webhook maps a provider request ID and publication state into an event scoped to its configured connection/project. A correlated wait on that provider request resumes only the matching publication run. The body cannot select a Convoy tenant, principal, workflow, or run.

Also run an existing ticket event workflow using a legacy `ticket_updated` rule to prove the compatibility alias and existing Work fact remain correct. Keep inventory and publication descriptors, payload names, outcome policy, and callback semantics out of core defaults.

## Focused runtime test plan

- Descriptor/contract: reject unknown descriptor revisions, malformed payload paths/types, excessive depth/bytes, bad enum values, undeclared predicate paths/operators, and same source identity with a different digest. Assert accepted envelopes are immutable, tenant-scoped, bounded, and deduped.
- Work compatibility: create/update/move/import/message through canonical Work commands; verify each fact's stable source ID, payload, rule alias, idempotent redelivery, and source/outbox recovery. Assert no event can forge Work state or tenant scope.
- Manual/webhook authorization: accept an authorized manual event; reject missing project access, inactive membership, unknown permission, invalid credential, revoked binding, replay mismatch, spoofed organization/project/principal/correlation/causation, and oversized body. Assert failed ingress does not create a trigger decision or wake a run.
- Scheduling: exercise interval and daily/weekly/monthly timezone calculation, daylight-saving gap/overlap behavior, all missed-fire policies, edit/new revision, duplicate scheduler workers, restart after firing persistence but before dispatch, and timer/event deadline races.
- Waits: publish a correlated event just before registration and after registration; verify the retained event wakes only the exact run/attempt, duplicates are harmless, different correlation/tenant/predicate do not wake, timeout persists through restart, and late/stale delivery fails closed.
- Start policy and causation: for each reject/hold/independent mode verify event+rule idempotency, explicit hold retry, bounded active count, no inferred ticket lock, same-engine one-action run, repeated-event suppression, and depth/count cascade termination.
- Acceptance: use the inventory and publication examples through the actual public runtime, plus an existing legacy ticket event workflow. Inspect durable run/attempt/decision snapshots and restart the scheduler/router in tests so persistence behavior is exercised, not inferred from a unit helper.
- Run architecture, build, focused workflow module/acceptance tests, and integrated full suite as required by the series; report baseline/environment failures without weakening checks.

## Integration order

After reviewed PR 3 and PR 4 heads are available, reconcile the event source/attempt identities with their contracts. Add descriptor/envelope and subscription/wait/schedule contracts first; add Workflow-owned journal, subscription decision, and wait transition ports next; wire Work facts, manual/webhook adapters, and durable scheduler through the control plane; then exercise both examples and compatibility through the actual runtime. Keep HTTP as translation, source authentication in the appropriate adapter, and all graph transitions in Workflows.

## Integration seams verified against PR 3

The current durable-run baseline is `ebca318c8f330176fa21d1780a06960e3aec9986` on
`pr/automation-independent-runs`. PR 4 is not present in this checkout yet, so activity
attempt and resource-output names below remain provisional until that head is reviewed.

- `apps/daemon/src/modules/workflows/workflow-module.mjs` is the owner seam. Public
  `createWorkflows()` currently exposes `startRun({ projectId, organizationId, principal,
  workflow, activeTicketId })`, exact run lookup/DTO through `run()`/`readRun()`, and
  governed run controls. Extend that owner API with `acceptEvent` and subscription/schedule
  lifecycle policy; do not create runs by editing `state.workflowRuns` in the control plane.
  A matched start should call the same pinned run/engine path and persist event/rule identity
  as run provenance. `createWorkflowEngine.signal(context, instance, fact)` is the narrow
  transition seam, but it currently checks only the legacy event name and callers iterate
  sessions; PR 5 must make registration, correlation, scope, predicate, cursor, and attempt
  identity Workflow-owned and support independent runs without creating a session.
- `runtime.mjs` currently owns `startWorkflowRun`, `getWorkflowRun`, claim, decision,
  continue, cancel, and reconcile dispatch. `runtime-command-validation.mjs`,
  `packages/contracts/src/commands.ts`, `modules/workflows/index.mjs`, and
  `module-command-registry.mjs` are the required public command/owner parity seams.
  Add manual event submission and schedule/subscription commands only after deciding which
  are public user operations. HTTP must pass the authenticated principal into these commands;
  event delivery then rechecks the stored rule principal before it starts any activity.
  `workflow-module.snapshot()` already scopes the bounded run DTO; new decisions and event
  inspection must follow that stored organization/project scope and must not publish secrets
  or unbounded envelopes.
- Work's current durable fact queues are `state.workFacts` and `state.ticketImportFacts`,
  initialized by `modules/work/catalog.mjs`. Column changes key facts by ticket revision and
  board; import/source/thread facts have stable binding/remote-version or thread/message
  identities. Import facts can remain `awaiting_thread` until the source thread establishes
  a complete baseline. `workflow-effects.mjs` drains these queues, calls Workflows, saves,
  and removes observed records. Preserve these as Work-owned outbox facts; acknowledge/remove
  only after Workflow `acceptEvent` durably accepts the stable source identity. A crash between
  acceptance and Work acknowledgement must be a harmless deduplicated redelivery.
- `workflow-effects.mjs` also synthesizes ticket create/update/placement facts after canonical
  Work commands and currently owns automation candidate matching, `automationDecisionLedger`,
  retry identity, and failure records. Move matching and durable start decisions into
  Workflows; leave this coordinator responsible for authorizing the saved rule principal,
  delivering owner calls, and draining Work outbox facts. There is a global `consumedByWait`
  early return that suppresses automation matching when a wait receives a fact. Remove that
  behavior: event subscribers are independent. Also replace the `workflowRunId` suppression
  of action-generated events (including `recordColumnFacts` in Work) with bounded causation
  metadata and loop protection, otherwise a workflow action cannot trigger another declared
  subscription and violates the shared-envelope rule.
- Wait delivery currently scans only `state.sessions`, while PR 3 permits independent runs
  without `sessionId`. The run's pinned flow is authoritative and may have a compatibility
  session projection after an agent node. Route to canonical run ID/version/node/instance and
  then use the engine transition; never enumerate or mutate a second session-owned wait copy.
- The only daemon scheduling loop is the serialized 3-second `dispatchTimer` in
  `control-plane/runtime.mjs`, which polls ticket imports then dispatches ready activities.
  No durable workflow timer, schedule cursor, event journal, or due-fire record exists yet.
  Extend this serialized tick to call a bounded Workflows due processor and persist each
  schedule/timer firing identity before delivery. Derive missed-fire recovery from durable
  UTC cursors, not an in-memory timeout. Tests should reopen the runtime with the same state
  and advance the injected clock/tick seam.
- `http/app.mjs` currently accepts authenticated JSON at `/api/runtime`; its global host,
  origin, content-type, and Convoy-identity gates run before body dispatch. It has no webhook
  route or webhook credential binding. A provider callback therefore needs a dedicated
  explicit route/adapter path that authenticates its configured binding credential and fixed
  scope without treating callback JSON as a Convoy user command. Keep ordinary runtime routes
  and their authentication/CSRF policy unchanged. No generic inbound webhook binding or
  credential lifecycle exists in the adapters today.

## Decisions to settle against PR 4 before implementation

1. **Journal ownership:** settled with root. Workflows owns the accepted journal, dedupe,
   subscription decisions, and wait state through `acceptEvent`; control plane authenticates,
   authorizes, and coordinates source/outbox delivery. Work's pending fact outbox remains
   separately owned by Work.
2. **Subscription compatibility:** `AutomationRule` currently pins one of seven string event
   IDs, equality-only `if` conditions, and a `start_workflow` target. New descriptor revision,
   typed predicates, start action selection, and concurrency policy need an additive schema
   revision/migration path that preserves old rule IDs/revisions and `automationDecisionLedger`
   retry keys. Keep each legacy event string as a resolver alias, not as a second event path.
3. **Webhook source configuration:** resolved direction from root: Workflow owns a binding
   that pins descriptor revision, organization/project/resource, service-principal ID, and
   bounded declared-field map. Use the existing Identity service-principal bearer credential
   lifecycle and current Organizations authority; do not create a secret store or reuse
   outbound ticket-source connections. Public binding save/revoke commands still need to be
   defined, with secret-free projections and current principal/project authorization.
4. **Event-start authorization and provenance:** current public `startWorkflowRun` authorizes
   `project.execute`; current automated starts use the rule's saved principal and an
   authorization callback. Specify the permission required to submit manual events and how
   event-started runs retain `eventId`, rule ID/revision, exact workflow/activity pin, and
   original principal. Caller-supplied tenant, actor, source ID, revision, correlation, and
   causation must remain ignored or rejected.
5. **PR 4 activity output contract:** waits may correlate from a start event or typed activity
   output. Reconcile the exact event eligibility cursor and output reference with PR 4's
   durable attempt/effect receipt before defining wait persistence; do not infer cursor from
   wait activation time. Keep schedule/event routing independent of session/runner allocation.

There is no need to change PR 3 code to prepare these seams. These notes should be reconciled
with the reviewed PR 4 public interfaces before contracts are frozen or implementation begins.

## Existing authentication/authority port audit

The PR 3 composition already supplies the needed principal and tenant checks for this direction:

- `Identity.authenticateCredential()` accepts existing `svc_` service-principal credentials,
  verifies the stored digest, active state, and expiry, and returns the normalized
  `{ kind: 'service-principal', servicePrincipalId }`. Rotation replaces the digest; revocation
  and expiry make bearer authentication fail. `runtime.identitySessions.authenticate()` is the
  public HTTP port to this logic. Do not compare or persist raw bearer values.
- `http/identity-session.mjs` already extracts `Authorization: Bearer ...` and marks its source.
  The webhook route can use that current authentication before parsing/dispatching the event,
  but must require `source === 'bearer'` and a service-principal principal for the binding; do
  not let the existing cookie fallback authenticate callbacks.
- Organizations exports `resolveContext()` and `authorize()` through its public module index;
  runtime's current `requireProjectPermission(projectId, permission, principal)` resolves the
  project's stored organization/team context and recomputes membership and project authority.
  Keep that authorization inside the control-plane ingress command, not HTTP or adapter code.
  Require the authenticated service-principal ID to exactly equal the binding's principal ID,
  then check `project.execute` (or a descriptor-declared narrower permission if PR4 review
  establishes one) for the binding's fixed project. Service-principal roles are already limited
  to organization member and named-project contributor/maintainer; no org admin/team grant.
- Therefore there is no blocker in the existing Identity/Organizations authority path and no
  new secret store is needed. The missing seam is a Workflow-owned binding schema/lifecycle plus
  a dedicated HTTP route and runtime ingress command. Existing `http/app.mjs` applies host and
  optional-origin checks, JSON framing, and a bounded body read before `/api/runtime`; preserve
  those checks, use a descriptor-bound smaller payload limit, and do not let the webhook route
  bypass authenticated runtime principal propagation.
