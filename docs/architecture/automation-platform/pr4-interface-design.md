# PR 4 interface design — activities and typed data

Status: proposal for review against the PR 3 head. No application code is changed by this document.

## Boundary and owner

`workflows` remains the owner of immutable workflow definitions, WorkflowRuns, typed input/output references, deterministic transitions, ActivityAttempt lifecycle, and the durable intent/effect evidence attached to each attempt. It owns the public descriptor projection and validates that every published activity reference resolves to an exact registered revision. It does not call a provider, runner, Work command, or integration protocol. The coordinator may orchestrate dispatch and report results, but must not maintain a second mutable attempt or effect ledger.

The control plane resolves the active activity's resource requirements, selects the registered implementation, and coordinates completion, confirmation, cancellation, and reconciliation through Workflows owner commands. Resolution happens when the activity becomes active. It must not gather requirements from later graph nodes at run start. Before every dispatch and reconciliation, the coordinator rechecks the current principal's authorization and current required grants; a descriptor is metadata and never grants authority. It calls Work and other daemon domains through their actual public indexes and injected command APIs, preserving organization/project scope, canonical command authorization, and the Work module's normal validation and idempotency. It does not duplicate their policy.

Built-in implementations are statically assembled and injected by bootstrap. A registry entry is trusted application code paired with a data-only descriptor; workflow documents cannot load code, choose arbitrary modules, or add runtime plugins. The registry can resolve only `(id, revision)` pairs that bootstrap registered. A missing revision remains in read models as unavailable and fails closed on publish/dispatch. It never falls forward to a newer revision.

`packages/contracts` defines the descriptor, binding, run-data, and attempt wire shapes only. `apps/web` consumes the authorized descriptor projection and owns its activity picker and typed-input editor. Execution continues to own runner/provider grants and Library continues to own reviewed capabilities; a descriptor may declare needs but cannot mint a grant.

## Descriptor and implementation port

Proposed shared contract (names illustrative until reconciled with PR 3):

```ts
type ActivityRef = { id: string; revision: number };
type ResourceRequirements =
  | { location: 'daemon'; provider?: never; runner?: never; workspace?: never }
  | { location: 'agent'; provider: 'required'; tools?: string[]; workspace?: boolean }
  | { location: 'runner'; runner: 'required'; workspace?: boolean }
  | { location: 'integration'; adapterId: string };

type ActivityDescriptor = {
  ref: ActivityRef;
  inputSchema: JsonSchemaSubset;
  outputSchema: JsonSchemaSubset;
  resources: ResourceRequirements;
  effect: 'pure' | 'durable-effect';
  approval: { required: boolean; policy?: 'workflow-gate' | 'command-policy' };
  cancellation: 'immediate' | 'cooperative' | 'reconcile-after-dispatch';
  confirmation: 'result' | 'adapter-confirmed' | 'human-reconciled';
  reconciliation: 'none' | 'adapter';
  presentation: { label: string; description?: string; group?: string };
};

type ActivityImplementation = {
  ref: ActivityRef;
  prepare(input, identity): Promise<SerializableIntent>; // pure; called before durable save
  dispatch(context, input, intent, signal): Promise<
    | { state: 'completed'; output: JsonValue }
    | { state: 'waiting'; reason: string; output?: JsonValue }
  >;
  cancel?(context, intent, signal): Promise<'cancelled' | 'uncertain' | 'waiting'>;
  confirm?(context, intent): Promise<'confirmed' | 'waiting' | 'uncertain'>;
  reconcile?(context, intent, resolution): Promise<
    | { state: 'applied'; output: JsonValue }
    | { state: 'not_applied' }
    | { state: 'unknown' }
  >;
};
```

The implementation is injected under the exact descriptor ref. `prepare` may validate/normalize and construct a command or request identity, but must not make an external change. The control plane asks the Workflows owner to persist the attempt ID, exact activity ref, validated input identity/digest, prepared intent, scope/principal identity, and stable idempotency key before dispatch. The intent stores only bounded, serializable data needed to recover or reconcile; it excludes credentials and secret values. All returned output is passed back to the Workflows owner for validation and recording before it can be bound downstream.

