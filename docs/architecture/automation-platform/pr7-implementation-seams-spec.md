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

Add focused policy-owner, binding-owner and runtime acceptance coverage. Prove two simultaneous roots respect separate organization/project ceilings, project reductions do not restrict unrelated projects, queued map slots progress when active work completes, unknown effects retain reservations, and revoked/grant-changed principals cannot dispatch or reconcile through descendants.

Prove custom human outcomes and exact accepted agent details can produce typed child results while stale/uncompleted receipts cannot; optional agents receive separate leases/sessions only when their declared route executes. Preserve the procurement zero-agent and bounded document-map examples, cancellation/restart/compensation tests and genericity audit from the main specification. Root reviews final immutable base/head against both axes before publication.
