# PR5 legacy wait compatibility acceptance

Owner: Luna high /root/pr4_activities, test-only helper. Production owner is /root/pr3_runs.

Root reproduced the regression through public commands using disposable state: a wait for ticket_updated, ticketSource=active_ticket, status=Published with activeTicketId=1 completed after ticket 2 changed to Drafting. Script and result: /tmp/convoy-automation-series/pr5-legacy-wait-proof.mjs and .json.

Add tests/acceptance/workflow-legacy-event-waits.test.mjs only in the events checkout. Read tests/README.md and the nearest README first. Do not change production or existing tests, commit, publish or merge. Coordinate with the production owner and hand over failing assertions if the fix is still pending.

Exercise canonical public commands on disposable runtime state. Active-ticket waits must reject unrelated tickets and the wrong configured status, then accept the exact ticket/status. Related-ticket waits must reject unrelated tickets, unlinked targets and the wrong relation kind, then accept the configured relation/status. Restart while pending and prove the same run/wait identity survives without replay. Include old stored node shapes without explicit eventRevision where feasible; a registered descriptor revision remains pinned across restart and cannot accept a different revision.

Work owns legacy ticket/status/relation semantics. Do not endorse direct ticketRelations access or customer vocabulary in the generic Workflow matcher. Registered unrelated inventory/publication waits continue to use declared generic scope, correlation and conditions.

Root reviews and runs this helper independently. Its author excludes the helper itself from the later Standards-axis review.
