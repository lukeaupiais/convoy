# PR 7 interface design — child runs and bounded composition

Status: proposal only; implementation waits for the reviewed PR 3–6 integration head.

## Owner and execution model

The Workflows module continues to own immutable graph definitions, WorkflowRuns, ActivityAttempts, durable effect intent/evidence, and deterministic progress. Child, fork, join, and map state are fields on those same owner records. They do not create a parallel scheduler, run table, or mutable coordinator ledger. The control plane admits and schedules ready attempts, checks current authorization and grants, acquires each attempt's declared resources, and invokes the same activity interface established by PR4. Workflows receives owner commands to record intent, dispatch outcome, reconciliation, cancellation, and join decisions.

Each active attempt has a stable identity derived at creation and retained for its full lifetime: `attemptId`, parent `runId`, composition node ID, branch/item key, exact workflow/activity revision, input digest, and status. A composite attempt additionally records its policy, start/deadline, child run/attempt IDs, output map, cancellation requests, and join decision. A run snapshot exposes bounded active-attempt summaries and terminal history. Existing scalar `Session.flow`/linear projections are derived from the sole WorkflowRun owner; they can point to one representative active attempt but cannot claim that parallel work completed when sibling work remains active.

Child workflows are separate WorkflowRuns with explicit `parentRunId`, `parentAttemptId`, and child slot identity. The parent pins an exact child workflow ID/version and exact input/output schemas/mappings. Parent and child use the same engine, activity registry, attempt lifecycle, resource resolution, and restart/reconciliation rules. A child cannot select a newer workflow or capability profile at dispatch. An unavailable pinned child revision blocks with its identity visible.

The control plane passes current governed identity and the same organization/project as the parent. This initial composition contract permits only same-project child runs; it does not add a narrower-project grant concept. Cross-organization or cross-project selection is rejected at publication where statically apparent and again at dispatch. A descriptor, parent pin, or inherited principal is not authorization: check current membership/grants on child start, every activity dispatch, and reconciliation. Parent cancellation cannot cancel outside its own descendant IDs.

## Composition node shapes

Extend the WorkflowDefinition with structured composite nodes and reuse PR4's pinned activity refs, JSON schema subset, and `ValueBinding` vocabulary. Illustrative contracts:

```ts
type ChildCall = {
  kind: 'child';
  workflow: { id: string; version: number };
  input: Record<string, ValueBinding>;
  output: Record<string, { from: string[]; to: string[] }>; // from the child's declared terminal result
};

type Parallel = {
  kind: 'parallel';
  join: 'all' | 'first_success';
  branches: Array<{
    id: string;
    workflow: { id: string; version: number };
    input: Record<string, ValueBinding>;
    output: Record<string, { from: string[]; to: string[] }>;
  }>;
  limits: { maxConcurrent: number; deadlineMs: number };
  compensations?: Array<PinnedCompensation>;
};

type MapChild = {
  kind: 'map';
  items: ValueBinding;
  maxItems: number;
  maxConcurrent: number;
  deadlineMs: number;
  workflow: { id: string; version: number };
  itemInput: Record<string, ValueBinding>;
  itemOutput: Record<string, { from: string[]; to: string[] }>;
};

type WorkflowResultContract = {
  schema: JsonSchemaSubset;
  bySuccessfulTerminalNode: Record<string, Record<string, ValueBinding>>;
};
```

`WorkflowDefinition` pins a `WorkflowResultContract` with its version. Each successful terminal node maps declared, completed outputs/submission fields into this schema; a successful WorkflowRun stores only that validated terminal result. Child, branch, and map mappings read paths from the child's result, never from an arbitrary last activity attempt. The exact same result contract is pinned in each child reference and checked again at dispatch. A legacy graph without this contract remains valid as a top-level run, but must be explicitly published with a result contract before another workflow can call it as a child.

These are shapes for the Workflows definition/attempt model, not commands that execute outside the owner. A `child` node has one child slot. A `parallel` node has a finite declared set of independently pinned branch workflow versions and one join rule. A `map` node pins one child workflow revision and produces one output entry per input index. `itemInput` may refer only to that map item's value/index and to completed upstream outputs; it may not reach into another item or a sibling run. The final contract should reuse the exact field names/types from reviewed PR4 and PR6 instead of creating duplicate schemas or approval models.

