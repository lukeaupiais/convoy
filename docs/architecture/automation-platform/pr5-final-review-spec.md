# PR 5 final review corrections

Base: 89d22331c61b48f50f4ab6c9b9e3d4154c19d136. Reviewed checkpoint: dcec5e76be134abec224d87bba5f1d1acb214a69. Owner: Luna high /root/pr3_runs.

1. Preserve failed-start recovery proof alongside held/conflict retry. A thrown save or acknowledgment after canonical run creation must be explicitly reconciled to that same reserved run identity and mark its decision truthfully; never create a second run or redispatch a completed/unknown effect. Keep meaningful coverage of the still-exposed legacy retryAutomationDecision command and original pinned workflow/no repeated board move semantics.
2. Keep legacy retry eligibility, failure classification and pinned rule/workflow resolution behind Workflow owner operations. Control plane coordinates their result and current authorization; it does not read the persisted decision ledger layout to decide lifecycle behavior.
3. Retain the no-session human-only profile example, and additionally prove that activating an actual agent resolves the workflow-specific immutable Library profile over a different project default and preserves that pin after restart.
4. A known cascade/cycle limit rejection is a durable terminal disposition before acknowledging the canonical Work outbox fact. It must not start/deliver another run, and a following unrelated fact must drain. Do not acknowledge arbitrary validation or persistence failures. Rejections, scope and identity belong to Workflow; Work owns the source fact/acknowledgment.

## Event data must reach the pinned run

The current checkpoint always starts automation/schedule runs with runInput={}. That prevents reusable workflows with required typed inputs from consuming their trigger data. Complete the PR 4 data seam at the PR 5 start boundary rather than exposing raw event state or teaching adapters to query the journal.

Automation Then may declare inputBindings, keyed by a published workflow run-input property. A binding is either {value: bounded JSON} or {from:{kind: event_payload, path: safe path segments}}. Validate bindings against the exact event descriptor revision and pinned workflow runInputSchema when saving a rule; reject undeclared paths, unsafe keys, incompatible types and missing required fields. Use the existing Workflow data validation owner and public surface. No expressions, raw webhook-body references, actor/scope overrides, or second executor.

Resolve only the accepted canonical event payload and configured constants into runInput before reserving the durable decision. Pin the resolved value and digest in that decision; its canonical run uses exactly those values on retry/restart. A schedule may declare bounded constant runInput, validated against its pinned workflow schema at save and retained in its immutable revision/decision. Existing rules and schedules without input configuration retain empty-object compatibility for workflows that accept it. Do not rewrite published workflows, existing decisions or active runs.

The generic automation editor must expose only declared target fields/source paths and configured constants, with minimal labels; no instructional paragraphs. Schedule configuration must accept the same typed constant input where its command/UI exists.

Acceptance: an inventory event's declared count drives a no-agent data transform; an unrelated publication callback's nested reference drives a correlated wait or integration input. Different source keys/scopes remain distinct. Invalid type/path/missing required input fails before a run/effect; edited rule/schedule or duplicate event cannot change the original decision/run input; ack-loss/restart preserves the exact input and identity. Old Work rules, waits and human-only graphs stay green.

Run architecture/build and narrow owner/web/acceptance groups, then freeze the corrective head for two-axis review. Do not publish/merge/deploy; root verifies and publishes drafts.
