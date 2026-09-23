# Custom ticket source: product and architecture spec

Status: Manual read-only import foundation implemented: versioned manifest
validation, connection probe, normalized sample preview, dry run, and paged
project import bindings. Guided mapping, per-record diagnostics,
scheduling, webhook hints, outbound operations, and transformation extensions
remain future slices.

## Purpose

Convoy should let an organization connect an internal or unsupported ticket
system without adding provider-specific code to Convoy. A developer describes
an HTTP ticket source with a declarative mapping. Convoy uses one built-in
adapter to call that source and normalize its records into external ticket
observations.

This is a general integration surface. Product-specific names, endpoints, raw
status identities, credentials, and representational transformations belong to
the configured connection or adapter, not to Convoy source code. Routing into a
Convoy project, mapping remote status identities to project statuses, and field
direction belong to the ticket sync binding.

The [board integrations spec](board-integrations-spec.md) remains authoritative
for Ticket origin, external links, publishing, conflict presentation, and board
behavior. The [ticket sync bindings spec](ticket-sync-bindings-spec.md) is
authoritative for field direction and how a remote scope is persistently routed
into a Convoy project and projected onto boards. This document defines how a
custom source supplies normalized external ticket operations to those models.

## Goals

- Connect a conventional JSON-over-HTTP ticket API without writing or loading a
  Convoy adapter.
- Make the common path a guided configuration flow: connect, fetch a sample,
  map fields, preview, dry-run, and enable.
- Support deterministic, idempotent imports through stable remote identities
  and cursors.
- Keep credentials, network access, authorization, scheduling, retries,
  conflict policy, and persistence under Convoy control.
- Make read-only import useful by itself and add outbound capabilities only
  when a connection explicitly declares and passes them.
- Leave a narrow extension seam for transformations that cannot be expressed
  declaratively, without granting extension code ambient authority.

## Non-goals

- Emulating Linear, Jira, or another provider's protocol.
- Adding a named integration for each private business system.
- Letting mappings execute arbitrary code, issue arbitrary requests, or mutate
  Convoy state.
- Treating the remote system and Convoy as co-owners of every field.
- Providing ETL, general database replication, or direct database access.
- Guaranteeing immediate delivery. Scheduled pulls and webhook hints are
  eventually consistent and must be reconciled.

## Domain language

**Custom ticket source** — A provider-neutral external ticket source described
by a validated manifest and attached to a governed ticket connection.

**Source manifest** — Versioned declarative description of HTTP operations,
response selection, representation normalization, and capabilities. It
contains no credential values, Convoy project IDs, board IDs, routing policy,
or field-direction policy.

**Remote ticket observation** — Normalized, validated representation of one
remote record at a specific remote version. It is input to Work; it is not a
Convoy Ticket and cannot mutate state by itself.

**Sync cursor** — Opaque source-issued continuation value committed only after
the corresponding page has been applied durably.

**Webhook hint** — Authenticated notification that a remote identity or source
version may have changed. It causes a canonical fetch; it is not itself the
canonical ticket record.

## Ownership and dependency direction

```text
Configuration UI -> typed Convoy command
                         |
                         v
Work -> ticket sync coordinator -> custom HTTP adapter -> remote ticket API
  |              |
  |              -> cursor, attempt, and effect records
  -> bindings, tickets, external links, field direction, conflicts
```

- Work owns bindings, Tickets, external links, normalized field validation,
  field direction, routing claims, and conflict decisions.
- The control plane owns authorization, scheduling, durable attempt ordering,
  retries, and uncertain-effect reconciliation.
- The custom HTTP adapter owns manifest evaluation, HTTP protocol translation,
  response bounds, and conversion to remote ticket observations.
- The credential broker owns secret resolution. Manifests and snapshots never
  contain secret values.
- HTTP transports webhook hints but does not decide whether or how a Ticket is
  changed.
- The web UI previews configuration and sends typed commands. It never calls
  the remote source directly.

The adapter interface must remain provider-neutral. It should expose ticket
operations such as probe, list, fetch, create, update, and comment; callers must
not learn manifest selectors, authentication headers, or pagination syntax.

## Capability model

A connection declares only operations for which it has an endpoint. Convoy
derives capabilities rather than assuming full bidirectional synchronization.

