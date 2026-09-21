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
