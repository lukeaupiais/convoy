# PR 6 implementation proposal — human tasks and generic evidence

This proposal is scoped to configured human activities and the immutable evidence they review. It builds on PR 1's `decisionLabels` presentation field and PR 3's WorkflowRun and activity-attempt identity. The owning module remains Workflows: it validates human task definitions, captures task responses and evidence references, records decisions, and advances the graph. The control plane supplies the authenticated principal, checks tenant and reviewer authority through the existing organization interfaces, and coordinates evidence/effect adapters. The web workflow feature renders the bounded contract. Contracts describe data only.

## Definition shape

Keep one human-task definition on a human node, normalized and pinned with the published workflow revision:

```ts
type HumanTaskDefinition = {
  outcomes: { id: string; label: string }[];
  form?: FormSchema;
  reviewerPolicy?: ReviewerPolicy;
  dueAfterSeconds?: number;
};

type FormSchema = {
  fields: {
    id: string;
    label: string;
    type: 'text' | 'number' | 'boolean' | 'choice' | 'date';
    required?: boolean;
    options?: { value: string; label: string }[];
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
  }[];
};
```

Outcome IDs are stable, bounded identifiers used by graph edges and history. Labels are plain text presentation metadata, capped and normalized like PR 1's `decisionLabels`; they never grant authority. Definitions reject duplicate IDs, unsupported field types, unsafe field names, invalid bounds, overlarge forms/options, and edges referencing undeclared outcomes. Existing human nodes without this field normalize to `approved` and `changes_requested` with today's default labels and routing behavior. On draft reads/writes, PR 1's `decisionLabels` is a derived compatibility projection for those two IDs; when an old client saves a draft, translate its label edits into the new draft definition. If both old and new fields are supplied, the canonical configured outcome label wins. Published definitions and pinned active runs are immutable; never backfill compatibility labels into a published record or its pinned run snapshot.

`ReviewerPolicy` should use existing organization identities and authorization predicates, not introduce a workflow-specific role table. The workflow may pin eligible user IDs and/or an existing Organizations permission as a declarative selector; team-level eligibility follows the project's actual team context and its current membership rules. At response time, the control plane resolves the authenticated principal with `organizations.resolveContext` for the run's organization/project, then calls `organizations.authorize(context, permission, resource)` for the configured permission and resource. It also checks any explicit user allowlist against that authenticated principal. Empty or unresolved selectors fail closed. Store the normalized policy on the pinned definition; do not trust a submitted actor ID, current browser context alone, a label, or membership cached at run start. If PR 4 exposes a generic principal-reference contract, reuse it instead of creating a second selector format.

## Response and review seam

Add a Workflow-owned `submitHumanTaskResponse` and `decideHumanTask` seam. Submission takes `{ runId, nodeId, instance, formValues }`; it records a bounded immutable proposal but grants no authority. Workflows resolves any declared downstream effect input from that proposal and creates a server-owned review preview. The separately presented preview contains the final immutable material set and the exact reserved effect intent. Decision takes `{ runId, nodeId, instance, outcomeId, responseId, reviewedMaterialDigest, intentId? }`. The authenticated principal, lease/control claim, organization and project context arrive separately from the control plane. Workflows verifies that the run and exact attempt are current, the pinned node is human, the outcome is configured and routed, the response is current, and the material and intent digests equal the preview awaiting review. The control plane checks run-specific control authority and reviewer eligibility before calling the owner. Never accept actor identity, organization, outcome label, next node, or effect command from form data.

Responses and decisions are immutable records linked to `(runId, workflowId, workflowVersion, nodeId, attemptInstance)`. Persist bounded proposed values before review; persist outcome ID, response ID/digest, authenticated principal ID, decision time, reviewed material digest, and optional intent reference on decision. A `changes_requested`-style outcome follows its configured edge and starts a new activity attempt according to the existing revision loop. It does not overwrite the old response, preview, material, or attempt. A response cannot be amended in place; a new attempt requires a new response.

