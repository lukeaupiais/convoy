# PR 7 implementation seam clarifications

Owner: Luna high /root/pr4_activities. Implementation starts only on the reviewed integrated PR 5–6 head supplied by root. This supplements 07-composition.md and pr7-interface-design.md.

## Current policy and canonical reservations

Execution owns a narrow public resolveWorkflowCompositionLimits operation. Workflows owns canonical slot/run reservations and usage accounting; the control plane coordinates the two owner operations. Do not introduce a second scheduler, child table, or mutable budget ledger outside the canonical WorkflowRun/attempt state.

Execution-owned organization policies and optional project overrides are revisioned, bounded data. A project override may only lower the organization ceiling. Expose an explicit organization/project administrator command through the existing authority seam; workload identities and ordinary executors cannot change policy. Validate at update and at resolution. Preserve existing execution/scheduler capacity configuration, which controls different resources.

Default ceiling proposal is approved: maxDescendantRuns=128 per root composition, maxMapItems=100, maxConcurrentChildren=8 per composition, maxDeadlineMs=604800000, organization maxActiveDescendantRuns=32, project maxActiveDescendantRuns=32. These are generic safety limits, not business semantics. Node limits and selected run limits may lower them. Return organization, project and per-root ceilings separately: lowering one project's active ceiling must not lower the organization-wide ceiling for unrelated projects.

Pin the resolved policy revision/ceiling on the root run and descendant identities. Before each new child admission and resource dispatch, resolve current policy and use the minimum of admitted/current ceilings. Count organization usage against its organization ceiling and project usage against its own project ceiling. Reserve stable slots/child IDs before launch. Queued slots consume root descendant/item budget but no active capacity. Active, waiting and uncertain work retains the actual reservations required by its declared contract; unknown dispatched effects cannot free capacity merely because the parent is cancelled. Enforce this across two concurrent roots and after policy reduction/restart.

## Typed terminal result sources

Reuse resultSchema/resultBindings and the existing binding resolver. Add node-specific terminal mappings only where required, as explicit pinned data, preserving legacy global result bindings. Every child-successful terminal must produce its declared schema-validated result; failed/cancelled/uncertain system states cannot satisfy a successful join. Customer outcome names do not determine child success or authority.

The PR6 human_response binding already exists for activity inputs. Extend terminal result validation/resolution through the same owner source. Eligible fields come from the exact immutable response ID accepted in that run's completed decision history, matching pinned workflow/version, node and instance. Use humanFormSchema. Do not filter by a literal approved outcome name; configured outcomes are arbitrary. Current-terminal decisions must be resolved from a validated staged completion receipt or equivalent owner operation because the current transition resolves its result before appending history. Never expose an unreviewed proposal, stale response, or mutable session form.

The optional-agent document example needs actual accepted output. Add a narrow agent_submission binding source only for declared, accepted, completed submissions. The configured node and schema are pinned at publication; runtime selects the latest completed attempt of that explicit node preceding the consumer, matching immutable run-owned node/instance/revision receipts. Retain old receipts. Support this same source for a downstream registered parser activity and terminal result mapping. Derive a bounded schema from the existing configured submission contract: summary and declared string detail fields are sufficient initially. Do not export references, private review material, arbitrary lastSubmission/session state, secrets, or raw provider responses. Validate declared paths and provenance at publication; validate actual receipt/type again before dispatch. A configured pure parser may transform a declared extracted JSON string into typed document fields/confidence.

Capture/reuse canonical completed submission/evidence receipts in Workflows; do not create another conversation/session output authority. Preserve immutable old submission bytes, current exact approval bindings and existing reply review compatibility.

## Verification

Add focused policy-owner, binding-owner and runtime acceptance coverage. Prove two simultaneous roots respect separate organization/project ceilings, project reductions do not restrict unrelated projects, queued map slots progress when active work completes, unknown effects retain reservations, and revoked/grant-changed principals cannot dispatch new descendants or bypass existing reconciliation authority.

Prove custom human outcomes and exact accepted agent details can produce typed child results while stale/uncompleted receipts cannot; optional agents receive separate leases/sessions only when their declared route executes. Preserve the procurement zero-agent and bounded document-map examples, cancellation/restart/compensation tests and genericity audit from the main specification. Root reviews final immutable base/head against both axes before publication.