An implementation that declares `effect: 'pure'` must be deterministic for its pinned revision and input. It needs no effect reconciliation; a crash may recompute it, then validate and persist the output. A `durable-effect` must use its intent and have a declared confirmation/reconciliation policy. After a dispatch may have reached an external system, transport loss, timeout, process exit, or failed confirmation leaves the attempt `uncertain` or `waiting`; it never proves non-application. No uncertain effect is automatically dispatched again. Adapter reconciliation can establish `applied`, `not_applied`, or still `unknown`; only an explicit, authorized resolution can release an uncertain attempt.

The concrete internal port should be small: `describe(ref)`, `prepare(ref, input, identity)`, `dispatch(ref, context, input, intent, signal)`, and optional `cancel`, `confirm`, and `reconcile`. Registry storage and schema validation stay in Workflows; protocol and resource acquisition stay in injected control-plane/adapter code. Avoid a generic middleware/plugin manager.

## Schema, pins, and data bindings

Published nodes pin `activity: {id, revision}`. A workflow definition also declares a JSON object schema for `runInput`; its published workflow version pins that schema. A WorkflowRun stores a cloned, validated input value (bounded by existing command/state limits) and `runInputDigest`. Each completed attempt stores the exact output value, `outputDigest`, and the same activity ref as its node. History/read models may show bounded values only when the descriptor permits it; credentials and secret-bearing configuration never enter run input/output snapshots.

Use a deliberately bounded JSON Schema subset implemented at the owning validation boundary: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, and scalar/array length or numeric bounds. Limit schema depth, schema bytes, object keys, list length, and serialized values. Reject unknown keywords and external or recursive `$ref`. This supports object, string, number/integer, boolean, null, and arrays without code execution or a new expression engine. Publication validates node bindings against the pinned input and output schemas; dispatch validates resolved values again; completion validates output again.

Bindings are data, not expressions. Proposed shape:

```ts
type ValueBinding =
  | { literal: JsonValue }
  | { from: { kind: 'run_input'; path: string[] } }
  | { from: { kind: 'activity_output'; nodeId: string; path: string[] } };
type ActivityBindings = Record<string, ValueBinding>;
```

Each top-level input property has one binding; nested values may be supplied as a literal object or array. Reference paths are non-empty string segments checked against the source schema. Reject `__proto__`, `prototype`, `constructor`, empty segments, inherited-property lookup, undeclared node IDs, forward references, and paths not present in the declared source schema. A prior graph node may be a valid source even if it sits on an optional path, provided graph validation proves it can precede the consumer; at runtime its output is usable only if that node completed in this run. If its path did not execute, or it failed, was cancelled, or lacks the referenced output, fail closed before dispatch. Resolve only own properties. There are no arithmetic expressions, loops, secrets, dynamic lookups, or implicit “last result” references. A missing or invalid bound value blocks before any dispatch and records a useful validation failure.

## Proving one interface against three kinds of work

All action nodes use the same pinned descriptor, validated bindings, durable attempt, output validation, and transition path. Implementations retain domain ownership behind that path:

| Activity | Descriptor/resources | Implementation path | Example output |
| --- | --- | --- | --- |
| `work.create-ticket@1`, `work.create-related-ticket@1`, `work.update-ticket@1`, `work.set-board-placement@1`, `work.set-external-status@1`, `work.post-external-reply@1` | Daemon/Work command; no runner/provider. External reply/status also require the existing configured Work connection and exact approval/evidence policy. | Through the injected `work.command(command, context)` API from `createWork`, use actual command IDs `createTicket`, `createRelatedTicket`, `updateTicket`, `setBoardPlacement`, `setExternalTicketStatus`, and `postExternalTicketReply`; use `syncExternalTicketThread` for current delivery confirmation where required. No direct catalog mutation or illustrative wrapper commands. The adapter maps only declared business inputs and derives actor, scope, and workflow IDs from the governed run. | Typed ticket/message/status result; Work remains authoritative. |
| `data.multiply@1` (or similarly generic deterministic transform) | Daemon, pure; no runner/provider/workspace. | Statically registered pure implementation multiplies declared numeric `amount` and `factor`, validates finite bounded output, and returns `{amount}`. | `{ amount: 42 }` |
| `integration.crm-upsert-contact@1` as an acceptance fake, with an unrelated configured `inventory.lookup@1` fake example | Injected integration adapter; durable effect; no runner/provider unless its descriptor says otherwise. | Fake adapter records `(attemptId, idempotencyKey, request)`, returns a result, can lose its response after applying, and supports lookup/reconciliation by that same identity. Real integrations would each own their external protocol adapter; workflow definitions select only registered IDs. | `{ externalId, updated }` validated against a pinned output schema. |