| Capability | Required operation | Initial release |
| --- | --- | --- |
| Probe | `probe` or bounded `list` | Required |
| Import | `list` and stable remote identity | Required |
| Refresh one ticket | `get` | Recommended |
| Create remotely | `create` plus confirmed identity read-back | Deferred |
| Update remotely | `update` plus remote version precondition | Deferred |
| Add comment | `comment` plus idempotency key | Deferred |
| Webhook hints | `get` plus webhook identity mapping | Deferred |

The first delivery is read-only import. Absence of an outbound capability must
remove its controls rather than show a control that always fails.

## Source manifest

The current UI accepts a JSON manifest parsed into one versioned contract.
Unknown fields fail validation. YAML import/export and published manifest
revisions remain future configuration tooling. A connection stores one
validated manifest and cannot replace it after tickets have been linked.

Example:

```yaml
apiVersion: convoy.dev/v1alpha1
kind: TicketSource
metadata:
  name: Internal support

connection:
  baseUrl: https://support.example.com/api/v1
  authentication:
    type: bearer
    credential: CONVOY_TICKET_SOURCE_SUPPORT_MAIN

operations:
  list:
    method: GET
    path: tickets
    query:
      limit: "${limit}"
    response:
      items: $.items

  get:
    method: GET
    path: tickets/${remoteId}
    response:
      item: $.ticket

mapping:
  remoteId: $.id
  remoteKey: $.number
  title: $.subject
  description: $.description
  status: $.status
  priority: $.priority
  remoteVersion: $.updatedAt
  updatedAt: $.updatedAt
  url: $.url

values:
  priority:
    low: Low
    normal: Medium
    urgent: High
```

The currently implemented manual slice still accepts `values.status` and
`ownership` in the manifest for compatibility. The binding migration moves
those Convoy policy decisions into an immutable binding revision. Thereafter
the manifest emits a stable raw status ID and optional display name; manifest
enum mappings remain limited to representation normalization such as remote
priority aliases.

`credential` is a reference, never a secret value. The current manual slice
requires a `CONVOY_TICKET_SOURCE_*` environment-variable reference. Encrypted
credential-broker storage for installed and hosted deployments remains future
work.

### Allowed HTTP description

- HTTPS is required except for explicit loopback development connections.
- Methods are selected from an operation-specific allowlist.
- Paths are relative to the configured base URL.
- Template variables are limited to documented, encoded scalar values such as
  `remoteId`, `cursor`, `limit`, `requestId`, and `remoteVersion`.
- Headers have an allowlist. Authentication, `Host`, forwarding headers,
  content length, and hop-by-hop headers cannot be supplied through templates.
- Request and response bodies are JSON in the first release.
- Redirects are disabled by default. Any later redirect support must reapply
  the destination policy at every hop.
- Timeouts, page size, response bytes, item count, and concurrency have
  Convoy-owned upper bounds that a manifest cannot widen.

### Selectors and transformations

The first release supports a documented, bounded selector language for object
properties and array positions. It does not support script expressions,
recursive descent, network calls, filesystem access, or mutation.

Built-in scalar transformations may include:

- string conversion and trimming;
- ISO timestamp parsing;
- enum lookup;
- optional fallback between selectors;
- URL-template interpolation from already selected scalar fields.

Missing required values, duplicate remote identities, invalid timestamps, or
unmapped required enums reject the observation with a record-level diagnostic.
They never silently generate an identity or guess a status.

## Normalized observation

Every imported record must normalize to this conceptual shape before Work sees
it:

```ts
type RemoteTicketObservation = {
  remoteId: string;
  remoteKey: string;
  title: string;
  description: string;
  status?: { id: string; name?: string };
  priority?: string;
  url?: string;
  remoteVersion: string;
  updatedAt?: string;
  customFields?: Record<string, string | number | boolean | null>;
};
```

`remoteId` is opaque and unique within a connection. A Convoy external link is
identified by `(connectionId, remoteId)`. `remoteKey` is presentation only and
may change. `remoteVersion` must change whenever mapped canonical content
changes; sources without such a value may use a stable canonical-content digest
computed by the adapter.

## Import and reconciliation

