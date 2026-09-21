# Execution

Owns environments, repository runners, pools, placement eligibility, assignment,
capacity, and retained command evidence. It does not own provider conversations or
workflow transitions.

Local and SSH runners must expose equivalent behavior. Never reroute an attempt
after provisioning may have begun without explicit reconciliation.

Runner, environment, placement, and scheduler commands are registered through
the control-plane module command registry. Session command and terminal control
uses the session command registry after runtime verifies the control lease.

`createExecution` also exposes two domain-only interfaces:

- `access` owns organization-scoped environment and runner-pool bindings. Placement
  requires an applicable `use` or `administer` binding and applies its profile,
  repository, and schedule constraints before considering runner capacity.
- `enrollment` issues short-lived, single-use, organization/environment-scoped
  bearer tokens and exchanges them for bounded runner machine identities after
  attestation. Redemption returns a machine credential once; only its digest is
  retained. Rotation replaces the credential immediately and revocation takes
  the runner offline. Raw credentials are never returned in snapshots.
- `channelGrants` owns short-lived terminal and direct-channel grants pinned to
  the actor, tenant, project, session, runner, environment, workspace, control
  lease, and execution-grant digest. `runnerChannels` is the fail-closed
  runner-facing validator and requires both the runner machine credential and
  the exact channel grant. Renewal rotates the grant token; revocation and any
  live binding change invalidate it.
- `capacity` owns organization- and pool-scoped capacity demand evidence. It
  records desired versus observed capacity, manual drain state, immutable
  runtime/image revisions, authority ceilings, and budget ceilings. Its provider
  port is deliberately observation-only: placement can report exhaustion, but
  it cannot create, scale, drain, or destroy runners.

The only production capacity provider is `static`. The deterministic fake
adapter exists for contract and acceptance testing and exposes the same
observation-only surface. Adding automatic capacity lifecycle operations requires
a separate approved specification; those methods must not be added to placement.

HTTP and the control plane may adapt these interfaces, but authorization and
token-state decisions remain inside this module. Enrollment does not use SSH host
credentials and cannot widen its configured authority ceiling or self-assign
projects and pools.

The current native terminal adapter still returns an OS-local tmux/SSH attach
descriptor to an already authenticated client. Runtime wraps every descriptor
response in a short-lived terminal grant, but tmux and SSH cannot themselves
enforce that application token. Deployments must therefore treat access to the
daemon OS account and SSH agent as an outer trust boundary until the direct
runner channel consumes `runnerChannels` before attach.