Legacy `approveGate` and `requestChanges` are translations into the same owner operation using `approved` and `changes_requested`; they must pass the same lease, exact-instance, stale-attempt, tenant, and reviewer checks. Keep their existing command shapes and session-flow projection for old clients. They must not form a second decision path. For existing approval of agent submissions, create a compatibility reviewed-material reference from the current immutable submission and captured evidence, preserving the existing reply source and `approvedSubmission` projection until old readers are retired.

## Exact approval and effect intent binding

The immutable approval record binds the whole decision context, not just an outcome or a currently active node:

```ts
type HumanDecision = {
  runId: string;
  workflowId: string;
  workflowVersion: number;
  nodeId: string;
  attemptInstance: string;
  outcomeId: string;
  responseDigest: string;
  materialDigest: string;
  effectIntent?: { intentId: string; activityNodeId: string; inputDigest: string };
  actorId: string;
  decidedAt: string;
};
```

`responseDigest` covers canonical bounded proposed form values. `materialDigest` covers the ordered immutable evidence references and server-presented effect preview for this review. When an outcome authorizes an effect, `effectIntent` points to a reserved intent created by Workflows when the human gate activates. The intent ID and digest bind the canonical effect inputs, target identity, activity node/revision, run/workflow revision, and the gate attempt; this permits a normal approve-then-effect graph because no downstream effect attempt needs to execute before approval. Workflows materializes that exact reserved input into the later PR 4 activity attempt. The effect adapter checks the same digest immediately before dispatch and again when confirming/reconciling; changed input, material, attempt, workflow revision, or effect identity requires a fresh decision. A UI label such as “Publish” or “Accept estimate” does not make an effect authorized. An outcome authorizes only the policy explicitly declared by the activity and graph, after the control plane rechecks current organization policy. An action with no declared approval requirement is not silently converted into an approval-gated operation.

If proposed form values contribute to the effect input, they are captured first as an immutable proposal. Workflows then computes and presents the exact reserved intent and preview digest before enabling the separate decision step. The review cannot be submitted against a preview the server has not returned. A changed proposal or preview requires fresh material review and a fresh decision. This prevents a combined form-and-approve request or later binding from silently widening what was reviewed. It keeps form entry distinct from permission and avoids a general-purpose approval token.

## Evidence references

Represent review material as immutable content-addressed references, with a bounded kind and opaque owner locator:

```ts
type EvidenceRef = {
  id: string;
  digest: string;
  mediaType: string;
  byteLength: number;
  source: { nodeId: string; attemptInstance: string; producer: string };
  locator: { owner: 'workflows' | 'files' | 'activity-adapter'; key: string };
  name?: string;
};
```

The locator is for authorized retrieval and is not authority. Workflows owns the evidence-reference and review-history semantics. Reuse or extend the existing bounded content-addressed persistence adapter in `apps/daemon/src/adapters/persistence/context-files.mjs`, passed through the composition root; there is no daemon Files module. Its capture/read port can accept the owning WorkflowRun scope (run ID and tenant identity) directly rather than require a fake session. Use an activity adapter's public receipt/snapshot contract for data that remains owned by that integration. Do not add a second blob store. Evidence capture does not require a repository path or workspace. Preserve legacy artifact path/hash access by projecting existing captured artifacts into evidence references, while old artifact readers continue to work. Keep file/line references and sealed runner verification as existing producer-specific evidence with their stronger validation. Add producer adapters for content-addressed documents, validated external response snapshots, and immutable receipts from non-agent activities. Capture bounded bytes/metadata, validate the declared media type/size and digest, and never persist credentials or unbounded raw responses. A non-agent activity receipt uses its immutable activity attempt/output identity as source, so a no-agent run can be reviewed without fabricating a session, runner, or repository.

Metadata edits create a new reference/revision and digest; they never mutate bytes or an earlier decision. Retrying an activity creates a new attempt and evidence source. Previously captured output remains inspectable through authorization even after retry. Evidence validity is about immutable captured material; repo-backed freshness checks remain an additional producer policy, not a universal human-task requirement.

## Bounded web behavior

