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
Separate boards filter by ticket origin, so support and development work retain
their own columns without creating a second project. One development ticket may
address several support reports. The relationship is durable and independent of board placement;
finishing development does not change a support ticket's external-owned status.