1. The scheduler obtains a per-connection lease and records an attempt.
2. The adapter requests one bounded page using the last committed cursor.
3. It validates the envelope, normalizes every record, and returns observations
   plus the proposed next cursor.
4. Work plans the complete page: create, update, unchanged, conflict, rejected,
   or out-of-scope.
5. Work validates the batch before applying any ticket changes.
6. Convoy persists ticket changes, external link observations, diagnostics, and
   the next cursor atomically.
7. Only then may the next page be requested.

Repeating a page is safe. The same `(connectionId, remoteId, remoteVersion)` is
an unchanged observation. A cursor is never advanced past a page that Convoy
has not durably applied.

An imported ticket has `origin: external`. Remote-owned mapped fields update
when only the remote value changed. If both sides changed since the last
confirmed observation, Convoy records a visible conflict and preserves both
values for explicit resolution. Board placement is unaffected unless a
separately configured field-backed mapping owns that behavior.

An item missing from one page is not deleted or unlinked. A source must provide
an explicit deletion/tombstone observation or Convoy must confirm absence using
the configured `get` operation and scope rules before recording remote removal.

## Scheduling

- New connections begin with manual sync only.
- An administrator enables scheduled sync after a successful probe and dry run.
- The schedule has a Convoy-defined minimum interval and randomized jitter.
- Only one import attempt per connection runs at a time.
- Transient failures use bounded exponential backoff and honor a valid
  `Retry-After` within Convoy limits.
- Authentication, schema, mapping, and repeated record errors pause scheduled
  sync and require attention; they are not retried indefinitely.
- Closing a desktop-hosted coordinator stops scheduling. Continuous sync
  requires an independently supervised Convoy deployment; it does not require
  sharing persistence with the remote ticket system.

## Webhook hints

Webhook support is an optimization after polling works correctly.

- Convoy issues a connection-specific URL and secret.
- The source sends an event ID, remote ID, and optional remote version.
- Convoy authenticates the raw request body, enforces a size limit, and durably
  deduplicates the event ID.
- The hint queues `get(remoteId)`; its payload never directly overwrites a
  Ticket.
- A successful webhook does not advance the polling cursor.
- Periodic polling remains required for reconciliation.

## Outbound operations

Outbound operations are not part of the first release. When added, each must
define:

- explicit field direction and permission;
- an idempotency key derived from a durable Convoy effect;
- an optimistic remote-version precondition where supported;
- response selectors that confirm the remote identity and version;
- a read-back operation;
- `pending`, `confirmed`, `failed`, and `outcome_unknown` states;
- an explicit reconciliation action after an uncertain result.

A timeout after sending a mutation is not a failure that permits automatic
retry. Convoy must not claim success until the remote result is confirmed.

## Credentials and network safety

- Only organization administrators may create a source manifest, bind a
  credential, or enable synchronization.
- Project access does not grant access to connection credentials or raw source
  responses.
- Secrets are resolved immediately before a request and are redacted from logs,
  snapshots, previews, manifests, and errors.
- The adapter resolves and validates destinations against an organization
  network policy. It must reject loopback, link-local, cloud metadata, Unix
  socket, and private-network destinations unless an administrator has
  explicitly allowed the exact destination for that deployment.
- DNS resolution and connection establishment must not permit rebinding around
  the destination policy.
- TLS validation cannot be disabled by a manifest.
- Response media type, decompressed size, nesting depth, item count, and scalar
  length are bounded before mapping.
- Previewed raw data is access-controlled, size-bounded, and not retained by
  default because ticket payloads may contain sensitive information.

## Configuration experience

The source-connection flow is:

```text
Name and base URL
  -> authentication
  -> fetch sample
  -> map remote identity and fields
  -> validate
  -> save connection
  -> configure scope, project routing, field direction, and schedule through a
     ticket sync binding
```

The UI should provide:

- a raw-response and normalized-ticket preview;
- field selection from the fetched sample rather than requiring selector entry
  for every field;
- clear required-field and enum diagnostics tied to the offending record;
- a dry-run summary of would-create, would-update, unchanged, conflict, and
  rejected counts;
- manual **Sync now** before scheduling is offered;
- last successful sync, cursor age, next scheduled attempt, and actionable
  failure state;
- manifest export and import for review and promotion between deployments.