The CRM and inventory examples use different IDs, schemas, and requirements to prove that selection comes from descriptors and explicit configuration rather than board name, work type, status, or development/support template. `inspect_changes` is not a Work mutation; preserve it as a runner-required activity that acquires a workspace only when it becomes active. Existing check/agent semantics likewise remain distinct registered activity kinds or existing dedicated paths until their own implementation is explicitly converted; no generic action silently inherits `inspect_changes`.

For the Work adapter, retain the current command semantics: create operations carry the run-derived idempotency key; updates and external writes retain their stable request keys; reply delivery remains `waiting` until the canonical confirmation proves delivery; status changes requiring a delivered-reply evidence ID remain blocked until Work confirms that evidence. Preserve session-era `submission`, reply request keys, and command response fields through a versioned compatibility decoder/encoder at the adapter boundary.

## Explicit workflow template selection

A registered template may remain available as a starting point in the workflow library, but availability is not a default. New projects and drafts with no configured project or organization default start without a selected workflow; workflow resolution, “default workflow” read models, and editor initialization consult only explicit `defaultWorkflowIds`. Remove the current “latest workflow” fallback in `createWorkflows.selection` as part of this seam. Choosing Team delivery or another template is an explicit operator action that creates/selects a draft; no generic project silently receives development-oriented actions.

Migration preserves `defaultWorkflowId` by mapping it to the legacy personal organization default only when no explicit organization default is stored, and preserves all existing project/organization default IDs. It does not infer a default from the latest workflow or the presence of the Team delivery template. Active WorkflowRuns keep their exact pinned published definition and are unaffected by the editor's empty new-workflow selection.

## Resource acquisition, approval, and cancellation

The descriptor is an eligibility declaration, not authority. At activation, the control plane asks Execution/Library/provider ownership to resolve only the active activity's declared needs under the run's principal and pinned workflow/capability policy. A daemon transform or Work command needs no runner, model provider, repository workspace, or shell grant. Agent work resolves its provider plus declared tools/workspace; checks and repository inspection resolve runner/workspace. A later runner activity remains unallocated while a previous pure/Work activity executes.

Canonical Work commands keep their normal tenant authorization and validation. Requiring human approval is descriptor and workflow policy data, but approval identity binds to the exact attempt/input digest and any captured submission or evidence. Changing the attempt, input, connection, target, or source submission invalidates the decision. The activity adapter cannot approve itself or supply a broader command principal.

Before dispatch, cancellation can mark the attempt cancelled immediately. During a pure computation or a cooperative runner operation, send the existing cancellation signal and record terminal cancellation only after the implementation confirms it stopped. Once a durable effect may have dispatched, cancellation stops further work but keeps the attempt waiting/uncertain until adapter confirmation or reconciliation; it must not label a potentially applied effect `cancelled` and make it replayable. Restart treats persisted `running` durable effects as uncertain. Local and SSH execution retain the same runner activity contract and cancellation semantics.

## Migration and compatibility

Base the final migration on the reviewed PR 3 state schema. Keep it additive, idempotent, and confined to normal startup/state migration; do not edit a deployment's `.convoy` data. The planned mapping is:

