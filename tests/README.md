# Tests

Tests are grouped by the boundary they protect:

- `modules` — focused domain behavior with injected fakes.
- `runner` — process, terminal, and worker protocol lifecycle.
- `web` — pure browser-facing formatting and state logic.
- `acceptance` — behavior spanning daemon modules, adapters, or HTTP.
- `support` — shared fixtures only; no product behavior.

Favor observable contracts over private implementation details. Every regression
test should fail for the original reason, and time/process tests must clean up all
resources even on assertion failure.

Module tests may import the owning module implementation. Cross-domain acceptance
tests should enter through bootstrap/public façades so that they protect the same
ownership boundaries as production.

The repository scripts run test files serially. Several suites create real child
processes, loopback servers, and signals; cross-file concurrency introduces host
scheduler races without making those contracts more representative.