The UI must not display recurring success text on tickets. Healthy external
links remain quiet; attention appears only for conflicts, paused sync,
authorization loss, rejected records, or uncertain effects.

## Optional transformation extension

Declarative mapping is the supported first release. A later reviewed extension
may implement only this pure interface:

```ts
type TicketTransformer = {
  transform(input: unknown): RemoteTicketObservation;
};
```

It receives one parsed JSON value and deterministic manifest parameters. It has
no network, filesystem, clock, random, credential, process, or Convoy-state
access. Convoy applies CPU, memory, input, and output limits and validates the
result exactly as it validates declarative output.

This extension changes representation only. It cannot schedule requests,
select authorization, persist cursors, resolve conflicts, or execute outbound
effects. Until that containment exists, developers must transform unusual data
behind their own conventional HTTP endpoint rather than load code into Convoy.

## Observability and audit

Each attempt records:

- connection and pinned manifest revision;
- trigger: manual, scheduled, webhook, or reconciliation;
- start and completion times;
- input and committed cursors, stored as opaque bounded values;
- counts by outcome;
- bounded diagnostics without credentials or full sensitive payloads;
- the requesting principal for manual and configuration actions.

Audit records distinguish configuration, credential binding, schedule changes,
manual sync, conflict resolution, and outbound effects. Disabling or deleting a
connection stops new work but does not erase Tickets, external links, attempts,
or audit history.

## Delivery slices

### Slice 1: read-only manual import

- Versioned manifest validation.
- Bearer and static-header credential references through the credential broker.
- Bounded JSON HTTP list/get operations.
- Declarative field and enum mapping.
- Probe, sample preview, dry run, and manual import.
- Stable identity, remote version, external links, and remote-owned fields.

The current manual slice rejects a malformed or duplicate page atomically. It
does not yet persist per-record diagnostics or cursors.

### Slice 2: scheduled reconciliation

- Per-connection leases, schedules, jitter, backoff, and paused states.
- Durable attempts and sync history.
- Incremental cursors and periodic bounded full reconciliation.

### Slice 3: webhook hints

- Connection-specific authenticated ingress.
- Durable event deduplication and canonical fetch.

### Slice 4: controlled outbound capabilities

- Create, update, and comment operations individually.
- Idempotency, version preconditions, read-back, effect ledger, and explicit
  reconciliation.

### Slice 5: contained transformation extension

- Only after a deterministic resource-limited runtime and review model exist.

## Acceptance scenarios

1. An administrator supplies a conventional paged JSON endpoint, selects sample
   fields, and previews a valid normalized ticket without exposing the token.
2. A dry run reports changes but writes no Ticket, external link, cursor, or
   remote data.
3. Importing the same page twice creates one Convoy Ticket per remote identity
   and does not duplicate external links.
4. A process stops after applying a page but before requesting the next page.
   On restart, the committed cursor resumes without losing or duplicating work.
5. One malformed record produces a bounded diagnostic. The page does not
   partially apply or advance its cursor.
6. A remote-owned title changes remotely and has not changed locally. Import
   updates it and records the new remote version.
7. A mapped field changes both remotely and locally. Import preserves the local
   value, records both observations, and requires explicit conflict resolution.
8. A ticket disappears from a list page. Convoy does not infer deletion.
9. A webhook is delivered twice. Convoy stores one hint and canonical fetch;
   polling still reconciles the source later.
10. A manifest attempts to call a disallowed network destination or inject an
    authentication header. Validation rejects it before any request.
11. A credential is revoked. Scheduled sync pauses, existing tickets and links
    remain, and an administrator sees the required action.
12. A read-only connection exposes no create, update, comment, or close control.

## Required implementation decisions

Before Slice 1 implementation begins, decide and record:

1. The exact selector grammar and its complexity limits.
2. Whether one malformed record rejects a whole page, as specified here, or is
   quarantined while the rest commit. The safer default is whole-page rejection.
3. The normalized priority vocabulary and behavior for unmapped optional
   values. Stable remote status identity and project mapping are defined by the
   ticket sync binding specification.
4. Cursor maximum size and whether cursors require encryption at rest.
5. The deployment-level network policy and explicit private-destination
   authorization model.
6. Manifest publication, review, and rollback permissions.
7. Retention limits for attempt diagnostics and sample previews.