The workflow editor authors outcome IDs/labels, the small field schema, reviewer selector, and optional relative deadline from typed controls. Runtime renders only the declared input widgets and configured outcomes, with server-side validation authoritative. Do not accept HTML, CSS, component names, executable expressions, or arbitrary JSON Schema/UI manifests. Keep current labels for current canonical outcomes. Keep the response form compact and place captured material beside it; add no explanatory paragraphs. Reviewers can inspect immutable prior attempts and material, while stale or unauthorized controls remain disabled with the existing concise error/state treatment.

The Workflow feature must operate on independent runs directly, with or without a linked Session. Use the authorized `workflowRuns` read model and `getWorkflowRun` detail query, plus run claim/release and human-response commands. Provide a minimal path from a project/workflow run list to the current human-task panel; starting a configured workflow from that feature is available where the caller is authorized. The panel reads the exact run/attempt/material, claims run control before response, submits the form proposal, displays the server-computed preview, then sends the separate decision. It must not depend on `Session.flow` or create a fake conversation/session. Keep the panel to current state, material, and available actions.

## Unrelated acceptance examples

Use both examples in contract/UI tests so the shape remains generic:

1. **Procurement:** capture a vendor quote document; outcomes `accept_quote` and `request_revision`; the configured finance-reviewer selector controls eligibility. The review preview binds the quote and reserved purchase-order intent. If the reviewer enters an amount or delivery date that becomes effect input, submit those fields first, then review the server-computed intent preview and approve it as a separate command.
2. **Publication:** capture a content package; outcomes `publish` and `return_for_edit`; a different configured editorial-reviewer selector controls eligibility. The review preview binds the content receipt and reserved publication intent. If the reviewer selects an audience used by that intent, the choice is captured first and the server presents the exact publication preview before a separate approval.

Neither example's labels, fields, reviewer group names, or business rules become Convoy defaults. Also exercise a no-agent API-response snapshot and activity receipt as evidence, with no repository configured.

## Focused test and compatibility plan

- Workflow module: normalize/publish both example definitions; reject duplicate or malformed outcomes, invalid schemas, excessive values, stale node/attempt/material/preview refs, invalid outcome edges, and invalidation after retry/material or intent-input change. Assert response proposals are not decisions, intent is reserved at gate activation, effect attempts consume only the exact approved intent, and decisions/revision loops are append-only.
- Authorization boundary: through the control plane, accept an eligible active principal and reject inactive membership, wrong organization/project, unassigned principal, revoked membership, spoofed actor ID, lost run control, and stale attempt. Assert form values and labels do not alter authorization.
- Evidence boundary: capture/read a document, validated adapter snapshot, and activity receipt by digest; verify size/type/digest failures; preserve original material after retry; verify no repository, runner, provider, or fake session is needed for non-agent evidence.
- Compatibility regressions: load an old published human node and an active `waiting_gate` run; verify default outcomes, prior `decisionLabels`, `approveGate`, `requestChanges`, `decisionSubmissionRef`, `approvedSubmission`, reply delivery, and current session-flow projection keep their previous meaning. Verify old artifact path/hash access remains resolvable.
- Web: codec round-trip both examples, bounded schema widget rendering/validation, configured label rendering, and disabled response on stale/unavailable material. Add a browser-facing no-agent procurement and publication test that starts or opens an independent run, reads its exact material, claims control, renders the configured form/outcomes, and exercises proposal then decision controls without creating a Session. Keep presentation tests in `tests/web` and domain tests in `tests/modules`; add the smallest acceptance test crossing Workflows, control-plane authorization, and the evidence/effect adapter.
- Run `npm run check:architecture`, `npm run build`, focused workflow module/web/acceptance groups, then the full suite after integration as required by the series. Report baseline/environment failures without changing checks.

## Implementation order and open integration seam

After reviewed PR 3 and PR 4 heads are present, first add the contracts and Workflow definition/response/evidence owner interface; next wire the control-plane principal, run-control, organization eligibility, and adapter capture/effect-binding checks; then add the workflow editor/runtime UI and compatibility projections; finally run focused tests and the repository checks. Use only public module indexes across domains. The precise reviewer selector representation and evidence byte-store owner should be reconciled with the reviewed PR 4 contracts before coding; keep these as one small injected interface each and do not create a second authorization or blob-storage system.
