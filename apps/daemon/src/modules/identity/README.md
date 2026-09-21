# Identity module

Identity owns Convoy users, device sessions, workload identities, and service
principals. It verifies that a principal is currently active but does not assign
organization authority; memberships and role bindings belong to Organizations.

Service-principal credentials are returned only when created or rotated. Identity
persists only their digest and bounded expiry, and rotation invalidates the
previous credential. Credentials default to 24 hours and cannot exceed 90 days.
Administration is exposed through the common runtime command boundary, requires
organization `security.manage` authority, and projects only secret-free records
for the selected tenant. Revocation and rotation also interrupt work attributed
to that principal before another dispatch can begin.

Organizations limits machine principals to an organization `member` base role
and named-project `contributor` or `maintainer` roles. It rejects organization
owner/administrative roles and team-wide roles for service principals and
workload identities.

Workload identities are independently revocable principals intended for a
verified external federation adapter. This module deliberately does not accept a
caller-provided cloud assertion or mint a substitute workload credential; a
deployment must add an adapter that verifies its issuer, audience, subject, and
tenant binding before presenting the normalized principal to Identity.

External authentication and credential stores are adapters injected by the
control plane. Callers use only `index.mjs`.

The public surface accepts normalized, already-verified OIDC/SAML identities. It
owns subject links, controlled account linking, JIT/SCIM user provisioning, and
link revocation. It never treats a matching email address as proof that two
identities are the same user.

External deprovisioning revokes every live device session for the linked user.
The user record remains available for other organization links, but must
reauthenticate before exercising any remaining authority.
