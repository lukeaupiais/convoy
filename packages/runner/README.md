# Runner package

Provider-neutral machinery for agent loops, supervised commands, terminals, and
worker RPC. This package owns execution mechanics; daemon policy decides when an
operation is allowed and which runner receives it.

All long-running operations need explicit cancellation, bounded output, terminal
state, and disconnect semantics. A lost transport after mutation is not success.
Tests live in `tests/runner`.
