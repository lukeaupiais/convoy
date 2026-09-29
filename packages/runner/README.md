# Runner package

Provider-neutral machinery for agent loops, supervised commands, terminals, and
worker RPC. This package owns execution mechanics; daemon policy decides when an
operation is allowed and which runner receives it.

All long-running operations need explicit cancellation, bounded output, terminal
state, and disconnect semantics. A lost transport after mutation is not success.
Tests live in `tests/runner`.

Foreground and supervised shell commands accept up to 32,000 characters, so
ordinary multiline scripts and evidence writes fit in one operation. Oversized
commands report the measured length, limit and recovery. Execution grants,
sandboxing, timeouts and the daemon's aggregate argument bound still apply.

Disposable runtime operations serialize inside each worker while retaining the
durable lock against other workers and abandoned operations. Container creation,
start and readiness share the configured startup deadline, bounded by total
runtime lifetime. Interrupted creation is reconciled using the recorded name,
identity label, image and resource envelope; missing identity evidence remains
uncertain. Independent expiry is installed before container creation.
