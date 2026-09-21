# Model providers, organizations, and client access

Status: implemented platform foundation. The tenant, provider, client,
authorization, remote-runner, audit, and static-capacity contracts in this
specification are implemented. Automatic capacity provisioning and scaling remain
intentionally out of scope. Provider-specific cloud adapters and native-host/live
certification are tracked separately from the common governed platform contract.

## 1. Goals

Convoy must:

1. support personal subscriptions, enterprise subscriptions, direct model APIs,
   intermediate gateways, and local or self-hosted models through one model
   routing contract;
2. let one person use personal, team, and enterprise resources without copying
   credentials between clients or confusing tenant context;
3. allow browser, desktop, CLI, IDE, and automation clients to connect to local,
   hosted, self-hosted, or air-gapped Convoy deployments;
4. preserve organization isolation, exact authorization, explicit approvals,
   session leases, immutable revision pinning, auditability, and fail-closed
   behavior;
5. keep provider credentials in the control plane and host credentials in the
   execution adapter that owns them;
6. preserve equivalent agent behavior across local and SSH runners;
7. leave a stable placement and capacity seam for future automatically
   provisioned and scaled runners without implementing auto-scaling now; and
8. keep personal use simple by expressing it as the smallest instance of the same
   organization model rather than maintaining a separate product architecture.

## 2. Non-goals

This specification does not:

- implement automatic runner provisioning, scaling, draining, or destruction;
- make provider failover safe for non-idempotent turns without reconciliation;
- expose provider or SSH credentials to agents or runners;
- embed Codex CLI, Claude Code, OpenCode, Pi, or another agent harness;
- allow a client to authorize itself from locally cached role claims;
- treat a provider catalog entry as proof that an account can invoke that model;
- permit organization policy to be weakened at team, project, session, or runner
  scope; or
- make direct runner connectivity the source of control-plane authority.

## 3. System model

The client connects to a Convoy deployment. It does not connect directly to a
team, model provider, environment, runner, or SSH host.

```text
Browser / Desktop / CLI / IDE / Automation
                    |
                    | deployment discovery + user authentication
                    v
+------------------------------------------------------------------+
| Convoy deployment                                                |
|                                                                  |
| identity -> membership -> active context -> authorization        |
|                                      |                           |
|                                      +-> model-route resolution  |
|                                      +-> execution placement     |
|                                      +-> policy and audit         |
+--------------------------+--------------------------+-------------+
                           |                          |
                           v                          v
                  provider adapters          runner adapters
                  API/subscription/          local/SSH/future
                  gateway/local model        capacity providers
```

The authoritative hierarchy is:

```text
Deployment
└── Organization
    ├── Memberships and organization roles
    ├── Teams and team memberships
    ├── Projects and project memberships
    ├── Provider connections and model routes
    ├── Environments, runner pools, and access bindings
    ├── Policies and approval rules
    └── Audit records
```

An environment is an execution resource. A team is a membership group. A project
is the working scope in which sessions, tickets, repositories, instructions,
model routes, and execution defaults meet.

## 4. Canonical domain model

### 4.1 Identity and tenancy

```ts
type Deployment = {
  id: string;
  displayName: string;
  issuer: string;
  publicOrigin: string;
  capabilities: string[];
  authenticationMethods: AuthenticationMethod[];
  minimumClientVersion?: string;
};

type User = {
  id: string;
  displayName: string;
  primaryEmail?: string;
  state: 'active' | 'suspended' | 'deleted';
};

type Organization = {
  id: string;
  slug: string;
  displayName: string;
  kind: 'personal' | 'team' | 'enterprise';
  state: 'active' | 'suspended';
  policyRevision: string;
};

type Team = {
  id: string;
  organizationId: string;
  slug: string;
  displayName: string;
  state: 'active' | 'archived';
};

type Membership = {
  id: string;
  organizationId: string;
  principal: PrincipalRef;
  scope: OrganizationRef | TeamRef | ProjectRef;
  roles: string[];
  state: 'invited' | 'active' | 'suspended' | 'revoked';
  revision: string;
};

type PrincipalRef =
  | { kind: 'user'; userId: string }
  | { kind: 'service-principal'; servicePrincipalId: string }
  | { kind: 'workload'; workloadIdentityId: string };
```

Every tenant-owned record carries `organizationId`. Team and project identifiers
never substitute for that tenant key. Identifiers are globally unique even when
storage is physically partitioned.

