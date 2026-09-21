# Organizations module

Organizations owns tenant records, teams, memberships, invitations, role bundles,
and active-context authorization. Every lookup is tenant-scoped. Identity status
and project catalogs are injected through narrow interfaces; this module does not
import sibling implementations.

Callers use only `index.mjs`. Authorization is recomputed from current state, so
cached context claims cannot preserve revoked authority.

Enterprise identity-provider policy, verified domains, JIT/SCIM enablement, and
IdP group mappings are organization records. Protocol adapters must pass the
injected provisioning-authority check before managed memberships can change.
Externally managed membership never grants the organization owner role and does
not overwrite manually managed access.

The control plane must revalidate membership immediately before provider or
runner dispatch. Deprovisioning suspends every membership owned by that IdP so a
cached context cannot authorize queued work.

Domain verification challenges are issued once and stored only as digests. A DNS or HTTP adapter
returns the observed challenge through the injected verification port; only then
may that domain be attached to an enterprise identity provider.
