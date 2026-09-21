# Module command registry

Each public runtime command has one authoritative domain-module owner. At daemon
composition, a module registers its ID, command names, and one command handler.
The control plane rejects duplicate ownership before serving requests.

The runtime still performs executable envelope validation and retains command
serialization, leases, approval enforcement, and cross-module transactions.
The registry is not a plugin loader and it does not permit dynamically loaded
daemon code. A module remains reviewed source composed by bootstrap.

Each module owns its state initialization and additive migrations. The control
plane owns only state and ledgers that are intrinsically cross-domain, such as
workflow-effect reconciliation. Persisting all slices atomically is intentional;
separate databases or processes are not required for module ownership.

Library, Work, Execution, and Workflows are the first adopters. At composition,
the registry checks every public command: it must be module-owned or explicitly
listed as control-plane orchestration. New module-owned commands should follow
their pattern instead of adding another domain branch to `runtime.mjs`. Work uses
an injected completed-mutation observation port for workflow triggers; this keeps
ticket and board authority in Work while the workflow coordinator retains trigger
and recovery policy. Execution keeps runner, environment, placement, and
scheduler commands together, while session command and terminal control remain
lease-authorized session operations. Workflows owns definition publication and
drafts; active runs remain orchestration because they span multiple owners.

Session commands use a second registry. Runtime resolves the durable session and
renews the control lease before dispatching it to the module owner. Conversations
uses this for ticket linking, assignment/delegation, release, and context
checkpoints. This preserves one common authority gate without placing
conversation policy in the control plane.

Workflows also uses the session registry for active-run start/stop, decisions,
trigger retries, and effect reconciliation. The control plane continues to
inject runner cancellation and cross-module effect ports; Workflow policy never
needs to know HTTP clients or lease storage.

Agents uses it for approval decisions and pending-question answers. Provider
transport and turn scheduling remain coordinator concerns, while the durable
turn policy remains a module concern.

Public snapshots are composed from module-owned snapshot contributions. The
control plane adds only session-control facts and cross-domain recovery ledgers;
it does not reconstruct module read models from private storage.
