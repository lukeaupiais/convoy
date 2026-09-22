# Bootstrap

This is the composition root. It creates authentication, runner, provider, and
persistence adapters, then injects those ports into the control plane and HTTP
transport. `runtime-factory.mjs` is also the supported filesystem-backed
factory for tests and smoke scripts.

Production composition root: acquires the single-writer lock, creates adapters,
constructs the runtime and HTTP server, and performs graceful shutdown.

Production personal deployments use SQLite in `runtime/state.sqlite`. On first
start, an existing `runtime/state.json` is imported once and left untouched for
rollback. Set `CONVOY_DATABASE_URL` to use a dedicated PostgreSQL database for a
team deployment. PostgreSQL also enforces one coordinator writer with an advisory
lock. An explicit `CONVOY_IMPORT_LEGACY_STATE=1` permits one-time JSON import into
an empty PostgreSQL database; leave it unset for a new deployment. Both backends
persist keyed state rows inside a transaction, while the control plane still keeps
its working state in memory. Do not run multiple coordinator processes against one
deployment.

To move an existing SQLite deployment to PostgreSQL, stop the daemon, prepare a
dedicated empty PostgreSQL database, and run
`CONVOY_DATABASE_URL=postgres://... npm run migrate:postgres -- DATA_DIRECTORY NEW_BACKUP_DIRECTORY`.
The command takes an offline backup, imports the exact state, closes and reopens
PostgreSQL for read-back, then switches the local storage identity. It preserves
the old SQLite file. Start the daemon with the same `CONVOY_DATABASE_URL` afterward.

Stop the daemon before an offline backup of the complete data directory:
`npm run backup -- /absolute/convoy-data /absolute/new-backup`. Restore into a new
directory with `npm run restore -- /absolute/backup /absolute/new-convoy-data`.
The backup includes local identity, credential, attachment, and command-log files.
For PostgreSQL deployments, set `CONVOY_DATABASE_URL` for backup. The script
uses `pg_dump` while holding the coordinator lock and includes the dump in the
manifest. For restore, set `CONVOY_RESTORE_DATABASE_URL` to a new empty database;
the script checks its contents and uses `pg_restore` in one transaction. These
offline logical backups are portable snapshots, not point-in-time recovery;
teams needing PITR must also archive PostgreSQL WAL and protect blob volumes.

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