### 4.2 Client state

```ts
type ClientProfile = {
  deploymentId: string;
  serverOrigin: string;
  displayName: string;
  trustedServerIdentity: string;
  deviceId: string;
  secureCredentialReference: string;
  lastContext?: ContextRef;
};

type ActiveContext = {
  deploymentId: string;
  userId: string;
  organizationId: string;
  teamId?: string;
  projectId: string;
  membershipRevision: string;
  policyRevision: string;
};
```

`ClientProfile` is device-local. `ActiveContext` is explicitly selected and
server-validated. Neither grants model or execution authority by itself.

### 4.3 Model resources

```ts
type ModelProvider = {
  id: string;
  adapterKind: string;
  displayName: string;
  protocol: ProviderProtocol;
  adapterCapabilities: ProviderAdapterCapability[];
};

type ProviderConnection = {
  id: string;
  organizationId: string;
  providerId: string;
  displayName: string;
  owner: UserRef | TeamRef | OrganizationRef;
  endpoint?: EndpointRef;
  credentialRef: SecretReference;
  state: 'pending' | 'ready' | 'degraded' | 'revoked';
  governance: ProviderConnectionGovernance;
  revision: string;
};

type ModelOffering = {
  id: string;
  providerConnectionId: string;
  upstreamModelId: string;
  displayName: string;
  verifiedCapabilities: ModelCapabilities;
  availability: 'unverified' | 'available' | 'unavailable' | 'degraded';
  observedAt?: string;
  catalogRevision: string;
};

type ModelRoute = {
  id: string;
  organizationId: string;
  name: string;
  selectors: ModelRouteSelector[];
  candidates: ModelRouteCandidate[];
  policy: ModelRoutePolicy;
  revision: string;
};

type ProviderGrant = {
  id: string;
  organizationId: string;
  sessionId: string;
  turnId: string;
  providerConnectionId: string;
  modelOfferingId: string;
  routeRevision: string;
  connectionRevision: string;
  policyRevision: string;
  expiresAt: string;
  digest: string;
};
```

These concepts are intentionally distinct:

| Concept             | Meaning                                         | Does not mean            |
| ------------------- | ----------------------------------------------- | ------------------------ |
| Model provider      | Protocol/inference system with an adapter       | Account or credential    |
| Provider connection | Authorized account or endpoint configuration    | Model selection          |
| Model offering      | Verified model available through one connection | Globally available model |
| Model route         | Logical policy-controlled model target          | Stored secret            |
| Provider grant      | Resolved authority for one session/turn         | Long-lived credential    |

### 4.4 Execution resources

Existing `Environment`, `Runner`, `Runner pool`, `Placement policy`, `Execution
profile`, and `Execution grant` definitions remain authoritative. Multi-tenancy
adds organization ownership and governed access:

```ts
type EnvironmentAccessBinding = {
  id: string;
  organizationId: string;
  subject: UserRef | TeamRef | ProjectRef;
  resource: EnvironmentRef | RunnerPoolRef;
  role: 'use' | 'administer';
  constraints?: {
    executionProfiles?: string[];
    repositoryPatterns?: string[];
    schedules?: string[];
  };
  revision: string;
};
```

Membership makes a principal eligible to receive authority. A resource binding
authorizes use of a governed resource. Placement selects an eligible runner. The
execution grant pins the final authority. These steps must not be collapsed.

## 5. Provider support matrix

All provider types use the same provider-connection and model-route contracts,
but their authentication, discovery, support guarantees, and governance differ.

| Provider class          | Examples                                          | Credential owner               | Discovery                      | Key constraints                                                          |
| ----------------------- | ------------------------------------------------- | ------------------------------ | ------------------------------ | ------------------------------------------------------------------------ |
| Personal subscription   | ChatGPT/Codex-style user subscription             | User                           | account probe                  | Personal terms, user lifecycle, unstable private protocols               |
| Enterprise subscription | Organization-negotiated seat or tenant            | Organization or delegated user | tenant/account probe           | SSO, seat assignment, enterprise retention and region policy             |
| Direct API              | OpenAI, Anthropic, Google, Mistral                | User, team, or organization    | provider catalog plus probes   | API keys/OAuth, quotas, spend controls, data-processing terms            |
| Intermediate gateway    | OpenRouter, LiteLLM, cloud AI gateways            | Team or organization           | gateway catalog plus probes    | upstream identity, model remapping, pass-through policy, double metering |
| Cloud platform          | Azure OpenAI, AWS Bedrock, Vertex AI              | Organization                   | cloud control plane            | workload identity, region/deployment IDs, cloud IAM                      |
| Local endpoint          | Ollama, llama.cpp, local OpenAI-compatible server | User or project                | endpoint probe                 | machine availability, no assumed TLS, local resource pressure            |
| Self-hosted inference   | vLLM, TGI, enterprise inference cluster           | Team or organization           | configured endpoint plus probe | private CA, network placement, capacity and model lifecycle              |