Publish-time validation checks child schemas and all literal/input/output mappings, child workflow scope, branch IDs, bounded collection and concurrency limits, deadlines against policy ceilings, and explicit compensation pins. References may originate on optional graph paths only when they can precede the composition node; at runtime, an unexecuted or incomplete source blocks before child dispatch. Each child-callable WorkflowDefinition declares an input schema and a result schema. Its published version pins both. It declares an exact terminal-result mapping for every successful terminal node, with each mapped source bound to completed activity output/submission data and validated against `resultSchema`. A successful WorkflowRun stores this mapped terminal result; parent child-call, branch, and map output mappings read only from that result schema, never from an arbitrary last activity attempt. Child output mapping validates every path against the pinned result schema and never copies undeclared child state, artifacts, secrets, or internal attempt material. A legacy graph without an explicit result contract remains valid as a top-level run but is not selectable as a child until an explicit version supplies one.

## Join, map, and failure semantics

`all` starts eligible branches up to `maxConcurrent`. It succeeds only when every branch succeeds and its declared output validates. A failed or cancelled branch makes the composite unable to succeed, but the parent does not finish while sibling effects are active or uncertain. It requests cancellation from remaining descendants, waits for confirmation/reconciliation, then records the final failed/cancelled outcome and configured compensations. A branch output is never substituted for another branch's output.

`first_success` chooses the first branch whose WorkflowRun reaches successful terminal state with a valid mapped output. Persist that choice atomically in the Workflows owner before canceling queued/running losers. Use a stable tie-break when completions are observed in the same owner transaction (event sequence, then declared branch order). The parent cannot advance while started losers are still active, `waiting`, or `uncertain`; cancellation is not evidence that an external effect did not apply. Reconcile every possibly dispatched effect before the composite closes. No new loser branch starts after a winner is recorded.

Map validates the complete array and rejects `length > maxItems` before creating any child run. It assigns stable slots `0..n-1` and stores each item's input digest. Results preserve input order regardless of completion order. Queued slots count against the total descendant/item/run budget, but do not consume active-concurrency capacity. `maxConcurrent` is measured over started children with actual active resource reservations; completion or release of those reservations frees capacity for the next queued item. A started waiting or uncertain attempt counts against only the resource and budget reservations it still holds under policy. This separation lets a map queue more items than its concurrency limit without deadlocking. Any item failure follows an explicit map policy in the pinned definition: fail-fast (stop launching, cancel active siblings, then wait/reconcile) or collect-errors (record a tagged per-item error and return only if the declared output schema permits it). Do not infer a policy from an activity name. Unknown effects block dependent completion in either mode.

A persisted absolute deadline bounds a composite and all its descendants. At deadline, stop launching queued work and request cancellation from active work. The deadline does not erase uncertain attempts or auto-retry them. Restart compares the stored deadline to current time, marks lost in-flight pure work retryable only if its pinned contract permits deterministic recomputation, and marks dispatched durable effects uncertain under PR4 rules. Completed child runs and item outputs remain attached to their original slots and are never recreated. Callback/event duplication is absorbed by `(parentAttemptId, childRunId, childSlot, childAttemptId)` identity.

## Concurrency, scope, and budget

Admission composes the applicable organization, project/workflow, and parent-run ceilings through the owning policy seam, then rechecks current authorization/resource grants before each dispatch and reconciliation. If PR 3–6 do not supply the applicable concurrency/budget query, add a narrow injected resolver owned by the policy domain; do not make the coordinator infer or broaden limits. Persist admitted ceilings and auditable reservation/consumption with the WorkflowRun owner. Every child, branch, and mapped item shares the parent's composition budget identity.

Count every queued slot against the total descendant/item/run budget, but do not count queued slots against active concurrency. Count started active, waiting, and uncertain attempts against active concurrency and budget according to the resources/reservations they actually hold under policy; a waiting external event may release a runner slot, while an uncertain write retains its effect and budget reservation until reconciled. Reserve before dispatch, settle or release only on an authoritative terminal outcome, and retain reservations for uncertain effects until reconciled. The scheduler may start queued work when capacity becomes available; this distinction prevents a queue larger than `maxConcurrent` from deadlocking. A restart must not make an in-flight write free or available for duplicate dispatch. Per-run limits include maximum descendant count, maximum active attempts, map-item cap, and absolute deadline. Organization/project concurrency limits apply across runs, not only within one fork. Any monetary/provider/runner budget field must use the existing governed resource vocabulary if one exists; this design does not create a second execution grant or expose credentials.

Concurrent children may not attach to the same mutable Agent session. A branch can create its own lazily allocated session or request serialized reuse only when existing Conversations lease semantics prove that no overlap can occur. If the same session ID is already leased by another descendant, reject the concurrent start or queue it until the lease releases; do not share context or bypass its lease. Publish rejects statically detectable conflicting reuse in a parallel declaration, and dispatch performs the authoritative lease check.

## Compensation and cancellation

