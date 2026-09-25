# Automations and workflows

Status: canonical model implemented; local cutover is an explicit offline operation.

## Decision

An automation is a project-owned, revisioned `When / If / Then` rule. `when`
selects an owner-defined completed event and optional board/column or required
import-binding scope. `if` is a conjunction of typed equality predicates over
advertised event fields. `then` currently starts one exact published workflow
version. A workflow owns dependent steps, approvals, revision routes and recovery.
Boards project Work state; their columns never substitute for process evidence.

Work owns completed ticket facts, before/after field-backed column transitions,
and command-effect descriptions. Workflows owns matching, workflow eligibility,
and run transitions. The control plane coordinates dispatch and authorized
relationship queries. External protocols remain in adapters; customer mappings
and labels remain configuration. Shared contracts contain shapes only.

## Execution

Rules carry a governed principal. Dispatch and explicit retries revalidate
current authority and bindings. Event/rule-revision decisions are durable and
deduplicated. Multiple matches conflict. Events arriving during an active run
are held visibly for review and explicit retry; there is no automatic queue.
Workflow-originated updates do not recursively start automations. Creation of
related work retains the existing independent-ticket start boundary.

Workflows retain their exact published version and approval evidence. Published
updates do not rewrite active runs. Uncertain effects require reconciliation.
Source status changes requiring reply evidence use a delivered reply correlated
to the workflow run, rather than a timestamp alone.

## Authoring and inspection

The automation editor uses owner-provided event labels, scopes and condition
fields. Unsupported configuration is visible and rejected on save. The only
rule action in this delivery is `start_workflow`; general direct-action authoring
and new correlated wait/resume semantics are excluded.

See [board automation visibility](board-workflow-visibility-spec.md) for the
relationship projection. Workflow actions use canonical `input`; move actions
use `input.placement.columnId`. Embedded triggers and legacy development-ticket
commands are removed. Generic related-ticket creation carries explicit
relationship and target-board configuration.

## Migration

Run `scripts/migrate-automations.mjs DATA_DIRECTORY --config CONFIG` to validate
an offline SQLite copy; add `--apply` to commit. Stop writers and take a complete
deployment backup first. A daemon lock blocks migration, including a stale lock.
The script converts rules, decision collections, action aliases, generic ticket
relations and ordered workflow graphs. Optional local configuration publishes a
new support workflow revision and retargets its rules. Pinned active runs retain
identity, gate state and evidence. Existing invalid unpinned historical versions
are retained with explicit diagnostics, never silently repaired.

Normal runtime has no old-schema reader or automatic legacy-trigger conversion.
Rollback restores a complete backup with its matching application version.

## Local implementation evidence — 2026-09-25

AFIO's two enabled binding-scoped automations target support workflow v4. The
Support projection resolves **Sets Waiting on user**; Development resolves
**Creates in Backlog**. Project triggers remain separate from column effects.
The one pending Team delivery gate was compared with the offline backup and
retained exactly; all 27 sessions were preserved. The rehearsal used disabled
external adapters and made zero external calls. No customer message was fabricated.

Local configuration is in `.convoy/project-config/afio-support/`, including the
canonical automations, v4 workflow, and explicit migration configuration. The
full deployment backup is `.automation-backups/pre-canonical-20260925/`. Existing
source changes are preserved in the `pre-canonical-automations root work
2026-09-25` Git stash; implementation is on `feat/canonical-automations-local`.

Architecture checks, production build, 17 focused test files, live daemon
read-back, exact-version UI navigation, collapsed project disclosure, keyboard
focus restoration, and narrow-screen popover bounds were verified. The production
build retains the existing large-chunk warning. The migration reports an existing
invalid unpinned Implementation v1 Verify command and preserves that history.

The full suite ran 385 tests: 381 passed, two were skipped (PostgreSQL service
and packaged worker prerequisites), and two desktop startup tests initially
failed because the running desktop occupied their fixed ports. Both desktop
tests passed when rerun with those ports released: 383 tests passed across the
suite and targeted rerun. The desktop was restarted afterward.
