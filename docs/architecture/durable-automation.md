# Durable automation

Workflows owns immutable published definitions, canonical workflow runs, activity
attempts, transitions, evidence, and run history. The control plane coordinates
domain commands and injected adapters. Work owns tickets and boards; Execution
owns placement and grants; Library owns capability revisions; Conversations owns
dialogue and agent sessions.

## Runs and resources

A run pins a published workflow revision and can execute without a ticket,
conversation, repository, provider, or runner. Resources are acquired when the
active activity needs them. Agent nodes create or attach their session at that
boundary; later nodes do not reserve capacity early. Session flow state is a
compatibility projection of the workflow-owned run.

Registered activities have versioned descriptors with input/output schemas,
resource requirements, effect policy, approval policy, and lifecycle capabilities.
Bootstrap supplies their implementations; workflow content cannot load code.
Inputs bind constants or declared paths from run input and completed outputs.
Publication and dispatch validate those bindings against the pinned descriptors.

## Effects and human decisions

Effect attempts pin resolved input, prepared intent, activity revision, and
idempotency identity before dispatch. Current authority is rechecked at execution
and reconciliation. Completed receipts are immutable. An uncertain mutation needs
explicit reconciliation and is never replayed automatically after restart.

Human tasks declare stable outcome IDs, labels, typed response fields, reviewer
selectors, and optional deadlines. A response is an immutable proposal; a separate
decision selects the outcome. Effect authorization binds the exact response,
evidence, and prepared intent required by the published policy. Labels grant no
authority. A deadline is due-time metadata and does not automatically decide a task.

## Events, schedules, and waits

Versioned event descriptors define typed payloads and correlation keys. Source
identity deduplicates exact redelivery; conflicting redelivery fails closed.
Subscriptions reserve their decision and canonical run identity durably before
delivery. They pin scope, principal, subscription revision, and workflow revision.
Holds require explicit retry. Webhook bindings fix the authorized project and
principal rather than accepting those choices from caller payloads.

Schedules persist firing identities before delivery and declare missed-fire
behavior. Waits pin event scope, correlation, predicate, cursor, and optional
deadline. The runtime serializes event/timeout races.

## Composition and results

Child workflows, parallel joins, and bounded maps pin child revisions, typed
inputs, and declared outputs. Stable child identities precede dispatch. Limits
are checked before admission and resource acquisition. First-success joins retain
their winner while dispatched losers settle; uncertain effects and live resource
cleanup keep their capacity until resolved.

Configured compensation is a pinned child workflow with its own receipts. It
preserves the forward outcome, waits for uncertain effects to reconcile, and does
not imply automatic rollback. Terminal result schemas validate immutable inputs
and completed receipts before success. Result reads recheck current authority and
the exact lease.

See the [Workflows module](../../apps/daemon/src/modules/workflows/README.md) for
the detailed owner contract, [execution policy](execution-access.md) for resource
authority, and [workflow interaction](workflow-interaction.md) for presentation.