Support is capability-based rather than provider-name-based. An adapter declares
what its protocol can represent; a model offering records what was actually
verified for one connection.

### 5.1 Provider protocols

Initial protocol adapter kinds should include:

- OpenAI Responses;
- Anthropic Messages;
- Google Generative Language or Vertex model invocation;
- OpenAI-compatible chat/responses endpoints where compatibility is probed rather
  than assumed;
- AWS Bedrock model invocation;
- Convoy-owned ChatGPT subscription transport; and
- a deterministic fake used only by tests.

An intermediate provider receives its own adapter when it has provider-specific
authentication, routing, errors, metadata, or billing semantics. It must not be
misrepresented as a transparent direct provider merely because its payload is
OpenAI-compatible.

### 5.2 Adapter interface

The provider adapter seam should remain small and deep:

```ts
interface ProviderAdapter {
  inspectConnection(input: ConnectionInspection): Promise<ConnectionEvidence>;
  discoverModels(input: ModelDiscoveryRequest): Promise<ModelDiscoveryResult>;
  generate(input: NormalizedModelTurn): AsyncIterable<NormalizedProviderEvent>;
}
```

Credential acquisition and storage are not methods on this interface. A credential
broker supplies a purpose-bound secret to the adapter internally. Route selection,
spend policy, approvals, retries, and agent tool execution remain outside the
adapter.

The normalized turn contains the chosen upstream model, system and user content,
provider-neutral tool definitions, modality inputs, generation controls, and
trace metadata. Normalized events cover text/reasoning deltas, tool calls, usage,
finish reason, provider request identity, and structured failure evidence.

Adapters must:

- speak the provider protocol directly;
- never execute tools;
- never own the agent loop or conversation history policy;
- preserve provider request IDs and actionable failure metadata;
- bound response/error capture and redact secrets;
- support cancellation where the upstream protocol permits it;
- report indeterminate completion separately from a proven rejection; and
- avoid silently translating unsupported generation controls.

### 5.3 Model capabilities

Capabilities are evidence attached to a model offering, not assumptions attached
only to a provider brand:

```ts
type ModelCapabilities = {
  inputModalities: Array<'text' | 'image' | 'audio' | 'file'>;
  outputModalities: Array<'text' | 'image' | 'audio'>;
  toolCalls: 'none' | 'single' | 'parallel';
  structuredOutput: boolean;
  reasoning: boolean;
  contextWindow?: number;
  maximumOutputTokens?: number;
  streaming: boolean;
  promptCaching?: 'none' | 'automatic' | 'explicit';
  dataResidencies?: string[];
};
```

Each field has a source such as provider catalog, configured assertion, active
probe, or observed successful use. Policy may require fresh probe evidence before
making a model eligible.

### 5.4 Authentication methods for provider connections

Supported methods include:

- user OAuth/device authorization for personal subscriptions;
- delegated enterprise OAuth where the provider supports it;
- API keys and provider-specific tokens;
- cloud workload identity, instance identity, or role assumption;
- client certificate/mTLS identity;
- static endpoint with no application credential for a trusted local network; and
- external secret reference resolved by an enterprise secret manager.

Provider authentication is not Convoy user authentication. `Connect ChatGPT`, for
example, creates or refreshes a provider connection; it does not sign the person
into the Convoy deployment.

### 5.5 Credential broker

The credential broker owns secret acquisition and controlled release:

```ts
interface CredentialBroker {
  resolve(input: {
    organizationId: string;
    providerConnectionId: string;
    purpose: 'inspect' | 'discover-models' | 'generate';
    actor: PrincipalRef;
    sessionId?: string;
    turnId?: string;
  }): Promise<PurposeBoundCredential>;
}
```

Rules:

- secrets are encrypted at rest and never included in snapshots, logs, prompts,
  worker messages, environment variables, or audit payloads;
