const sessionTarget = ['sessionId', 'taskId'];
const contract = (required = [], optional = []) => ({
  required,
  // Session references are envelope correlation metadata. Commands that need a
  // session still validate it in their owning module; global commands may ignore it.
  allowed: ['action', 'client', ...sessionTarget, ...required, ...optional],
});
const session = (required = [], optional = []) => contract(required, optional);

/**
 * The executable half of packages/contracts/src/commands.ts. Domain modules
 * still validate values and invariants; this seam rejects unknown actions,
 * missing top-level fields, invalid primitive shapes, and accidental payload
 * drift before orchestration begins.
 */
export const runtimeCommandContracts = {
  querySecurityAudit: contract(
    ['organizationId'],
    ['cursor', 'limit', 'eventAction', 'outcome', 'projectId'],
  ),
  exportSecurityAudit: contract(
    ['organizationId'],
    ['cursor', 'limit', 'eventAction', 'outcome', 'projectId', 'format'],
  ),
  advance: session(),
  answerQuestion: session(['questionId', 'answer']),
  approveGate: session(['instance']),
  attachContext: session([], ['path', 'name', 'mime', 'data']),
  attachTicketFile: contract(['taskId', 'revision', 'name', 'mime', 'data']),
  cancelWorkflow: session(),
  claim: session([], ['label']),
  clearBoardPlacement: contract(['boardId', 'ticketId', 'revision']),
  selectActiveContext: contract(['context']),
  createOrganization: contract(['slug', 'displayName', 'kind']),
  createTeam: contract(['organizationId', 'slug', 'displayName']),
  createMembership: contract(['organizationId', 'principal', 'scope', 'roles']),
  updateMembership: contract(['organizationId', 'membershipId'], ['roles', 'state']),
  createInvitation: contract(['organizationId', 'scope', 'roles', 'ttlMs'], ['email', 'domain']),
  acceptInvitation: contract(['token']),
  beginOrganizationDomainVerification: contract(['organizationId', 'domain'], ['ttlMs']),
  completeOrganizationDomainVerification: contract(['organizationId', 'domainVerificationId']),
  configureEnterpriseIdentityProvider: contract(
    [
      'organizationId',
      'protocol',
      'issuer',
      'displayName',
      'verifiedDomains',
      'jit',
      'scimEnabled',
    ],
    ['requiredAuthenticationStrength', 'requireMfa'],
  ),
  saveIdentityProviderGroupMapping: contract([
    'organizationId',
    'identityProviderId',
    'externalGroupId',
    'scope',
    'roles',
  ]),
  provisionExternalIdentity: contract(['organizationId', 'identityProviderId', 'request']),
  deprovisionExternalIdentity: contract(['organizationId', 'identityProviderId', 'request']),
  createWorkloadIdentity: contract(['organizationId', 'displayName']),
  revokeWorkloadIdentity: contract(['organizationId', 'workloadIdentityId', 'expectedRevision']),
  createServicePrincipal: contract(['organizationId', 'displayName'], ['ttlMs']),
  rotateServicePrincipalCredential: contract(
    ['organizationId', 'servicePrincipalId', 'expectedRevision'],
    ['ttlMs'],
  ),
  revokeServicePrincipal: contract(['organizationId', 'servicePrincipalId', 'expectedRevision']),
  createProviderConnection: contract(
    ['organizationId', 'providerId', 'displayName', 'owner'],
    ['endpoint', 'governance', 'credentialRef', 'credentialValue'],
  ),
  probeProviderConnection: contract(['organizationId', 'connectionId', 'expectedRevision']),
  rotateProviderCredential: contract([
    'organizationId',
    'connectionId',
    'expectedRevision',
    'credentialValue',
  ]),
  revokeProviderCredential: contract(['organizationId', 'connectionId', 'expectedRevision']),
  createModelRoute: contract(
    ['organizationId', 'name', 'candidates'],
    ['purposes', 'selectors', 'policy'],
  ),
  revokeProviderConnection: contract(
    ['organizationId', 'connectionId', 'expectedRevision'],
    ['reason'],
  ),
  saveEnvironmentAccessBinding: contract(
    ['organizationId', 'subject', 'resource', 'role'],
    ['id', 'revision', 'constraints'],
  ),
  issueRunnerEnrollment: contract(
    ['organizationId', 'environmentId'],
    ['poolIds', 'projectIds', 'authorityCeiling', 'expectedPlatform', 'expiresInSeconds'],
  ),
  redeemRunnerEnrollment: contract(
    ['token', 'organizationId', 'environmentId', 'name', 'repository', 'attestation'],
    ['accessMode'],
  ),
  revokeRunnerEnrollment: contract(['id', 'organizationId', 'revision']),
  rotateRunnerIdentity: contract(['runnerId', 'organizationId', 'revision']),
  revokeRunnerIdentity: contract(['runnerId', 'organizationId', 'revision']),
  configure: session([], ['runnerId', 'workflow']),
  connectRemote: contract(['host', 'repository', 'projectIds']),
  continueWorkflow: session(['instance']),
  createBoardFromTemplate: contract(['templateId', 'name', 'projectIds']),
  createConversation: contract(['requestId'], ['title', 'projectId', 'placement']),
  createTicket: contract(
    ['requestId', 'projectId', 'title'],
    ['description', 'status', 'label', 'agent', 'priority', 'customFields'],
  ),
  decide: session(['approvalId'], ['allow', 'decision']),
  deleteBoard: contract(['id', 'revision']),
  deleteBoardTemplate: contract(['id', 'revision']),
  diff: session(),
  discardMessage: session(['requestId']),
  ensure: contract(['taskId'], ['title', 'description']),
  exportSkill: contract(['name'], ['version', 'organizationId']),
  heartbeat: session(),
  importTickets: contract(['projectId', 'tickets']),
  linkTicket: session(['ticketId']),
  openTerminal: session([], ['command', 'cols', 'rows', 'timeoutMs']),
  openTicketConversation: contract(['ticketId', 'requestId']),
  pauseWorkflow: session(),
  probeModel: contract(['model']),
  probeRunner: contract(['runnerId']),
  publishInstruction: contract(
    ['scope', 'name', 'content'],
    ['organizationId', 'target', 'projectId'],
  ),
  publishExtension: contract(['manifest', 'trusted'], ['organizationId', 'projectId']),
  publishProfile: contract(
    ['name', 'tools', 'skills'],
    ['organizationId', 'projectId', 'id', 'baseVersion', 'extensions'],
  ),
  publishSkill: contract(
    ['files', 'trusted'],
    ['organizationId', 'projectId', 'baseVersion', 'source'],
  ),
  saveOrganizationPolicy: contract(['organizationId', 'scope', 'rules', 'baseRevision']),
  removeApprovalRule: contract(['ruleId']),
  removeTicketFile: contract(['taskId', 'revision', 'attachmentId']),
  readCommandOutput: session(['commandId'], ['cursor']),
  readTerminalOutput: session(['terminalId'], ['cursor']),
  renewChannelGrant: session(['id', 'revision'], ['expiresInSeconds']),
  revokeChannelGrant: session(['id', 'revision']),
  reconcileAssignment: session(['token', 'confirmStopped']),
  reconcileWorkflowEffect: session(['instance', 'effectKey', 'resolution'], ['result']),
  registerRunner: contract(
    ['name', 'repository'],
    ['organizationId', 'environmentId', 'kind', 'host', 'projectIds', 'accessMode'],
  ),
  release: session(),
  releaseTicket: session(),
  rememberContext: session(['summary']),
  requestChanges: session(['instance', 'feedback']),
  requestExecution: session(['ticketId', 'mode'], ['brief', 'requestId']),
  resumeSession: session(['requestId'], ['acknowledge']),
  retryWorkflowTrigger: session(['triggerKey']),
  reviseSubmission: session(['instance', 'feedback']),
  runTicket: contract(
    ['requestId', 'ticketId', 'revision', 'workflowId', 'workflowVersion', 'model', 'mode'],
    ['sessionId', 'placement', 'profile'],
  ),
  saveBoard: contract(
    ['name', 'columns'],
    [
      'id',
      'description',
      'revision',
      'projectIds',
      'swimlanes',
      'filters',
      'cardFields',
      'grouping',
      'density',
    ],
  ),
  saveBoardTemplate: contract(
    ['name', 'columns'],
    ['id', 'description', 'revision', 'swimlanes', 'filters', 'cardFields', 'grouping', 'density'],
  ),
  saveEnvironment: contract(
    ['name', 'kind'],
    ['id', 'organizationId', 'revision', 'host', 'enabled', 'maxConcurrent', 'tags'],
  ),
  saveProject: contract(['name'], ['id', 'organizationId', 'teamId', 'revision', 'description']),
  saveRunnerPool: contract(['name', 'runnerIds'], ['id', 'organizationId', 'revision']),
  saveWorkflow: contract(
    ['workflow'],
    ['organizationId', 'teamId', 'projectId', 'baseVersion', 'makeDefault'],
  ),
  saveWorkflowDraft: contract(['workflow', 'revision'], ['organizationId', 'teamId', 'projectId']),
  saveWorkflowStartRule: contract(['organizationId', 'rule', 'revision']),
  sendMessage: session(['requestId', 'text', 'model'], ['mode', 'attachmentIds']),
  setBoardPlacement: contract(['boardId', 'ticketId', 'revision', 'placement']),
  setCapabilityProfile: session(['profile']),
  setPlacement: contract(['revision', 'placement'], ['taskId', 'projectId']),
  setExecutionProfile: contract(['revision', 'profile'], ['taskId', 'projectId']),
  setProjectProfile: contract(['projectId', 'profile'], ['expected']),
  setScheduler: contract(['maxConcurrent'], ['organizationId']),
  setToolEnabled: contract(['id', 'enabled'], ['organizationId', 'projectId']),
  start: session(['requestId', 'text', 'model']),
  startWorkflow: session(),
  stop: session(),
  stopCommand: session(['commandId']),
  stopTerminal: session(['terminalId']),
  terminalConnection: session(['terminalId']),
  terminalStatus: session(['terminalId']),
  updateRunner: contract(
    ['runnerId', 'revision', 'name', 'maxConcurrent', 'enabled', 'tags', 'projectIds'],
    [
      'id',
      'organizationId',
      'environmentId',
      'kind',
      'host',
      'repository',
      'online',
      'checkedAt',
      'capabilities',
      'load',
      'backgroundLoad',
      'lastAssignedAt',
      'accessMode',
      'lifecycle',
      'registration',
      'draining',
    ],
  ),
  updateTicket: contract(['taskId', 'revision', 'patch']),
  validateSkill: contract(['files']),
};

