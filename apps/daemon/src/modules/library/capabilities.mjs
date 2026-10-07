import { submissionContract, submissionToolSchema, validateSubmissionContract } from '../workflows/index.mjs';
import { parseDocument } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import { digest } from '../../../../../packages/runner/src/index.mjs';
import {
  toolRegistry,
  modelTools,
  declaredModelTools,
  validateToolCall,
  submissionInputSchema,
} from './tool-registry.mjs';
import { migrateExtensionState, parseExtensionManifest } from './extensions.mjs';

const bounded = (v, max, label) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`Invalid ${label}.`);
  return v;
};
const safePath = (path) =>
  typeof path === 'string' &&
  path.length <= 240 &&
  !path.includes('\\') &&
  !path.startsWith('/') &&
  path
    .split('/')
    .every(
      (p) =>
        p &&
        ![
          '.',
          '..',
          '__proto__',
          'constructor',
          'prototype',
          '.git',
          '.ssh',
          '.codex',
          '.convoy',
          'node_modules',
        ].includes(p) &&
        !p.startsWith('.env'),
    ) &&
  !/[\x00-\x1f]/.test(path);
const refKey = (r) => r.snapshotId ?? `${r.name}@${r.version}`;
const toolHash = (t) => digest(JSON.stringify(t));

// Pure, bounded parser. Importing a skill never evaluates scripts or resolves links.
export function parseSkill(files) {
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    Object.keys(files).length > 50 ||
    Buffer.byteLength(JSON.stringify(files)) > 200000
  )
    throw new Error('A skill bundle must contain at most 50 text files and 200 KB.');
  for (const [path, content] of Object.entries(files))
    if (
      !safePath(path) ||
      typeof content !== 'string' ||
      Buffer.byteLength(content) > 64000 ||
      content.includes('\0')
    )
      throw new Error('Invalid resource path or oversized/non-text file: ' + path);
  const source = bounded(files['SKILL.md'], 64000, 'SKILL.md').replace(/\r\n/g, '\n');
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter between --- lines.');
  const doc = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
  if (doc.errors.length || doc.warnings.length)
    throw new Error('Invalid skill YAML: ' + (doc.errors[0] ?? doc.warnings[0]).message);
  const meta = doc.toJS({ maxAliasCount: 0 });
  if (!meta || typeof meta !== 'object' || Array.isArray(meta))
    throw new Error('Skill frontmatter must be a mapping.');
  const name = bounded(meta.name, 64, 'skill name');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    throw new Error('Skill names use lowercase letters, numbers and single hyphens.');
  const description = bounded(meta.description, 1024, 'skill description');
  for (const key of ['license', 'compatibility', 'allowed-tools'])
    if (meta[key] !== undefined) bounded(meta[key], key === 'compatibility' ? 500 : 4000, key);
  if (
    meta.metadata !== undefined &&
    (!meta.metadata ||
      typeof meta.metadata !== 'object' ||
      Array.isArray(meta.metadata) ||
      Object.values(meta.metadata).some((v) => typeof v !== 'string'))
  )
    throw new Error('Skill metadata must map strings to strings.');
  bounded(match[2], 64000, 'skill instructions');
  const canonical = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    name,
    description,
    body: match[2],
    metadata: meta,
    files: canonical,
    hash: digest(JSON.stringify(canonical)),
    warnings: [
      ...(meta['allowed-tools']
        ? ['allowed-tools is advisory; Convoy approval rules still apply.']
        : []),
      ...Object.keys(meta)
        .filter(
          (k) =>
            ![
              'name',
              'description',
              'license',
              'compatibility',
              'metadata',
              'allowed-tools',
            ].includes(k),
        )
        .map((k) => `Unsupported metadata retained, not executed: ${k}`),
    ],
  };
}

