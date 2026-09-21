# Bootstrap

This is the composition root. It creates authentication, runner, provider, and
persistence adapters, then injects those ports into the control plane and HTTP
transport. `runtime-factory.mjs` is also the supported filesystem-backed
factory for tests and smoke scripts.

Production composition root: acquires the single-writer lock, creates adapters,
constructs the runtime and HTTP server, and performs graceful shutdown.

No reusable logic belongs here. Tests should construct the runtime/app with fake
dependencies rather than importing this side-effecting entry point.

The daemon is loopback-only by default. A hosted deployment is configured with
`CONVOY_PUBLIC_ORIGIN` (HTTPS), `CONVOY_LISTEN_HOST`, `CONVOY_PORT`, and an
exact comma-separated `CONVOY_ALLOWED_ORIGINS` list. `CONVOY_DISPLAY_NAME`
sets the discovery label. Setting a minimum 24-byte
`CONVOY_BOOTSTRAP_TOKEN` enables the one-time remote owner bootstrap ceremony;
remove it after the first client signs in. Remote mode always requires Convoy
identity authentication and secure browser cookies. TLS may terminate at a
trusted reverse proxy, but the advertised public origin remains HTTPS.

An installed desktop build sets absolute `CONVOY_DATA_DIR`, `CONVOY_STATIC_DIR`,
and `CONVOY_WORKER_ARTIFACT_DIR` paths. The bootstrap reports readiness to its
Electron utility-process parent and handles a graceful shutdown request. Without
these settings, source daemon behavior retains repository state and worker paths.
