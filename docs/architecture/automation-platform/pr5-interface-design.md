# PR 5 implementation proposal — registered events and correlated waits

PR 5 adds event sources around the PR 3 durable WorkflowRun and PR 4 registered activity-attempt engine. Workflow definitions and rules remain owned by Workflows. Work retains ticket and board facts. Source-specific integrations translate their protocols into validated event envelopes. The control plane authorizes, durably journals, deduplicates, and routes envelopes to automation subscriptions and active waits. Event delivery starts or resumes the existing WorkflowRun engine; it does not add another executor.

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

Webhook ingress is an adapter binding to one registered descriptor and one fixed organization/project/resource scope. The adapter authenticates the configured connection credential, validates request size and replay/idempotency key, maps only declared source fields, and strips/rejects reserved routing fields. The control plane resolves the workload identity and scope from the binding and rechecks it is active before calling `acceptEvent`. A body field named `organizationId`, `projectId`, `principal`, `correlation`, or `causation` is never authoritative. Secrets remain in the adapter credential store and never enter event payloads, snapshots, or error text. Failed authentication, revoked binding, invalid payload, cross-tenant scope, and stale credentials fail closed before journal mutation.

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
