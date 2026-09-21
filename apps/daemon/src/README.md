# Daemon source

Dependency direction:

```text
bootstrap -> http/control-plane -> modules -> shared
                         |-> adapters
control-plane/modules -> packages/contracts + packages/runner
```

- `bootstrap` wires production dependencies and process lifecycle.
- `http` translates HTTP/SSE without making domain decisions.
- `control-plane` coordinates use cases spanning domains.
- `modules` own domain rules and expose explicit public indexes.
- `adapters` implement persistence, providers, authentication, and execution I/O.
- `shared` is limited to stable daemon-wide primitives.

Modules must not import bootstrap, HTTP, control-plane, or adapters. Inject those
capabilities at composition time.