- clients receive connection state and evidence, never credential material;
- purpose-bound credentials have the shortest practical lifetime;
- externally managed secrets retain an external reference and version, not a
  copied plaintext value;
- access is checked against current membership, policy, and connection scope at
  resolution time;
- refresh is serialized per credential to avoid token races;
- credential rotation increments the provider-connection revision; and
- revocation prevents new grants and invalidates queued work before dispatch.

### 5.6 Connection ownership and sharing

A connection has exactly one owner scope:

- user-owned: visible only to that user unless organization policy permits a
  narrowly defined delegation;
- team-owned: usable by authorized projects and members of that team; or
- organization-owned: centrally governed and usable only through explicit policy
  or resource bindings.

Personal subscription credentials must not become a de facto organization secret.
The organization may allow personal connections, restrict them to personal
projects, allow them for selected projects, or forbid them entirely.

### 5.7 Model routing

Users and projects select a logical route such as `coding-default`,
`review-high-reasoning`, or `private-eu`. They should not normally pin raw
credentials or endpoints.

```text
requested route
  -> active organization/project policy
  -> principal may-use checks
  -> capability and residency constraints
  -> connection health/quota/budget checks
  -> ordered eligible candidates
  -> selected connection + model offering
  -> immutable provider grant
```

A route candidate can constrain provider, connection, offering, region,
capabilities, price class, latency class, ownership scope, and data policy.

Resolution must be deterministic from recorded inputs. The resulting provider
grant records route, policy, catalog, and connection revisions so a later catalog
or policy edit cannot rewrite an in-flight turn.

### 5.8 Fallback and retry

Provider transport failure does not automatically make replay safe. Convoy records
one of:

- `not-sent`: safe to select another candidate;
- `rejected`: provider proved no model turn began; policy may retry;
- `interrupted-known`: provider request was cancelled with a known outcome;
- `uncertain`: provider may have consumed or generated the turn; reconciliation or
  explicit user decision is required; or
- `completed`: normalized terminal response and usage were captured.

Fallback never crosses organization, data-residency, confidentiality, ownership,
or budget restrictions. A route may forbid fallback entirely. Convoy never merges
partial responses from different models into one turn silently.

### 5.9 Cost, quota, and governance

Policy can constrain:

- allowed providers, connections, models, and regions;
- personal versus organization-funded connections;
- maximum input/output tokens and context size;
- per-turn, per-project, per-user, per-team, and organization budgets;
- daily/monthly quota and concurrency;
- acceptable data retention/training classifications;
- required zero-data-retention or enterprise contract evidence;
- whether prompts, tool schemas, files, images, or repository excerpts may leave
  an approved network boundary; and
- fallback and degraded-mode behavior.

Estimated cost is advisory. Provider-reported usage and invoices are observations,
not substitutes for Convoy authorization records. Gateway and upstream costs must
remain distinguishable when both are available.

## 6. Deployment discovery and client connection

### 6.1 Discovery

Every remotely reachable deployment exposes an unauthenticated, non-sensitive
document at `/.well-known/convoy`:

```json
{
  "deploymentId": "dep_...",
  "displayName": "Acme Convoy",
  "issuer": "https://convoy.acme.example",
  "authenticationMethods": ["oidc-pkce", "device-code"],
  "capabilities": ["organizations", "remote-execution"],
  "minimumClientVersion": "...",
  "publicKeysUrl": "https://convoy.acme.example/.well-known/jwks.json"
}
```

The client binds the saved profile to `deploymentId`, issuer, origin, and trusted
server identity. Redirects or certificate changes cannot silently retarget a saved
profile.

### 6.2 Human login

- Browser clients use secure, `HttpOnly`, `SameSite` cookies backed by a
  server-side session.
- Desktop and CLI clients prefer OAuth Authorization Code with PKCE.
- CLI clients without a browser use device authorization where available.
- Local personal deployments may use a loopback-only bootstrap ceremony that
  creates the first user and binds the local device.
- Self-hosted deployments may use an enterprise CA and private identity provider.

Refresh credentials are device-specific, revocable, and stored in the OS keychain
or equivalent secure store. Access tokens are short-lived and audience-bound.

### 6.3 Workload login

Automation uses a service principal or federated workload identity. It does not
reuse a human refresh token. Workload credentials are restricted to named
organizations/projects, actions, environments, model routes, and time bounds.

