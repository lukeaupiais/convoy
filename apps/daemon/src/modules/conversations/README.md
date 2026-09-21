# Conversations

Owns durable conversations, agent-session identity, steering, attachment policy,
queued messages, and fail-closed restart recovery. A conversation can remain
ticket-free, take work without losing context, or delegate to another session.

This module records intent and continuity; attachment bytes are stored through the
persistence adapter, and the control plane dispatches model and runner work.

Conversation creation is a module command. Ticket linking, delegation, release,
and context checkpoints are session commands: runtime resolves the session and
renews its control lease before this module receives them.

Message queuing, interruption, discard, and resume are also Conversation session
policy. Model transport and global launch scheduling remain injected ports.

Agents discover board IDs, columns, placements, and current ticket revisions
through `list_work`. They may request an explicit `move_ticket`; approval is
required, and Work remains the owner of placement and field-backed semantics.
