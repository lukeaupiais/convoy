# Adapters

Adapters translate external systems into interfaces consumed by the control plane:
authentication, model providers, durable files, local processes, and SSH workers.
They may depend on protocol libraries and operating-system APIs. Provider and
authentication adapters must not embed another agent harness: Convoy owns OAuth,
wire encoding, streaming, normalization, and tool-loop semantics itself.

Adapters do not own product policy. Keep request/response normalization here and
inject adapters so module and acceptance tests can use deterministic fakes.

| Adapter | External boundary |
| --- | --- |
| `auth` | Convoy-owned ChatGPT subscription login and refresh lifecycle |
| `persistence` | SQLite or PostgreSQL keyed state rows, attachment bytes, and bounded command logs |
| `providers` | direct provider HTTP protocol, model catalog, and streaming normalization |
| `runners` | local process or SSH worker transport |
| `deployment` | durable deployment identity and fail-closed server configuration |
