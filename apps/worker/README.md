# Portable worker

The worker runs inside a registered local or SSH environment. It accepts framed
requests on standard input and performs repository, file, sandboxed command, and
terminal operations using the shared runner primitives.

It is disposable and carries no provider credential or authoritative state. The
same artifact and protocol must work locally and remotely. Build it with
`npm run build:worker`; protocol tests live under `tests/runner` and
`tests/acceptance/worker.test.mjs`.
