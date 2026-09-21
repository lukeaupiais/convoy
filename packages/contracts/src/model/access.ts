export type PrincipalRef =
  | { kind: 'user'; userId: string }
  | { kind: 'service-principal'; servicePrincipalId: string }
  | { kind: 'workload'; workloadIdentityId: string };

export type AuthenticationMethod =
  | 'local-bootstrap'
  | 'oidc-pkce'
  | 'device-code'
  | 'saml'
  | 'workload-identity';

export type Deployment = {
  id: string;
  displayName: string;
  issuer: string;
  publicOrigin: string;
  capabilities: string[];
  authenticationMethods: AuthenticationMethod[];
  minimumClientVersion?: string;
};

export type User = {
  id: string;
  displayName: string;
  primaryEmail?: string;
  state: 'active' | 'suspended' | 'deleted';
  revision: number;
};

export type Organization = {
  id: string;
  slug: string;
  displayName: string;
  kind: 'personal' | 'team' | 'enterprise';
  state: 'active' | 'suspended';
  policyRevision: string;
  revision: number;
};

export type Team = {
  id: string;
  organizationId: string;
  slug: string;
  displayName: string;
  state: 'active' | 'archived';
  revision: number;
};

export type MembershipScope =
  | { kind: 'organization'; organizationId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'project'; projectId: string };

export type Membership = {
  id: string;
  organizationId: string;
  principal: PrincipalRef;
  scope: MembershipScope;
  roles: string[];
  state: 'invited' | 'active' | 'suspended' | 'revoked';
  managedBy?:
    | { kind: 'jit' | 'scim'; identityProviderId: string }
    | {
        kind: 'identity-provider-group';
        identityProviderId: string;
        externalGroupId: string;
      };
  revision: number;
};

export type OrganizationInvitation = {
  id: string;
  organizationId: string;
  scope: MembershipScope;
  roles: string[];
  email?: string;
  domain?: string;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  revision: number;
  createdAt: string;
  expiresAt: string;
  updatedAt?: string;
  acceptedBy?: PrincipalRef;
  acceptedAt?: string;
  revokedAt?: string;
};

export type ContextRef = {
  organizationId: string;
  teamId?: string;
  projectId: string;
};

export type ActiveContext = ContextRef & {
  id: string;
  deploymentId: string;
  principal: PrincipalRef;
  userId?: string;
  membershipRevision: string;
  policyRevision: string;
};

export type ContextSummary = ContextRef & {
  organizationSlug: string;
  organizationDisplayName: string;
  teamSlug?: string;
  teamDisplayName?: string;
  projectSlug: string;
  projectDisplayName: string;
  label: string;
};

export type ClientProfile = {
  deploymentId: string;
  serverOrigin: string;
  displayName: string;
  trustedServerIdentity: string;
  deviceId: string;
  secureCredentialReference: string;
  lastContext?: ContextRef;
};

export type DeviceSession = {
  id: string;
  userId: string;
  deviceId: string;
  state: 'active' | 'revoked' | 'expired';
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  revision: number;
};

export type AuthorizationDecision = {
  effect: 'allow' | 'ask' | 'deny';
  reason: string;
};

export type PolicyEffect = 'allow' | 'ask' | 'deny';

export type OrganizationPolicy = {
  id: string;
  organizationId: string;
  scope: MembershipScope;
  rules: {
    permissions: Record<string, PolicyEffect>;
    personalProviders?: PolicyEffect;
    fullSystemAccess?: PolicyEffect;
  };
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkloadIdentity = {
  id: string;
  displayName: string;
  organizationId: string;
  state: 'active' | 'suspended' | 'revoked';
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ServicePrincipal = {
  id: string;
  displayName: string;
  organizationId: string;
  state: 'active' | 'suspended' | 'revoked';
  credentialExpiresAt: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ExternalIdentityLink = {
  id: string;
  userId: string;
  organizationId: string;
  identityProviderId: string;
  protocol: 'oidc' | 'saml';
  issuer: string;
  subject: string;
  email: string;
  source: 'jit' | 'scim' | 'controlled-link';
  state: 'active' | 'revoked';
  revision: number;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export type EnterpriseIdentityProvider = {
  id: string;
  organizationId: string;
  protocol: 'oidc' | 'saml';
  issuer: string;
  displayName: string;
  verifiedDomains: string[];
  jit: { enabled: boolean; defaultRoles: string[] };
  scimEnabled: boolean;
  requiredAuthenticationStrength?: string;
  requireMfa: boolean;
  state: 'active' | 'disabled';
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type IdentityProviderGroupMapping = {
  id: string;
  organizationId: string;
  identityProviderId: string;
  externalGroupId: string;
  scope: MembershipScope;
  roles: string[];
  state: 'active' | 'disabled';
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationDomainVerification = {
  id: string;
  organizationId: string;
  domain: string;
  state: 'pending' | 'verified' | 'expired' | 'revoked';
  evidenceRef?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  verifiedAt?: string;
};