export function migrateLibraryState(state) {
  migrateExtensionState(state);
  state.skills ??= [];
  state.capabilityProfiles ??= [];
  state.projectProfiles ??= {};
  state.disabledTools ??= [];
  state.toolPolicies ??= [];
  state.instructions ??= [];
  state.instructionOwners ??= { organizationId: 'default', userId: 'local' };
  for (const skill of state.skills) skill.organizationId ??= 'personal';
  for (const extension of state.extensions) extension.organizationId ??= 'personal';
  for (const profile of state.capabilityProfiles) profile.organizationId ??= 'personal';
  for (const instruction of state.instructions) {
    instruction.organizationId ??=
      (instruction.scope === 'project'
        ? state.projects?.find((project) => project.id === instruction.target)?.organizationId
        : undefined) ?? 'personal';
  }
  // Persist the legacy choice for existing sessions; a later project default must not change them.
  for (const s of Object.values(state.sessions))
    if (s.capabilityProfile === undefined) {
      s.capabilityProfile = null;
      s.activeSkills = [];
    }
}

export function createCapabilities({ state, executionPolicy, validateKnowledge, skillSources }) {
  migrateLibraryState(state);
  const organizationForProject = (projectId) =>
    state.projects?.find((project) => project.id === projectId)?.organizationId ?? 'personal';
  const organizationForSession = (session) => organizationForProject(session?.projectId);
  const commandOrganization = (command) => command.organizationId ?? 'personal';
  function profile(ref, organizationId = 'personal') {
    const p = state.capabilityProfiles.find(
      (p) =>
        p.id === ref?.id &&
        p.version === ref?.version &&
        (p.organizationId ?? 'personal') === organizationId,
    );
    if (!p) throw new Error('Profile revision not found.');
    return p;
  }
  function skill(ref, organizationId = 'personal') {
    const s = state.skills.find(
      (s) =>
        s.name === ref.name &&
        s.version === ref.version &&
        (s.organizationId ?? 'personal') === organizationId,
    );
    if (!s || (ref.hash && s.hash !== ref.hash)) throw new Error('Skill revision not found.');
    return s;
  }
  function extension(ref, organizationId = 'personal') {
    const value = state.extensions.find(
      (candidate) =>
        candidate.id === ref?.id &&
        candidate.revision === ref?.revision &&
        (candidate.organizationId ?? 'personal') === organizationId,
    );
    if (!value || (ref.hash && value.hash !== ref.hash))
      throw new Error('Extension revision not found.');
    return value;
  }
  function extensionTools(session) {
    const organizationId = organizationForSession(session);
    return (selection(session)?.extensions ?? []).flatMap((ref) => {
      const value = extension(ref, organizationId);
      return value.tools.map((tool) => ({
        ...tool,
        id: `extension.${value.id}.${tool.id}`,
        name: tool.name,
        group: 'workspace',
        executor: 'extension',
        extension: {
          id: value.id,
          revision: value.revision,
          hash: value.hash,
          adapter: value.execution.adapter,
        },
      }));
    });
  }
  function selection(s) {
    return s.capabilityProfile ?? null;
  }
  function selectedSkills(s, step) {
    const organizationId = organizationForSession(s);
    const legacy = (selection(s)?.skills ?? []).map((ref) => skill(ref, organizationId));
    const captured = (s.skillSnapshots ?? []).map(ref => {
      if (!skillSources) throw new Error('Skill source support unavailable.');
      const snapshot = skillSources.snapshot(ref, {organizationId,userId:s.userId ?? s.ownerUserId ?? s.skillUserId,projectId:s.projectId});
      return {...snapshot, snapshotId:snapshot.id, version:0, hash:snapshot.digest,
        files:Object.fromEntries(snapshot.files.map(f=>[f.path,f.encoding==='utf8'?f.content:{encoding:f.encoding,content:f.content}]))};
    });
    return [...legacy, ...captured]
      .filter((k) => !step?.skills?.length || step.skills.includes(k.name));
  }
  function entries(s, step) {
    const pinned = selection(s);
    const workflow = !!step;
    const reads = ['read_file', 'list_files', 'search_files', 'inspect_repository'];
    const policy =
      !workflow || step.permissions === 'full'
        ? [
            ...reads,
            'write_file',
            'apply_patch',
            'shell',
            'start_command',
            'command_status',
            'read_command_output',
            'send_command_input',
            'stop_command',
          ]
        : step.permissions === 'read-write'
          ? [...reads, 'write_file', 'apply_patch']
          : step.permissions === 'read'
            ? [...reads, ...(pinned && executionPolicy?.readOnlyShell(s) ? ['shell', 'read_command_output'] : [])]
            : [];
    return [...toolRegistry, ...extensionTools(s)].map((t) => {
      let reason = '';
      const selected =
        pinned?.tools.find((r) => r.id === t.id) ??
        (t.executor === 'extension' &&
        pinned?.extensions?.some(
          (ref) =>
            ref.id === t.extension.id &&
            ref.revision === t.extension.revision &&
            ref.hash === t.extension.hash,
        )
          ? { hash: toolHash(t) }
          : undefined);
      if (!step && s.flow && !['completed', 'cancelled'].includes(s.flow.status))
        reason = 'No active agent step';
      else if (
        (organizationForSession(s) === 'personal' && state.disabledTools.includes(t.id)) ||
        state.toolPolicies.some(
          (policy) =>
            policy.organizationId === organizationForSession(s) &&
            (!policy.projectId || policy.projectId === s.projectId) &&
            policy.toolId === t.id &&
            policy.enabled === false,
        )
      )
        reason = 'Disabled by workspace policy';
      else if (['submit_step', 'finish_incomplete'].includes(t.name) && !workflow)
        reason = 'Only available in an agent workflow step';
      else if (
        ['load_skill', 'read_skill_resource'].includes(t.name) &&
        !selectedSkills(s, step).length
      )
        reason = 'No skills selected';
      else if (t.group === 'knowledge' && !pinned?.knowledge?.collectionIds?.length)
        reason = 'No knowledge selected';
      else if (t.group !== 'harness' && pinned && !selected) reason = 'Not selected in profile';
      else if (selected && selected.hash !== toolHash(t))
        reason = 'Tool definition changed; publish and apply a fresh profile';
      else if (t.executor === 'extension' && step && step.permissions !== 'full')
        reason = 'Extension tools require full workflow permissions';
      else if (t.executor !== 'extension' && t.group === 'workspace' && !policy.includes(t.name))
        reason = 'Blocked by workflow permissions';
      else if (t.group === 'workspace' && !s.workspace) reason = 'No workspace assigned';
      else if (
        t.executor === 'extension' &&
        !state.runners
          .find((r) => r.id === s.runnerId)
          ?.capabilities?.extensionAdapters?.includes(t.extension.adapter)
      )
        reason = 'Pinned extension adapter is not installed on this runner';
      else if (
        t.executor !== 'extension' &&
        t.group === 'workspace' &&
        !state.runners.find((r) => r.id === s.runnerId)?.capabilities?.tools?.includes(t.name)
      )
        reason = 'Runner does not support this tool';
      else if (workflow && t.group === 'project' && !pinned) reason = 'Legacy workflow profile';
      else if (workflow && ['request_execution', 'release_assignment'].includes(t.name))
        reason = 'Cannot change assignment inside an active workflow';
      else if (
        workflow &&
        t.group === 'project' &&
        t.approval === 'ask' &&
        ['none', 'read'].includes(step.permissions)
      )
        reason = 'Blocked by workflow permissions';
      if (!reason && t.group === 'workspace')
        reason = executionPolicy?.toolRestriction(s, t.name) ?? '';
      return { ...t, available: !reason, reason };
    });
  }
  function validateWorkflowSkills(workflow, selected) {
    for (const node of workflow.nodes ?? []) {
      for (const name of node.skills ?? []) {
        if (!selected?.skills.some((value) => value.name === name) && !selected?.skillSelections?.length)
          throw new Error(`${node.name}: capability profile is missing skill ${name}.`);
      }
    }
  }
  function resolveForWorkflow(session, workflow, options = {}) {
    const ref = Object.hasOwn(options, 'profile')
      ? options.profile
      : workflow.capabilityProfilePinned === true
        ? (workflow.capabilityProfile ?? null)
        : (workflow.capabilityProfile ?? session.capabilityProfile ?? state.projectProfiles[session.projectId]);
    const selected = ref ? structuredClone(profile(ref, organizationForSession(session))) : null;
    // Historical workflows without a selected profile retain their legacy tool set.
    if (selected || workflow.capabilityProfile) {
      validateWorkflowSkills(workflow, selected);
      for (const ref of selected?.skills ?? []) skill(ref, organizationForSession(session));
    }
    return selected;
  }
  return {
    snapshot(scope) {
      const organizationId = scope?.organizationId;
      const organizationVisible = value => scope === undefined || (!!organizationId && (value.organizationId ?? 'personal') === organizationId);
      return {
        tools: toolRegistry,
        skills: state.skills
          .filter(
            organizationVisible,
          )
          .map(({ files, body, ...s }) => ({
            ...s,
            organizationId: s.organizationId ?? 'personal',
            resources: Object.keys(files),
          })),
        profiles: state.capabilityProfiles.filter(
          (value) => organizationVisible(value) && (scope === undefined || !value.skillSelections?.length || skillSources?.canInspectSelections(value.skillSelections,scope)),
        ),
        extensions: state.extensions.filter(
          organizationVisible,
        ),
        projectProfiles: Object.fromEntries(
          Object.entries(state.projectProfiles).filter(
            ([projectId]) =>
              scope === undefined || (!!organizationId && organizationForProject(projectId) === organizationId),
          ),
        ),
        disabledTools: [
          ...(organizationId === 'personal' || scope === undefined ? state.disabledTools : []),
          ...state.toolPolicies
            .filter(organizationVisible)
            .filter((value) => value.enabled === false)
            .map((value) => value.toolId),
        ],
      };
    },
    preview(s, step) {
      return {
        profile: selection(s),
        tools: entries(s, step),
        skills: selectedSkills(s, step).map(({ name, version, description, hash, sourceId, snapshotId, runnerId, workspaceId }) => ({
          ...(sourceId ? {sourceId,snapshotId,runnerId,workspaceId} : {}),
          name,
          version,
          description,
          hash,
          active: s.activeSkills?.includes(snapshotId ?? `${name}@${version}`) ?? false,
        })),
      };
    },
    filterSessionPreview(session, scope, step) {
      const skillSnapshots=(session.skillSnapshots??[]).filter(ref=>{
        try { skillSources?.snapshot(ref,scope);return !!skillSources; } catch { return false; }
      });
      const value=this.preview({...session,skillSnapshots},step);
      const profileAllowed=!value.profile?.skillSelections?.length||skillSources?.canInspectSelections(value.profile.skillSelections,scope);
      return {...value,profile:profileAllowed?value.profile:null,skills:value.skills.filter(skill=>!skill.snapshotId||skillSources?.canInspectSelections([{mode:'snapshot-pinned',snapshotId:skill.snapshotId}],scope))};
    },
    sessionSkillProjection(session, scope) {
      const inspect = ref => skillSources?.canInspectSelections([{mode:'snapshot-pinned',snapshotId:ref.snapshotId}],scope);
      const profileAllowed=!session.capabilityProfile?.skillSelections?.length||skillSources?.canInspectSelections(session.capabilityProfile.skillSelections,scope);
      const skillSnapshots=(session.skillSnapshots??[]).filter(inspect);
      const capturedIds=new Set(skillSnapshots.map(ref=>ref.snapshotId));
      const legacyAllowed=scope?.organizationId===organizationForSession(session);
      const legacyKeys=new Set(legacyAllowed ? (session.capabilityProfile?.skills??[]).map(ref=>refKey(ref)) : []);
      const privateSnapshots=(state.skillSnapshots??[]).filter(snapshot=>snapshot.organizationId===organizationForSession(session)&&!inspect({snapshotId:snapshot.id}));
      const privateDigests=new Set(privateSnapshots.map(snapshot=>snapshot.digest));
      const privateNames=new Set(privateSnapshots.flatMap(snapshot=>[snapshot.id,snapshot.sourceId,snapshot.name]));
      const isSkillTool=tool=>['load_skill','read_skill_resource'].includes(tool);
      const privateResult=output=>output && (privateDigests.has(output.hash)||(!output.hash&&privateNames.has(output.name)));
      const privateCalls=new Set((session.events??[]).filter(event=>isSkillTool(event.tool)&&(
        privateResult(event.output)||(event.type==='tool_requested'&&privateNames.has(event.args?.name))
      )).map(event=>event.callId).filter(Boolean));
      const events=(session.events??[]).map(event=>{
        const result=structuredClone(event);
        if(isSkillTool(event.tool)&&(privateCalls.has(event.callId)||privateResult(event.output))) {
          if(Object.hasOwn(result,'output'))result.output={unavailable:true,message:'Skill content is private.'};
          if(Object.hasOwn(result,'args'))result.args={unavailable:true};
        }
        if(event.type==='profile_applied'&&event.profile){
          const applied=state.capabilityProfiles.find(profile=>profile.id===event.profile.id&&profile.version===event.profile.version&&(profile.organizationId??'personal')===organizationForSession(session));
          if(applied?.skillSelections?.length&&!skillSources?.canInspectSelections(applied.skillSelections,scope))result.profile=null;
        }
        return result;
      });
      return {
        capabilityProfile:profileAllowed?session.capabilityProfile:null,
        skillSnapshots,
        activeSkills:(session.activeSkills??[]).filter(value=>capturedIds.has(value)||legacyKeys.has(value)),
        events,
        ...(session.workflow ? {workflow:{...structuredClone(session.workflow),skillSnapshots:(session.workflow.skillSnapshots??[]).filter(inspect)}} : {}),
      };
    },
    declaredTools() {
      return declaredModelTools();
    },
    modelTools(s, step) {
      return modelTools(entries(s, step)).map(tool => {
        if (tool.name !== 'submit_step' || !step) return tool;
        const base = step.submissionRequirements ? submissionInputSchema(tool.parameters) : tool.parameters;
        return {...tool, description: `${tool.description} Use only for a completed decision. Use finish_incomplete for unfinished work at the allowance limit or an observed blocker.`, parameters: submissionToolSchema(base, submissionContract(s.workflow, step))};
      });
    },
    validate(s, step, name, args) {
      const t = entries(s, step).find((t) => t.name === name);
      if (!t?.available) throw new Error('Tool unavailable: ' + (t?.reason ?? name));
      if (t.executor === 'extension') {
        const check = new Ajv({ allErrors: true, strict: true }).compile(t.inputSchema);
        if (JSON.stringify(args ?? null).length > 40000 || !check(args))
          throw new Error('Invalid extension tool arguments.');
      } else {
        if (name === 'submit_step' && step) validateSubmissionContract(submissionContract(s.workflow, step), args);
        validateToolCall(name, args, !!step?.submissionRequirements);
      }
      return t;
    },
    extensionTool(session, step, name) {
      const tool = entries(session, step).find(
        (value) => value.name === name && value.executor === 'extension',
      );
      return tool ? structuredClone(tool) : null;
    },
    resolveForWorkflow,
    profileSelections(ref, organizationId = 'personal') { return structuredClone(profile(ref, organizationId).skillSelections ?? []); },
    validateWorkflow(workflow) {
      if (!workflow.capabilityProfile) return;
      const selected = profile(workflow.capabilityProfile, workflow.organizationId ?? 'personal');
      validateWorkflowSkills(workflow, selected);
    },
    resolve(ref) {
      return structuredClone(profile(ref, ref?.organizationId ?? 'personal'));
    },
    pin(s, ref) {
      const changed = s.capabilityProfile?.id !== ref?.id || s.capabilityProfile?.version !== ref?.version;
      if(changed) delete s.skillSnapshots;
      s.capabilityProfile = ref ? structuredClone(profile(ref, organizationForSession(s))) : null;
      s.activeSkills = [];
    },
    pinDefault(s) {
      if (s.capabilityProfile !== undefined) return;
      const ref = state.projectProfiles[s.projectId];
      const changed = s.capabilityProfile?.id !== ref?.id || s.capabilityProfile?.version !== ref?.version;
      if(changed) delete s.skillSnapshots;
      s.capabilityProfile = ref ? structuredClone(profile(ref, organizationForSession(s))) : null;
      s.activeSkills = [];
    },
    prompt(s, step) {
      const effective = entries(s, step);
      const available = effective.filter((tool) => tool.available).map((tool) => tool.name);
      const blocked = effective
        .filter((tool) => !tool.available)
        .map((tool) => ({ name: tool.name, reason: tool.reason }));
      const policy = `Tool policy for this turn. Call only available tools; declared but blocked tools will be rejected.\n${JSON.stringify({ available, blocked })}`;
      const list = selectedSkills(s, step);
      if (!list.length) return policy;
      return (
        policy +
        '\n\nAvailable skills (call load_skill before use; importing or activating never grants permission):\n' +
        JSON.stringify(list.map(({ name, description, sourceId, snapshotId }) => ({ name, description, ...(sourceId ? {sourceId,snapshotId} : {}) }))) +
        list
          .filter((k) => s.activeSkills?.includes(refKey(k)))
          .map(
            (k) =>
              `\nActivated skill ${refKey(k)} sha256:${k.hash}\n${k.body}\nBundled resources: ${Object.keys(k.files).join(', ')}. Read them with read_skill_resource; scripts are not automatically installed or executed.`,
          )
          .join('')
      );
    },
    load(s, step, name, path) {
      const matches = selectedSkills(s, step).filter(k=>k.name===name || k.snapshotId===name || k.sourceId===name);
      if(matches.length>1)throw new Error('Skill name is ambiguous; use the explicit source or snapshot identity.');
      const k=matches[0];
      if (!k) throw new Error('Skill is not selected for this step.');
      if (path !== undefined) {
        if (!s.activeSkills?.includes(refKey(k))) throw new Error('Activate the skill first.');
        if (!safePath(path) || !Object.hasOwn(k.files, path))
          throw new Error('Resource not found in pinned skill.');
        return { name, version: k.version, path, ...(typeof k.files[path] === 'string' ? {content:k.files[path]} : k.files[path]), hash:k.hash };
      }
      s.activeSkills ??= [];
      if (!s.activeSkills.includes(refKey(k))) s.activeSkills.push(refKey(k));
      return {
        name,
        version: k.version,
        content: k.body,
        resources: Object.keys(k.files),
        hash: k.hash,
        warnings: k.warnings,
      };
    },
    command(c) {
      if (c.action === 'validateSkill') return parseSkill(c.files);
      if (c.action === 'publishSkill') {
        const organizationId = commandOrganization(c);
        const parsed = parseSkill(c.files);
        if (c.trusted !== true) throw new Error('Review and trust this skill before publishing.');
        const previous = state.skills
          .filter(
            (s) => s.name === parsed.name && (s.organizationId ?? 'personal') === organizationId,
          )
          .at(-1);
        if ((c.baseVersion ?? 0) !== (previous?.version ?? 0))
          throw new Error('Skill changed. Reload before publishing.');
        if (previous?.hash === parsed.hash) return previous;
        const record = {
          ...parsed,
          organizationId,
          version: (previous?.version ?? 0) + 1,
          source: bounded(c.source ?? 'UI import', 500, 'source'),
          at: new Date().toISOString(),
        };
        state.skills.push(record);
        return record;
      }
      if (c.action === 'exportSkill') return structuredClone(skill(c, commandOrganization(c)));
      if (c.action === 'publishExtension') {
        const organizationId = commandOrganization(c);
        const manifest = parseExtensionManifest(c.manifest);
        if (c.trusted !== true)
          throw new Error('Review and trust this extension before publishing.');
        const previous = state.extensions
          .filter((value) => value.id === manifest.id && value.revision === manifest.revision)
          .filter((value) => (value.organizationId ?? 'personal') === organizationId)
          .at(-1);
        if (previous?.hash === manifest.hash) return structuredClone(previous);
        if (previous) throw new Error('Extension revision already exists with different content.');
        const record = {
          ...manifest,
          organizationId,
          at: new Date().toISOString(),
          audit: {
            publishedBy: c.client,
            correlationId: `${manifest.id}@${manifest.revision}:${manifest.hash}`,
          },
        };
        state.extensions.push(record);
        return record;
      }
      if (c.action === 'publishProfile') {
        const organizationId = commandOrganization(c);
        const id = bounded(c.id, 80, 'profile ID');
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))
          throw new Error('Use a lowercase slug for the profile ID.');
        const previous = state.capabilityProfiles
          .filter((p) => p.id === id && (p.organizationId ?? 'personal') === organizationId)
          .at(-1);
        if ((c.baseVersion ?? 0) !== (previous?.version ?? 0))
          throw new Error('Profile changed. Reload before publishing.');
        const name = bounded(c.name, 100, 'profile name');
        if (c.loadWorkspaceAgentsMd !== undefined && typeof c.loadWorkspaceAgentsMd !== 'boolean')
          throw new Error('Load workspace AGENTS.md must be a boolean.');
        const loadWorkspaceAgentsMd = c.loadWorkspaceAgentsMd ?? false;
        if (
          !Array.isArray(c.tools) ||
          c.tools.length > 50 ||
          !Array.isArray(c.skills) ||
          c.skills.length > 30 ||
          (c.extensions !== undefined && (!Array.isArray(c.extensions) || c.extensions.length > 30))
        )
          throw new Error('Select a bounded list of tools and skills.');
        const tools = [...new Set(c.tools)].map((id) => {
          const t = toolRegistry.find((t) => t.id === id && t.group !== 'harness');
          if (!t) throw new Error('Unknown selectable tool: ' + id);
          return { id, version: t.version, hash: toolHash(t) };
        });
        const skills = c.skills.map((ref) => {
          const k = skill(ref, organizationId);
          return { name: k.name, version: k.version, hash: k.hash };
        });
        const extensions = (c.extensions ?? []).map((ref) => {
          const value = extension(ref, organizationId);
          return { id: value.id, revision: value.revision, hash: value.hash };
        });
        if (new Set(skills.map((k) => k.name)).size !== skills.length)
          throw new Error('Choose one revision per skill.');
        const skillSelections = c.skillSelections === undefined ? undefined : skillSources?.validateSelections(c.skillSelections,c.skillScope ?? {organizationId,userId:c.userId,projectId:c.projectId});
        if(c.skillSelections!==undefined && !skillSelections)throw new Error('Skill sources unavailable.');
        const knowledge = c.knowledge === undefined ? undefined : validateKnowledge?.(c.knowledge, organizationId);
        if (c.knowledge !== undefined && !knowledge) throw new Error('Knowledge selection unavailable.');
        const p = {
          ...(knowledge ? { knowledge } : {}),
          id,
          organizationId,
          name,
          version: (previous?.version ?? 0) + 1,
          loadWorkspaceAgentsMd,
          tools,
          skills,
          ...(skillSelections ? {skillSelections} : {}),
          extensions,
          at: new Date().toISOString(),
        };
        p.hash = digest(
          JSON.stringify({ id, name, tools, skills, ...(skillSelections ? {skillSelections} : {}), extensions, loadWorkspaceAgentsMd, ...(knowledge ? { knowledge } : {}) }),
        );
        state.capabilityProfiles.push(p);
        return p;
      }
      if (c.action === 'setProjectProfile') {
        if (!state.projects.some((p) => p.id === c.projectId)) throw new Error('Unknown project.');
        const old = state.projectProfiles[c.projectId] ?? null;
        if (JSON.stringify(old) !== JSON.stringify(c.expected ?? null))
          throw new Error('Project default changed. Reload first.');
        state.projectProfiles[c.projectId] = c.profile
          ? {
              id: profile(c.profile, organizationForProject(c.projectId)).id,
              version: c.profile.version,
            }
          : null;
        return;
      }
      if (c.action === 'setToolEnabled') {
        if (!toolRegistry.some((t) => t.id === c.id) || typeof c.enabled !== 'boolean')
          throw new Error('Invalid tool policy.');
        const organizationId = commandOrganization(c);
        if (organizationId === 'personal' && !c.projectId) {
          state.disabledTools = state.disabledTools.filter((id) => id !== c.id);
          if (!c.enabled) state.disabledTools.push(c.id);
        }
        state.toolPolicies = state.toolPolicies.filter(
          (policy) =>
            !(
              policy.organizationId === organizationId &&
              policy.projectId === c.projectId &&
              policy.toolId === c.id
            ),
        );
        state.toolPolicies.push({
          organizationId,
          ...(c.projectId ? { projectId: c.projectId } : {}),
          toolId: c.id,
          enabled: c.enabled,
        });
        return;
      }
      throw new Error('Unknown capability command.');
    },
  };
}
