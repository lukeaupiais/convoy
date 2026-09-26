# Capability library

Owns tool definitions, validation schemas, skills, profiles, immutable instruction
revisions, selection, and effective visibility explanations. Definitions are
provider-neutral; adapters translate them to a provider's wire format.

Its public runtime commands are registered through the control-plane module
command registry. Library policy and library-owned state migration stay here;
the control plane only validates the public envelope, serializes commands, and
coordinates cross-domain use cases.

Capability-profile selection is a lease-authorized Library session command. The
module publishes the profile event after pinning the exact revision.

Published revisions remain immutable and sessions pin exact references. UI-hidden
tools are still revalidated by the daemon before execution.

Workflow definitions may select an exact capability-profile revision. At a new
run boundary, selection is: explicit ticket-run override, workflow profile,
existing session profile, then project default. The selected profile is copied
onto the durable session; later publications cannot change that run. A profile
never widens workflow permissions, runner support, or workspace policy.

Publication validates workflow profile ownership and declared skills. Starting a
run validates the effective profile again, including overrides. Historical
workflows with no selected profile retain legacy behavior; their skill names do
not import skills. Skills in a profile are discoverable and must be loaded by
the agent before their instructions become active.