### 6.4 Context selection

After login the client retrieves the contexts currently available to the
principal, selects an organization/team/project, and receives a server-validated
active context.

```text
deployment profile
  + authenticated identity
  + current memberships
  + selected organization/team/project
  = active client context
```

Every command carries the context identifier. The server reauthorizes the command
against current state; signed claims and cached UI state are not sufficient.

The UI and CLI display the full context prominently:

```text
Acme Convoy / Acme Corp / Platform / Payments API
```

Context is never inferred solely from a project slug, directory, last-used model,
or runner. Destructive and full-access operations repeat the organization,
project, host/environment, and profile in the approval presentation.

### 6.5 Personal bootstrap

A new local installation creates:

1. the deployment identity;
2. the first local user;
3. one implicit personal organization;
4. one default team/project if needed by the interface; and
5. a device session for the initiating client.

The personal organization uses the same records and authorization paths as every
other organization. The UI may hide unnecessary hierarchy, but the domain does
not branch into a separate single-user mode.

### 6.6 Invitations and enterprise provisioning

An invitation is single-use, short-lived, organization-scoped, auditable, and
optionally bound to an email or verified domain. Accepting it requires
authentication and creates a membership; the invitation itself is not a session.

Enterprise deployments support:

- OIDC and SAML federation;
- just-in-time provisioning when allowed;
- SCIM user/group provisioning and deprovisioning;
- IdP group-to-role or group-to-team mapping;
- organization-required MFA and authentication strength;
- domain verification and controlled account linking; and
- emergency administrator access with separately audited recovery controls.

Identity-provider groups supply membership facts. Convoy remains authoritative
for Convoy resource roles, project grants, approvals, execution profiles, and
provider/environment bindings unless an explicit mapping owns them.

### 6.7 Multiple organizations and deployments

One client may hold several deployment profiles and a user may belong to several
organizations. The identities may be linked for convenience but remain separate
security principals per deployment.

An invitation to a different deployment creates a new deployment profile. No
credential, context, connection, policy, or audit record is shared merely because
the same email address appears in both deployments.

## 7. Authorization and policy

### 7.1 Role bundles

Initial human-readable roles are:

| Scope        | Roles                                                       |
| ------------ | ----------------------------------------------------------- |
| Organization | owner, admin, security-admin, billing-admin, member, viewer |
| Team         | admin, member, viewer                                       |
| Project      | owner, maintainer, contributor, viewer                      |

Roles are versioned bundles of fine-grained permissions. Domain modules authorize
commands using permissions, not hard-coded role names. Custom enterprise roles may
compose existing permissions without changing module interfaces.

### 7.2 Effective authorization

```text
authenticated principal
  + active membership permissions
  + resource access binding
  + organization policy
  + team/project policy
  + current session/control lease
  + immutable provider or execution grant
  = allow, ask, or deny
```

Parent policy is a ceiling. Child scopes may narrow but never widen it. Saved
approvals may satisfy `ask`; they never override `deny`.

### 7.3 Revocation

- User suspension or membership revocation blocks new commands immediately.
- Membership and policy changes increment revisions checked on every mutation and
  stream renewal.
- Pending provider and execution dispatches are revalidated before sending.
- Active control leases and grants are revoked or allowed to reach a specifically
  documented safe point according to policy.
- Long-lived streams require periodic authorization renewal.
- Offline clients may read explicitly marked cached metadata but cannot mutate.

### 7.4 Tenant isolation

Every lookup and mutation is organization-scoped at the owning module interface,
not appended only in HTTP or UI code. Cross-tenant identifiers return the same
non-disclosing failure as absent resources.

Storage may use shared tables with enforced tenant keys, schemas, databases, or
separate deployments. The logical guarantees are identical. Enterprise policy may
require a physical isolation strategy or data region.

## 8. Remote environments and runners

### 8.1 User access path

Users do not receive SSH credentials or connect the Convoy client directly to a
runner:

```text
client command
  -> context and permission check
  -> project placement policy
  -> environment access binding
  -> runner eligibility and attestation
  -> immutable execution grant
  -> assignment lease
  -> local/SSH worker protocol
```

For an interactive terminal, the control plane issues a short-lived terminal
grant bound to the user, organization, project, session, runner, workspace,
audience, permissions, and expiry. A performance-oriented direct data channel is
permitted only after grant validation; control, renewal, revocation, and audit
remain authoritative in the control plane.