const primitiveShapes = {
  action: 'string',
  client: 'string',
  sessionId: 'string',
  taskId: ['string', 'number'],
  requestId: 'string',
  questionId: 'string',
  answer: 'string',
  approvalId: 'string',
  attachmentId: 'string',
  ruleId: 'string',
  instance: 'string',
  path: 'string',
  name: 'string',
  mime: 'string',
  data: 'string',
  label: 'string',
  boardId: 'string',
  ticketId: 'number',
  revision: 'number',
  runnerId: 'string',
  host: 'string',
  repository: 'string',
  templateId: 'string',
  context: 'object',
  slug: 'string',
  displayName: 'string',
  principal: 'object',
  scope: 'object',
  roles: 'array',
  membershipId: 'string',
  state: 'string',
  ttlMs: 'number',
  email: 'string',
  domain: 'string',
  domainVerificationId: 'string',
  identityProviderId: 'string',
  protocol: 'string',
  issuer: 'string',
  verifiedDomains: 'array',
  jit: 'object',
  scimEnabled: 'boolean',
  requiredAuthenticationStrength: 'string',
  requireMfa: 'boolean',
  externalGroupId: 'string',
  request: 'object',
  providerId: 'string',
  owner: 'object',
  credentialRef: 'object',
  endpoint: 'object',
  governance: 'object',
  connectionId: 'string',
  expectedRevision: ['string', 'number'],
  evidence: 'object',
  offerings: 'array',
  candidates: 'array',
  purposes: 'array',
  selectors: 'array',
  policy: 'object',
  reason: 'string',
  subject: 'object',
  resource: 'object',
  role: 'string',
  constraints: 'object',
  poolIds: 'array',
  projectIds: 'array',
  authorityCeiling: 'string',
  expectedPlatform: 'object',
  expiresInSeconds: 'number',
  attestation: 'object',
  accessMode: 'string',
  title: 'string',
  description: 'string',
  projectId: 'string',
  teamId: 'string',
  allow: 'boolean',
  decision: 'string',
  id: 'string',
  version: 'number',
  commandId: 'string',
  terminalId: 'string',
  cursor: 'number',
  limit: 'number',
  outcome: 'string',
  eventAction: 'string',
  format: 'string',
  model: 'string',
  scope: ['string', 'object'],
  content: 'string',
  trusted: 'boolean',
  manifest: 'object',
  baseVersion: 'number',
  effectKey: 'string',
  resolution: 'string',
  summary: 'string',
  feedback: 'string',
  mode: 'string',
  workflowId: 'string',
  workflowVersion: 'number',
  kind: 'string',
  enabled: 'boolean',
  maxConcurrent: 'number',
  token: 'string',
  credentialValue: 'string',
  confirmStopped: 'boolean',
  environmentId: 'string',
  organizationId: 'string',
  online: 'boolean',
  checkedAt: 'string',
  capabilities: 'object',
  load: 'number',
  backgroundLoad: 'number',
  lastAssignedAt: 'string',
  lifecycle: 'string',
  registration: 'string',
  draining: 'boolean',
};

