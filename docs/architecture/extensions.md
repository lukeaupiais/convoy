# Declarative extensions

Convoy extensions are reviewed declarative manifests, not dynamically loaded
daemon code. A manifest identifies a capability provider, its immutable revision,
its execution location, JSON Schema tool definitions, and the approval/audit
classification for each operation.

The Library validates and stores only reviewed manifests, then pins their exact
ID, revision, and digest into a capability-profile revision. The schema accepts
only runner execution plus a named adapter; it rejects endpoints, commands,
credentials, and arbitrary manifest fields. A runner adapter must be registered
before a pinned extension can become executable. At execution, that adapter must
revalidate capability visibility and approval while the selected local or SSH
runner enforces the same worker protocol, output limits, cancellation, and
disconnect semantics as built-in tools. An extension cannot receive provider
credentials, bypass a workspace assignment, or inherit network or filesystem
authority.

The runner package exposes an `extension` protocol operation and dispatches it
only to a locally registered adapter. The worker never receives provider
credentials or a daemon-supplied command line. An adapter receives the assigned
workspace, immutable extension reference, declared tool ID, validated arguments,
and cancellation signal. Runner probing reports installed adapter IDs, so a
pinned tool is unavailable until its selected runner proves it can execute it.

MCP servers and reviewed custom executors must therefore expose a server identity
and execution location. Their results remain correlated to the provider call and
are retained in the normal audit stream. A lost transport after a possible
mutation is uncertain and requires explicit reconciliation; Convoy never
auto-replays it.
