# Deployment persistence

Convoy clients do not own canonical state. One daemon deployment owns tickets,
boards, conversations, sessions, workflow state, authorization, and audit records.
Runner worktrees and journals are execution evidence, not a second project store.

## Current storage contract

The production daemon uses SQLite for a personal deployment and PostgreSQL when
`CONVOY_DATABASE_URL` is set. SQLite imports an existing `runtime/state.json` once
and preserves the original file. PostgreSQL can import that JSON only with the
explicit `CONVOY_IMPORT_LEGACY_STATE=1` setting and an empty database. Both
adapters persist keyed collection members in a single transaction per `save()`.
SQLite uses WAL and `synchronous=FULL`; PostgreSQL uses one transaction and holds
an advisory lock that excludes another coordinator writer. The bootstrap also
retains the local PID lock.

The control plane currently loads the complete state into memory and modules
mutate it directly. Database rows reduce write amplification and give a durable
database boundary, but **this is not a multi-coordinator or horizontally scaled
runtime**. The same daemon must own scheduler decisions, session leases, and
runner assignments. A database outage or lost coordinator connection must be
treated as an interruption, and any potentially applied runner effect needs
explicit reconciliation. Do not launch another daemon against the same deployment
until the first has stopped and its assignments have been inspected.

Attachments, command logs, deployment identity, and credential keys remain in
the deployment data directory. A team deployment therefore needs a durable
volume for this directory even when its state database is PostgreSQL. Provider
credentials stay with the daemon and never enter the mobile client or runner.

## Offline backup and restore

Stop the daemon, then run `npm run backup -- DATA_DIRECTORY NEW_BACKUP_DIRECTORY`.
The archive contains a manifest with SHA-256 and length for every file. Restore
to a new empty directory with `npm run restore -- BACKUP_DIRECTORY NEW_DATA_DIRECTORY`.
The commands refuse a live or stale daemon lock and do not overwrite a target.
For PostgreSQL, set `CONVOY_DATABASE_URL` during backup and
`CONVOY_RESTORE_DATABASE_URL` during restore. The latter must point to a new empty
database. The tool takes a logical `pg_dump` and applies it with `pg_restore` in a
single transaction while holding the coordinator advisory lock.

The offline archive is a point-in-time snapshot only while the coordinator is
stopped. It does not include remote runner journals or repository worktrees and
cannot prove whether an external effect completed. Team operators needing
continuous point-in-time recovery must configure PostgreSQL WAL archival and
back up the deployment blob volume as one recovery set. A restored deployment
must verify its identity and reconcile any interrupted assignment before new
execution.

## SQLite to PostgreSQL migration

`npm run migrate:postgres -- DATA_DIRECTORY NEW_BACKUP_DIRECTORY` requires a
stopped SQLite deployment and `CONVOY_DATABASE_URL` for a dedicated PostgreSQL
database. It makes the offline backup first, imports the complete state under
the same storage identity, closes and reopens the target database, compares
the state exactly, then changes `runtime/storage.json` to PostgreSQL. A failed
comparison leaves SQLite authoritative. The source database is retained for
rollback; moving the data directory to another host also requires its credentials,
blobs, deployment identity, and runner configuration to be reviewed there.

## Next storage boundary

Keyed rows are a compatibility bridge for the current in-memory domain model.
For larger teams, move messages, events, effects, leases, audit records, and
tenant-owned work into domain-owned transactional queries with bounded snapshots.
Add durable fencing for coordinator failover before running multiple replicas.
Do not interpret the PostgreSQL adapter alone as proof of multi-instance safety.
