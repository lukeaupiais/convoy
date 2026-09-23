# Work

Owns projects, authoritative tickets, custom boards, optimistic revisions, and
idempotent ticket creation. Boards are configurable views; workflow phase and
ticket column are independent unless an explicit action connects them.

Work commands are registered through the control-plane module command registry.
The control plane may observe a completed Work mutation to coordinate workflow
triggers, but Work never imports or traverses workflow state.

`setBoardPlacement` is the shared mutation seam for operator drag-and-drop,
approval-gated agent moves, and explicit workflow actions. A move on a local
board changes presentation only. A move on a field-backed board also changes its
configured authoritative ticket field; the command result reports that effect.

Work also owns ticket origin, external issue links, board creation destinations,
and sync conflict decisions. An injected adapter speaks the external issue API;
Work persists outbound intent before asking it to create an issue. Board
placement alone never publishes a ticket.

Imported support tickets may link to local development tickets in the same project.
An import binding assigns one external source to a project and work type.
Its membership is separate from the ticket and board placement, so one ticket
can appear on several boards. Boards filter by work type and, when needed,
binding membership. A development board can create its own work type.
One development ticket may
address several support reports. The relationship is durable and independent of board placement;
finishing development does not change a support ticket's external-owned status.

Bindings can opt into a polling interval. Work records the last attempt and any
source error; the control plane drains durable import and customer-message facts
after each poll. A ticket thread is a source-owned projection. The first read
establishes a baseline, while later customer messages can start or resume a
workflow. An import fact waits until the source thread has loaded successfully.
An incomplete thread is rejected so missing history cannot be mistaken
for a new customer message. Outbound replies record intent before transmission
and require reconciliation if the result is uncertain. A queued reply is not a
delivery receipt.
