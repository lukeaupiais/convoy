# Contracts

This package is the authoritative wire vocabulary shared by the daemon and web
client: commands, snapshots, boards, tickets, workflows, sessions, execution,
and capability profiles. UI-only editor state belongs in its feature codec and
must be converted to these canonical contracts at the boundary. Public contract
types do not use `any`.

`RuntimeCommandInputMap` is the compile-time source for action-specific command
payloads. The daemon mirrors it with executable validation at the trust boundary;
the architecture check fails when either side gains an action without the other.

Type-only shared vocabulary for commands, snapshots, events, worker protocol, and
domain read models. Contracts describe data at process/UI boundaries; they do not
perform I/O or contain domain services.

Prefer explicit tagged unions and stable identifiers. Breaking a contract requires
updating every producer, consumer, migration/compatibility path, and test.
