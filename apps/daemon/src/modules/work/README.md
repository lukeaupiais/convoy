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