1. Decode each existing `operation` to a permanent built-in ActivityRef at revision 1 at dispatch/read-projection time. Do not rewrite or reserialize the published definition: its exact content and approval identity remain pinned. Preserve `operation` and legacy `input` fields and translate their semantics in the compatibility decoder. Old development/support templates remain ordinary explicit workflow definitions; they do not determine a generic activity default.
2. Preserve workflow IDs, versions, exact serialized definition content, organization/project scope, entry node, edges, approval references, submission fields, action result compatibility fields, and active run identities/instances. If a definition cannot be safely decoded, retain it as inspectable/unavailable and fail closed when activated; never choose a replacement activity.
3. Attach every existing `workflowEffectLedger` row to the owning PR 3 ActivityAttempt/effect state while preserving all legacy effect evidence keys, command/request identities, statuses, results, messages, timestamps, and reply blocking/reconciliation evidence. Map `pending` or ambiguous/in-flight rows to `uncertain`, preserve `succeeded` results, and retain specific blocked reply state. Do not dispatch while migrating. Keep a read-only compatibility projection for old reconciliation commands until clients and stored state are migrated.
4. Convert the legacy `actionResult`/`ticketBindings` values into typed activity outputs only where a known producing node and declared output schema prove the mapping. Otherwise expose them through the compatibility view to old graphs but reject new references to them.
5. Keep current runtime command names and submission fields. New draft/publish commands accept activity refs/bindings; legacy persisted graphs decode through one translator. New writes store canonical fields and may retain legacy mirrors only as derived projections.

After PR 3 is reviewed and integrated, confirm the exact ActivityAttempt/effect APIs and state ownership. Keep the attempt, durable intent, and effect evidence mutable in the Workflows owner only. Do not add a second mutable attempt store or rewrite PR 3 in parallel. Migration tests must load pre-PR4 fixtures and PR3 in-flight run fixtures, run migration twice, and compare byte-for-byte published definition content, workflow/run/attempt IDs, approval references, every old effect evidence key, command idempotency identities, and terminal/uncertain states.

## Test plan

Focused Workflows module coverage:

- descriptor registration rejects duplicate `(id, revision)`, malformed bounds/schemas, dangling activity pins, unavailable revisions, and incompatible bindings;
- type checks for amount/boolean/list input and output; reject undeclared properties, unsafe path segments, prototype keys, missing/forward outputs, oversized values, and schema keyword escapes;
- publish pins descriptor revisions; later registry additions do not alter a saved workflow or active run; absent pinned revisions stay visible and cannot dispatch;
- typed run inputs and prior outputs are immutable per attempt and output only becomes bindable after schema validation succeeds;
- unavailable/missing/invalid bindings create a failed or blocked attempt with no adapter call.
- an unconfigured new project/draft has no implicit workflow selection even when Team delivery is registered; selecting a template is explicit; configured project/organization defaults still resolve; migration preserves stored legacy default IDs and active pinned graphs.

Cross-owner acceptance through the production bootstrap/runtime façade:

- run a graph that calls a canonical Work ticket operation, binds returned ticket ID/title into a later Work operation, and confirms the authoritative Work state; verify stable request IDs and unchanged Work authorization/tenant checks;
- run `data.multiply@1` and a boolean/list-producing pure transform with no provider, runner, workspace, agent session, or repository allocation; bind each typed output downstream;
- run the fake CRM adapter and unrelated inventory adapter through the same dispatch contract; assert distinct descriptors/resources and no action-switch edit is needed to register the second; reject an unavailable pinned revision;
- use an input field with missing/invalid output and show no later activity runs;
- start a mixed graph with a pure activity followed by repository inspection; prove the first completes without resource acquisition and the runner is acquired only for inspection;
- inject cancellation before dispatch, during safe runner work, and after an effect may have applied; exercise adapter-confirmed cancellation and uncertain reconciliation;
- simulate integration applies then drops response, daemon restart, and failed confirmation; assert no duplicate external write, `uncertain`/`waiting` survives restart, and explicit reconciliation alone advances;
- regress approved external replies, stable reply request IDs, delivery confirmation, latest-delivered evidence, existing runner workflows, and PR3 no-agent/agent-session projection behavior;
- migration fixture tests as listed above, plus double-run idempotence and preserved legacy command responses.

Run architecture check, build, focused workflow module tests, and the targeted acceptance groups from the PR series. Do not start implementation or select exact tests until root supplies and reviews the PR 3 head.