Compensation is an explicit list of pinned registered activities, input mappings, and run conditions stored in the published graph. Convoy never invents rollback from an activity descriptor or command name. A compensation has its own ActivityAttempt, authorization/grant check, budget reservation, stable effect identity, and reconciliation path. It runs only when the configured failure/cancellation route requests it, after relevant child effects are known; it does not silently rewrite the original activity result. If a compensation is unavailable, unauthorized, or uncertain, the parent remains blocked with both forward and compensating attempt evidence visible.

Parent cancellation records a durable request and propagates it to queued and active descendants. Queued work becomes cancelled without dispatch. Active pure/runner/agent work follows that activity's declared cooperative cancellation. Dispatched durable effects remain waiting or uncertain until confirmation/reconciliation establishes their outcome. Cancellation of a parent/parallel group is complete only when every descendant is terminal or explicitly left blocked for human reconciliation; the run cannot report a clean cancelled terminal state while a write may still have applied. Child-originated failure is recorded once, then join policy controls sibling cancellation and parent progression.

## Two configured examples

**Procurement review:** a run receives `{vendor: {name, country, quotedAmount}}`. A fork starts two no-agent child workflows pinned to exact versions: a compliance assessment and a cost comparison. Each receives only the vendor object and returns a schema-checked assessment. `all` joins both results for a human decision. This allocates no model provider, repository, runner, or session. If a reviewer rejects the quote, an explicitly configured Work activity may create a follow-up ticket; the composition layer does not assume a procurement board, ticket type, or status.

**Document processing:** a run receives a bounded array of document references. A map starts at most four children from one pinned extraction workflow, at most twenty items, and under a stored deadline. The child may use a no-agent registered parser for ordinary documents and an optional agent activity only where that child graph explicitly routes to it. Outputs stay ordered by input index and validate as `{documentId, fields, confidence}`. A separate deployment can use different schemas and workflow versions with no procurement-specific defaults.

## Compatibility and migration

Existing linear definitions keep their exact published bytes/approval identity and continue through the PR4–6 compatibility decoder. They need no synthetic child or parallel wrapper. Their scalar flow projection remains derived from their WorkflowRun and active ActivityAttempt. Top-level use does not require a result schema; child-callable versions do, and the terminal mapping is explicit and pinned.

Composition migration, if any PR 3–6 draft has already persisted a composite experiment, must preserve parent/child run IDs, attempt IDs, branch/item slots, child definition/version pins, input/output digests, effect evidence keys, lease references, deadlines, decisions, and compensation attempts. Ambiguous started writes migrate as uncertain. Normal linear state does not migrate into new composite records, and upgrading the engine never edits a live deployment's `.convoy` data manually. Validate migrations on disposable fixtures and run them twice to prove idempotence.

## Runtime test plan

Workflow module tests should cover exact child revision/input/output pins; type/schema and graph-provenance validation; stable child/branch/item identities; `all`/`first_success` state transitions and tie-breaking; map ordering and oversize rejection; deadline and concurrency accounting; compensation identity; cancellation propagation; lease-conflict rejection; and migration/read-projection identity preservation.

Acceptance tests should enter through the production runtime/bootstrap facade:

- procurement example: start both no-agent children, join both typed outputs, make the human decision, and assert zero provider/session/runner/workspace allocation;
- document example: map several items with a concurrency cap, include one optional agent route, preserve ordered outputs, and prove the declared item cap rejects before any child starts;
- mutate/publish a newer child workflow after the parent is published and prove every child still uses its pinned version;
- suspend/restart with one completed write, one queued branch, and one write whose adapter applied then lost its response; prove no duplicate dispatch, durable uncertain join, and explicit reconciliation;
- verify `all` failure cancellation and `first_success` winner/loser behavior, including a late loser result and unresolved side effect;
- cancel parent during agent/runner work and during an external effect; verify leases and cancellation signals propagate and the parent waits for terminal or reconciliation evidence;
- reject cross-tenant/project child calls and two concurrent children reusing one agent session lease;
- enforce run/org/project active-attempt and budget ceilings across two concurrent parent runs; uncertain attempts retain reservations;
- execute a configured compensation exactly once after its explicit trigger and reconcile an uncertain compensation;
- regress existing linear runner and human workflows plus legacy Session.flow snapshots.

Run focused Workflow module and composition acceptance groups, architecture check, and build on the reviewed PR 3–6 stack. Full-suite validation belongs to integration review. As part of final delivery, update the root README, architecture overview, and domain language to describe only generic automation capabilities that these reviewed tests prove; identify agent sessions and repository runners as optional resources and preserve Linux/runner prerequisites. Do not advertise unimplemented future capabilities. Do not implement this proposal on the plan-only checkout.