### 8.2 Runner enrollment

Runner identity is separate from user and provider identity:

```text
environment administrator
  -> short-lived single-use enrollment token
  -> runner establishes outbound authenticated channel
  -> control plane verifies attestation
  -> runner receives rotatable machine identity
  -> runner joins an allowed environment/pool
```

Enrollment tokens are scoped to one organization, environment, authority ceiling,
platform expectations, and expiry. Runners cannot self-assign projects, increase
their maximum authority, or move between organizations.

### 8.3 Execution profiles

The existing profiles remain the canonical user-facing permission modes:

- `plan`;
- `ask`;
- `edit`;
- `auto`;
- `dont-ask`;
- `full-access-ask`;
- `full-access`; and
- `deny`.

`auto` remains contained. `full-access` means operating-system-user authority on
a trusted runner and does not bypass organization policy, approvals required for
project/business mutations, leases, audit, quotas, cancellation, or uncertain
mutation reconciliation.

### 8.4 Static capacity now, scalable capacity later

The current capacity provider is:

```ts
type StaticCapacityProvider = { kind: 'static' };
```

The future seam may add:

```ts
type CapacityProvider =
  | StaticCapacityProvider
  | {
      kind: 'provisioned';
      adapterKind: string;
      configurationRef: string;
      minimum: number;
      maximum: number;
      idlePolicy: string;
    };
```

No domain caller receives `createVm`, `createPod`, or vendor-specific methods.
Placement asks the capacity module for eligible capacity; an adapter later hides
provisioning technology behind that seam.

Future scaling must preserve:

- organization and pool ownership;
- immutable image/runtime revision;
- runner identity and attestation;
- repository/workspace affinity;
- maximum-authority ceilings;
- capacity and spend budgets;
- drain-before-destroy semantics;
- session and assignment lease ownership;
- uncertain-mutation reconciliation; and
- no automatic replay after worker loss.

## 9. Module ownership and dependency direction

The target modules should own:

| Module        | Authoritative responsibility                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| Identity      | users, device sessions, external identity links, workload identities                                       |
| Organizations | organizations, teams, memberships, invitations, role bindings                                              |
| Providers     | provider connections, model offerings, model routes, provider grants, cost/quota observations              |
| Execution     | environments, access bindings, runners, pools, placement, assignments, execution grants, capacity requests |
| Work          | organization-scoped projects, tickets, and boards                                                          |
| Conversations | organization/project-scoped dialogue, sessions, and steering                                               |
| Agents        | prompt/context composition and provider-neutral model-facing policy                                        |
| Library       | tools, skills, profiles, and instruction revisions                                                         |
| Workflows     | graph definitions, publication, and run transitions                                                        |

The control plane coordinates a use case across these owners. Transport parses and
serializes. Adapters implement external protocols. Shared contracts contain data
shapes only and import no application.

Sibling daemon modules use each other's `index.mjs` interfaces. The web imports
contracts and feature public surfaces, never daemon/provider/runner implementation.

### 9.1 Deep interfaces

Representative module interfaces are intentionally smaller than their internal
state:

```ts
interface ContextAccess {
  listAvailableContexts(principal: PrincipalRef): Promise<ContextSummary[]>;
  resolveContext(principal: PrincipalRef, requested: ContextRef): Promise<ActiveContext>;
  authorize(context: ActiveContext, action: ActionRef, resource: ResourceRef): Promise<Decision>;
}

interface ModelRouting {
  listEligibleRoutes(context: ActiveContext, purpose: ModelPurpose): Promise<ModelRouteSummary[]>;
  resolveGrant(request: ModelGrantRequest): Promise<ProviderGrant>;
  recordOutcome(grantId: string, outcome: ProviderOutcome): Promise<void>;
}

interface ExecutionPlacement {
  resolveGrant(request: ExecutionGrantRequest): Promise<ExecutionGrant>;
  assign(grant: ExecutionGrant): Promise<Assignment>;
  reconcile(assignmentId: string, evidence: ReconciliationEvidence): Promise<Assignment>;
}
```

Callers do not choose credentials, provider endpoints, SSH commands, runner
transports, or capacity vendor operations.

## 10. Public protocol surfaces

Exact URLs may change, but the transport must expose equivalent operations:

```text
GET  /.well-known/convoy

POST /auth/login
POST /auth/device
POST /auth/refresh
POST /auth/logout
GET  /identity

GET  /contexts
POST /contexts/resolve

GET  /organizations/:id
GET  /organizations/:id/teams
POST /organizations/:id/invitations
POST /invitations/:token/accept

GET  /provider-connections
POST /provider-connections
POST /provider-connections/:id/authenticate
POST /provider-connections/:id/probe
POST /provider-connections/:id/rotate
POST /provider-connections/:id/revoke
GET  /model-routes

GET  /environments
GET  /runner-pools
POST /runner-enrollments
```

HTTP does not make domain authorization decisions. Commands resolve through the
same module interfaces whether initiated by web, desktop, CLI, IDE, or automation.

## 11. Audit and observability

Every security-relevant event includes, where applicable:

- deployment, organization, team, and project IDs;
- actor principal, authenticated identity, device or workload identity;
- membership, policy, route, connection, profile, and grant revisions;
- provider, connection, model offering, provider request ID, and outcome class;
- environment, runner, pool, workspace, assignment, and execution-grant digest;
- command/action, authorization decision, approval identity, and control lease;
- timestamps, trace ID, bounded usage/cost observations, and redaction metadata.

Audit records never contain access tokens, refresh tokens, API keys, private keys,
raw secret-manager payloads, or unredacted provider error bodies. Organization
policy defines retention and export; security administrators cannot edit history.

Operational metrics distinguish control-plane, provider, route, environment,
runner, and capacity failures so a provider outage is not presented as a runner
failure or vice versa.

## 12. Failure and edge-case requirements

The implementation must handle at least these cases:

1. A user is removed while an agent turn or terminal is active.
2. A team membership changes while the client holds a cached context.
3. Two organizations contain projects with the same slug.
4. A personal provider token expires during a streamed response.
5. An organization revokes personal connections while sessions reference one.
6. A gateway remaps or removes an upstream model without notice.
7. A provider accepts a request and disconnects before terminal evidence.
8. A route's first candidate fails but fallback violates data residency.
9. A local model endpoint disappears after placement but before generation.
10. A provider credential rotates while a queued turn holds an older grant.
11. A runner disconnects after a mutation begins.
12. A trusted runner receives a contained profile.
13. A full-access request targets a runner attested only for containment.
14. A runner enrollment token is replayed or used for the wrong organization.
15. An invitation is accepted by the wrong authenticated identity.
16. A client is offline after its membership was revoked.
17. The same email authenticates to two separate Convoy deployments.
18. An enterprise secret manager is unavailable during grant resolution.
19. Provider usage is reported but the model response outcome is uncertain.
20. A future capacity provider creates a runner but dispatch acknowledgement is
    lost.

In every case Convoy must preserve tenant isolation, avoid widening authority,
record uncertainty, and require inspection or explicit reconciliation before an
unsafe replay.

## 13. Implementation state and deliberate limits

The implemented foundation now provides:

- Convoy deployment identity, discovery, user/device sessions, named CLI
  profiles, explicit organization/team/project contexts, and secure native OS
  credential storage;
- personal, team, and enterprise organizations with memberships, invitations,
  policy inheritance, enterprise identity-provider provisioning, and bounded
  machine principals;
- tenant ownership and authorization across work, conversations, workflows,
  library resources, approvals, scheduling, providers, and execution;
- personal subscription, direct API, intermediate gateway, and local/self-hosted
  connections through one probe, route, immutable-grant, credential-broker, and
  outcome contract;
- environment access bindings, runner enrollment/machine credentials, execution
  profiles, terminal/direct-channel grants, local/SSH worker parity, and
  fail-closed reconciliation;
- tenant-scoped, secret-redacted, tamper-evident security audit records; and
- static capacity demand/status contracts, verified with a deterministic test
  adapter, and no resource lifecycle authority.

The following are deliberate external-certification or future-adapter work, not
alternate authorization paths:

- automatic capacity create, scale, drain, or destroy operations;
- native-host certification of macOS Keychain and Windows DPAPI/ACL behavior
  (their process contracts are tested from Linux);
- live certification of every supported provider and cloud-specific adapter;
- external workload federation until an adapter verifies issuer, audience,
  subject, expiry, and tenant binding; and
- independent token enforcement inside native tmux/SSH itself. Convoy validates
  the machine identity and channel grant before releasing connection descriptors;
  a future direct transport can consume the runner-side validator end to end.
