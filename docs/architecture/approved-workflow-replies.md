# Approved workflow replies

A workflow can draft an external ticket reply, capture it in a configured
submission detail field, and present it for human review. Approval authorizes
sending that exact captured text. It does not prove delivery.

The generic graph is agent draft → human review → `send_external_reply` →
optional source status action. `send_external_reply` declares `connectionId`,
`sourceNodeId`, and `field`. There are no customer, board-name, work-type, or
status assumptions in its implementation.

Workflows owns approval and the immutable submission copy. The control plane
coordinates sending, durable effect records, and delivery verification. Work
owns reply request identity, source linkage, adapter dispatch, reconciliation,
and observed delivery. The web UI displays the configured draft before approval.

No send occurs before approval. Missing drafts reject approval without consuming
the gate. Pending/failed delivery holds the send action and exposes its delivery
state; Continue rechecks the same reply. A restart never implicitly reposts an
uncertain send. Reconciliation uses Work's matching canonical reply record.
The status action runs only after the exact reply is confirmed delivered in the
source thread.

Acceptance coverage uses an unrelated editorial desk with configurable statuses.
It verifies no send before approval, stale approvals, exact body, delayed delivery,
connection loss after posting, explicit reconciliation, restart, and a single
send/status mutation. Focused Workflow tests cover missing drafts and invalid
configuration. AFIO's particular labels and routing live in its project inputs.