## Registered wait authoring and compatibility

The final genericity audit must replace the workflow editor's three fixed ticket-event choices and fresh default ticket_message_received/active_ticket assumption. PR5 owns preservation of full wait fields through the editor codec, including event revision, tenant scope, resource identity, correlation, predicates and timeout. PR7 completes practical authoring using registered descriptor data and pinned schemas.

Fresh waits require an explicit selected registered event. Show its declared revision/scope and only meaningful compact resource, correlation, typed condition and timeout controls. Expose bounded descriptor correlation metadata through the owning read contract if currently absent; do not guess which payload fields may correlate. Source selections for run-input or registered upstream outputs follow the existing publication validation. Keep old configured ticket constraints visible only where actual stored data or an explicit Work-owned capability declares them; do not infer semantics from event labels, board names, workType, customer statuses or source owner strings in generic UI. Preserve old alias/node bytes and every unrelated wait field when an operator edits one field.

Browser acceptance must author and save an inventory resource wait and an unrelated publication callback wait, read their exact canonical fields back, reopen/edit without data loss, and retain existing ticket wait editing. Mobile controls fit the viewport without explanatory paragraphs. This is part of the final functional platform UI, not a documentation-only promise.

## Root active capacity and explicit compensation

Keep a separate root-wide active descendant ceiling, default 8, in addition to per-composition concurrency 8, root total descendants 128, and independent organization/project active ceilings 32. Nested compositions share the root active ceiling. Current and pinned minima apply; waiting or uncertain dispatched descendants retain their reservations. Project overrides cannot reduce another project's organization capacity.

Explicit compensation may reference a pinned child workflow rather than introducing a second activity-attempt owner. Validate its exact workflow version, registered activity revision, typed inputs/results, tenant scope, principal, grants and stable compensation role/slot before admission. A required approval uses a declared human gate; never automatically approve it. Resolve possibly applied forward effects before compensating. Uncertain compensation remains uncertain with its own receipt and reservation. Compensation history preserves the original forward outcome and cannot silently replay a mutation.

The graph editor must preserve and render declared child, parallel and map kinds through edits, rather than converting unknown kinds to agent nodes. Run presentation exposes actual canonical child status and meaningful controls without customer terminology or explanatory filler.

## Existing reconciliation authority

Preserve the verified current-operator cleanup seam in tests/acceptance/workflow-run-revocation.test.mjs: a different currently authorized operator with the current actor-bound lease may reconcile an exact existing legacy effect after the stored run principal loses authority. The successor remains paused and cannot dispatch under the revoked principal. A revoked workload itself cannot use this exception. Registered activities retain their existing owner authorization and exact intent/receipt checks; do not broaden them merely to make cleanup easier. No new child, join-dependent successor, compensation or mutation may start under a revoked root principal. Keep the existing regression unchanged and add causal descendant-denial coverage where relevant.

Active capacity measures actual reserved execution, not every nonterminal coordinator record. An effect-free composition waiting only on its own descendants must not exhaust leaf admission capacity and deadlock its queued children. All canonical descendants and queued slots still consume the root total budget. Waiting human/external activities and uncertain effects retain the reservations required by their declared contracts. Verify a nested composition with root/org/project ceilings lower than its total queued descendants actually makes progress and never exceeds its active reservation ceilings.

## Cumulative map item ceiling

maxMapItems=100 bounds both each map and the cumulative number of map item slots reserved under one root. Reserve item usage canonically before launch and reject overflow before creating any slots; never admit a composition that can only remain permanently blocked at dispatch. Current policy reductions prevent new admission/dispatch while preserving exact reconciliation of already dispatched effects.

## Bounded reads and controlled results

Approved public read additions: getWorkflowRun may accept compositionOffset and return at most 50 canonical attempts with total/offset/hasMore, bounded slot projections and childRunCreated. Preserve all authoritative attempts; UI pages older attempts and opens only created children. getWorkflowRunResult requires current project.execute and the exact current actor-bound run/session lease, returning only schema-validated immutable result plus matching digest from Workflows. Result bodies do not enter ordinary project-read snapshots. Deny absent/stale/foreign-actor control and revoked execute authority; UI clears private data on context/control changes and guards late async reads. Shared contracts remain data shapes and HTTP does not decide authorization.
