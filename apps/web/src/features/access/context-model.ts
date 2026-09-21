import type { RuntimeState } from '../../shared/api/runtime';

type ContextSource = Pick<
  RuntimeState,
  | 'deployment'
  | 'currentUser'
  | 'activeContext'
  | 'availableContexts'
  | 'organizations'
  | 'teams'
  | 'memberships'
  | 'identityProviders'
  | 'projects'
>;

const INVITATION_ROLES = {
  organization: ['owner', 'admin', 'security-admin', 'billing-admin', 'member', 'viewer'],
  team: ['admin', 'member', 'viewer'],
  project: ['owner', 'maintainer', 'contributor', 'viewer'],
} as const;

export function invitationToken(value: string) {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return (
      url.searchParams.get('invitation')?.trim() ?? url.searchParams.get('token')?.trim() ?? ''
    );
  } catch {
    return '';
  }
}

export function invitationAdministrationModel(source: ContextSource) {
  const organizationId = source.activeContext?.organizationId;
  const project = source.projects.find(
    (candidate) =>
      candidate.id === source.activeContext?.projectId &&
      candidate.organizationId === organizationId,
  );
  const organization = source.organizations?.find((candidate) => candidate.id === organizationId);
  const userId = source.currentUser?.id;
  const organizationRoles = (source.memberships ?? [])
    .filter(
      (membership) =>
        membership.organizationId === organizationId &&
        membership.state === 'active' &&
        membership.scope.kind === 'organization' &&
        membership.principal.kind === 'user' &&
        membership.principal.userId === userId,
    )
    .flatMap((membership) => membership.roles);
  const canInvite = organizationRoles.some((role) =>
    ['owner', 'admin', 'security-admin'].includes(role),
  );
  const canCreateTeam = organizationRoles.some((role) => ['owner', 'admin'].includes(role));
  const scopes: Array<{ value: string; label: string; roles: string[] }> = [];
  if (organizationId) {
    scopes.push({
      value: `organization:${organizationId}`,
      label: `Organization · ${organization?.displayName ?? organizationId}`,
      roles: [...INVITATION_ROLES.organization],
    });
    for (const team of source.teams ?? []) {
      if (team.organizationId === organizationId && team.state === 'active') {
        scopes.push({
          value: `team:${team.id}`,
          label: `Team · ${team.displayName}`,
          roles: [...INVITATION_ROLES.team],
        });
      }
    }
    if (project) {
      scopes.push({
        value: `project:${project.id}`,
        label: `Project · ${project.name}`,
        roles: [...INVITATION_ROLES.project],
      });
    }
  }
  const verifiedDomains = Array.from(
    new Set(
      (source.identityProviders ?? [])
        .filter((provider) => provider.organizationId === organizationId)
        .flatMap((provider) => provider.verifiedDomains)
        .map((domain) => domain.toLowerCase()),
    ),
  ).sort();

  return {
    organizationId,
    canInvite,
    canCreateTeam,
    scopes,
    verifiedDomains,
    permissionMessage: canInvite
      ? undefined
      : 'Creating invitations requires an active organization invitation administrator role.',
  };
}

export function parseInvitationScope(value: string) {
  const [kind, id] = value.split(':', 2);
  if (kind === 'organization' && id) return { kind, organizationId: id } as const;
  if (kind === 'team' && id) return { kind, teamId: id } as const;
  if (kind === 'project' && id) return { kind, projectId: id } as const;
  throw new Error('Choose a valid invitation scope.');
}

export function invitationLink(publicOrigin: string, token: string) {
  const url = new URL('/', publicOrigin);
  url.searchParams.set('invitation', token);
  return url.toString();
}

export function buildContextModel(source: ContextSource) {
  const active = source.activeContext;
  const project = source.projects.find((candidate) => candidate.id === active?.projectId);
  const selectedProject = project ?? source.projects[0];
  const organizationId = active?.organizationId ?? selectedProject?.organizationId;
  const organization = source.organizations?.find((candidate) => candidate.id === organizationId);
  const team = source.teams?.find((candidate) => candidate.id === active?.teamId);
  const deploymentName = source.deployment?.displayName ?? 'Local Convoy';
  const labels = [
    deploymentName,
    organization?.displayName,
    team?.displayName,
    selectedProject?.name,
  ].filter((label): label is string => Boolean(label));
  const roleLabels = (source.memberships ?? [])
    .filter((membership) => {
      if (
        membership.state !== 'active' ||
        membership.organizationId !== organizationId ||
        membership.principal.kind !== 'user' ||
        membership.principal.userId !== source.currentUser?.id
      )
        return false;
      if (membership.scope.kind === 'organization') return true;
      if (membership.scope.kind === 'team') return membership.scope.teamId === active?.teamId;
      return membership.scope.projectId === selectedProject?.id;
    })
    .map(
      (membership) =>
        `${membership.scope.kind[0].toUpperCase()}${membership.scope.kind.slice(1)}: ${membership.roles.join(', ')}`,
    );

  return {
    deploymentName,
    organizationName: organization?.displayName,
    teamName: team?.displayName,
    projectName: selectedProject?.name,
    userLabel: source.currentUser?.displayName ?? 'Local user',
    roleLabels,
    authoritativeLabel: labels.join(' / '),
    isManaged: Boolean(source.deployment || active || source.organizations?.length),
    organizations: (source.organizations ?? []).filter((candidate) => candidate.state === 'active'),
    teams: (source.teams ?? []).filter(
      (candidate) => candidate.state === 'active' && candidate.organizationId === organizationId,
    ),
    projects: source.projects.filter(
      (candidate) => !organizationId || candidate.organizationId === organizationId,
    ),
    availableContexts: source.availableContexts ?? [],
  };
}