function matches(value, expected) {
  const choices = Array.isArray(expected) ? expected : [expected];
  return choices.some((type) =>
    type === 'array'
      ? Array.isArray(value)
      : type === 'object'
        ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : typeof value === type,
  );
}

export function validateRuntimeCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Runtime command must be an object.');
  const definition = runtimeCommandContracts[input.action];
  if (!definition) throw new Error('Unknown runtime command.');
  if (typeof input.client !== 'string' || !/^[\w-]{8,80}$/.test(input.client))
    throw new Error('A valid client identity is required.');
  const unknown = Object.keys(input).find((key) => !definition.allowed.includes(key));
  if (unknown) throw new Error(`Unsupported field for ${input.action}: ${unknown}.`);
  const missing = definition.required.find(
    (key) => !Object.hasOwn(input, key) || input[key] === undefined,
  );
  if (missing) throw new Error(`Missing field for ${input.action}: ${missing}.`);
  for (const [key, expected] of Object.entries(primitiveShapes)) {
    if (input[key] !== undefined && !matches(input[key], expected))
      throw new Error(`Invalid field for ${input.action}: ${key}.`);
  }
  if (
    input.action === 'attachContext' &&
    input.path === undefined &&
    (input.name === undefined || input.mime === undefined || input.data === undefined)
  )
    throw new Error('Attach a workspace path or uploaded file.');
  if (
    input.action === 'createProviderConnection' &&
    Boolean(input.credentialRef) === Boolean(input.credentialValue)
  )
    throw new Error('Provide exactly one credential reference or one-time credential value.');
  if (
    input.action === 'configure' &&
    input.workflow !== undefined &&
    typeof input.workflow !== 'string' &&
    input.workflow !== true
  )
    throw new Error('Invalid field for configure: workflow.');
  if (
    ['saveWorkflow', 'saveWorkflowDraft'].includes(input.action) &&
    !matches(input.workflow, 'object')
  )
    throw new Error(`Invalid field for ${input.action}: workflow.`);
  if (input.action === 'saveWorkflowStartRule' && !matches(input.rule, 'object'))
    throw new Error('Invalid field for saveWorkflowStartRule: rule.');
  if (
    input.action === 'setPlacement' &&
    input.taskId === undefined &&
    input.projectId === undefined
  )
    throw new Error('Placement requires a ticket or project.');
  if (
    input.action === 'setExecutionProfile' &&
    input.taskId === undefined &&
    input.projectId === undefined
  )
    throw new Error('Execution profile requires a ticket or project.');
  if (
    input.action === 'decide' &&
    input.allow === undefined &&
    !['allow_once', 'allow_always', 'deny'].includes(input.decision)
  )
    throw new Error('Choose an approval decision.');
  return input;
}
