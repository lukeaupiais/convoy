import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, join } from 'node:path';

export const skillSourceCommands = [
  'registerSkillRoot', 'unregisterSkillRoot', 'updateSkillRoot', 'catalogueSkills', 'refreshSkills',
  'readSkillSource', 'saveSkillSource', 'createSkillSource', 'captureSkillSelections',
  'provisionSkillSnapshot', 'saveStoredSkillToFolder', 'inspectSkillMutation', 'reconcileSkillMutation',
];
const within = (parent, child) => { const value = relative(parent, child); return !value || !value.startsWith('..') && !isAbsolute(value); };

/** Coordinates authorized domain sources with execution-host filesystem ports. */
export function createSkillSourceCoordinator({ state, sources, capabilities, runners, authorize, save, enqueue = work => work() }) {
  const subscriptions = new Map();
  let closed = false;
  function host(root, scope) {
    const runner = state.runners.find(value => value.id === root.runnerId && value.organizationId === root.organizationId);
    if (!runner || !runner.enabled) throw new Error('Skill runner unavailable.');
    if (scope.runnerId && scope.runnerId !== runner.id) throw new Error('Skill source is unavailable on the selected runner.');
    let workspaceId = scope.workspaceId ?? 'repository';
    let path = root.path, repositoryRevision, cwd = scope.cwd, repositoryPath = runner.repository;
    if (workspaceId !== 'repository') {
      const session = Object.values(state.sessions).find(value => value.id === workspaceId || value.workspace?.id === workspaceId || value.workspaceRequest?.id === workspaceId);
      if (!session?.workspace?.path || session.runnerId !== runner.id || !scope.projectIds?.includes(session.projectId)) throw new Error('Skill workspace unavailable or denied.');
      if (root.scope === 'project' && session.projectId !== root.projectId) throw new Error('Skill source belongs to another project.');
      if (root.scope === 'project') {
        if (!within(runner.repository, root.path)) throw new Error('Registered project source is outside its repository.');
        path = join(session.workspace.path, relative(runner.repository, root.path));
        repositoryPath = session.workspace.path;
      }
      repositoryRevision = session.workspace.revision ?? session.workspace.commit ?? session.workspace.baseCommit;
      cwd ??= session.workspace.path;
    } else cwd ??= runner.repository;
    if (scope.workingDirectory !== undefined) {
      if(typeof scope.workingDirectory !== 'string' || scope.workingDirectory.length > 500 || isAbsolute(scope.workingDirectory) || /[\\\x00-\x1f]/.test(scope.workingDirectory) || scope.workingDirectory && scope.workingDirectory.split('/').some(part=>part==='..'||part==='.'||!part))
        throw new Error('Choose a relative working directory inside the assigned workspace.');
      cwd=join(repositoryPath,scope.workingDirectory);
    }
    const relevancePath = root.relevancePath && root.scope === 'project' && workspaceId !== 'repository'
      ? join(repositoryPath, relative(runner.repository, root.relevancePath)) : root.relevancePath;
    const suffix=root.scope==='project'?root.path.match(/\/((?:\.agents|\.claude|\.github|\.cursor|\.codex)\/skills)\/?$/)?.[1]:undefined;
    let approvedCanonicalPath=root.approvedCanonicalPath,approvedRepositoryPath=root.approvedRepositoryPath;
    if(root.scope==='project' && workspaceId!=='repository') {
      if(approvedCanonicalPath && !within(approvedRepositoryPath ?? runner.repository,approvedCanonicalPath))throw new Error('Registered source target is outside its approved repository.');
      if(approvedCanonicalPath)approvedCanonicalPath=join(repositoryPath,relative(approvedRepositoryPath ?? runner.repository,approvedCanonicalPath));
      approvedRepositoryPath=repositoryPath;
    }
    return { runner, root: { ...root, path, relevancePath, approvedCanonicalPath, approvedRepositoryPath, ...(suffix ? {repositoryPath,discoveryBasePath:relevancePath ?? repositoryPath,skillRootPaths:[suffix]} : {}) }, context: { runnerId:runner.id, workspaceId, repositoryRevision }, scope: { ...scope, runnerId:runner.id, workspaceId, cwd, relevancePath, repositoryPath } };
  }
  async function observeRoot(root, scope, signal) {
    sources.assertRead(root.id,scope);
    const location = host(root, scope);
    if (typeof runners.skillFiles !== 'function') throw new Error('Runner does not support skill source operations.');
    try {
      const result = await runners.skillFiles(location.runner, { operation:'discover', root:location.root }, signal);
      sources.observe(root.id, {...location.context,repositoryRevision:result.repositoryRevision ?? location.context.repositoryRevision}, result, location.scope);
      return location;
    } catch (error) {
      sources.disconnect(root.runnerId);
      throw error;
    }
  }
  async function reconcile(scope, signal) {
    const denied = new Map();
    for (const root of sources.catalogue(scope).roots) {
      if (root.removed) continue;
      let authorized;
      try {
        authorized = await authorize({action:'refreshSkills',rootId:root.id,projectId:scope.projectId,runnerId:root.runnerId,workspaceId:scope.workspaceId,workingDirectory:scope.workingDirectory,execution:true},scope.principal);
      } catch { denied.set(root.id,'Runner access denied.');continue; }
      try {sources.assertRead(root.id,authorized);} catch(error) {denied.set(root.id,error.message);continue;}
      try { await observeRoot(root, { ...authorized, cwd:scope.cwd }, signal); } catch {
        sources.disconnect(root.runnerId);
      }
    }
    await save();
    const catalogue=sources.catalogue(scope);
    catalogue.roots=catalogue.roots.map(root=>denied.has(root.id)?{...root,writable:false}:root);
    catalogue.sources=catalogue.sources.map(source=>denied.has(source.rootId)?{...source,instances:source.instances.map(instance=>({...instance,state:'denied',diagnostic:denied.get(source.rootId)}))}:source);
    return catalogue;
  }
  async function read(sourceId, scope, signal) {
    let source = sources.source(sourceId, scope);
    const authorized = await authorize({action:'readSkillSource',sourceId,runnerId:scope.runnerId,workspaceId:scope.workspaceId,projectId:scope.projectId,workingDirectory:scope.workingDirectory,execution:true},scope.principal);
    scope={...authorized,cwd:scope.cwd};
    const root = sources.assertRead(source.rootId, scope), location = host(root, scope);
    const capture = await runners.skillFiles(location.runner, { operation:'capture', root:location.root, relativePath:source.relativeDirectory }, signal);
    sources.observe(root.id, {...location.context,repositoryRevision:capture.repositoryRevision ?? location.context.repositoryRevision}, { complete:false, packages:[capture], diagnostics:[] }, location.scope);
    source = sources.source(sourceId, location.scope);
    const instance = source.instances.find(value => value.runnerId === location.runner.id && value.workspaceId === location.context.workspaceId);
    if (!instance || instance.state !== 'current') throw new Error(instance?.diagnostic ?? 'Skill source is unavailable.');
    let writable = false;
    try { sources.assertWrite(root.id, location.scope); writable = true; } catch {}
    await save();
    return { source, instance, files:capture.files, digest:capture.digest, writable };
  }
  function assertMutation(result) {
    if (result.status === 'conflict') throw Object.assign(new Error('Skill files changed. Reload or compare before saving.'), { code:'CONFLICT', status:409 });
    if (result.status !== 'saved') throw Object.assign(new Error(result.message ?? 'Skill save is uncertain. Inspect and reconcile before retrying.'), { code:'UNCERTAIN', status:409 });
  }
  async function install(rootId, relativeDirectory, files, scope, command, operation = 'save') {
    if (command.trusted !== true) throw new Error('Review the imported instructions and resources before installing.');
    const root = sources.assertWrite(rootId, scope), location = host(root, scope);
    if (location.root.skillRootPaths && !location.root.skillRootPaths.some(path=>relativeDirectory.includes(path+'/')))
      relativeDirectory=join(relative(location.root.repositoryPath,location.root.path),relativeDirectory);
    const result = await runners.skillFiles(location.runner, { operation, root:location.root, relativePath:relativeDirectory, files, expectedDigest:null, requestId:command.requestId ?? randomUUID() });
    assertMutation(result);
    sources.observe(root.id, location.context, { complete:false, packages:[result], diagnostics:[] }, location.scope);
    await save();
    return sources.catalogue(location.scope).sources.find(value => value.rootId === root.id && value.relativeDirectory === relativeDirectory);
  }
  async function captureSelections(selections, scope, signal) {
    const validated = sources.validateSelections(selections, scope), captured = [];
    for (const selection of validated) {
      if (selection.mode === 'snapshot-pinned') { captured.push(sources.snapshot(selection, scope)); continue; }
      const data = await read(selection.sourceId, scope, signal);
      const location = host(sources.root(data.source.rootId,scope),scope);
      captured.push(sources.capture(data.source.id, data.instance.id, data.digest, location.scope));
    }
    await save();
    return captured;
  }
  function subscribe(root, actor) {
    subscriptions.get(root.id)?.();
    if (!runners.watchSkillRoots || closed) return;
    const runner = state.runners.find(value => value.id === root.runnerId);
    if (!runner) return;
    subscriptions.set(root.id, runners.watchSkillRoots(runner, [root], () => enqueue(async () => {
      if (closed) return;
      const scope = await authorize({ action:'refreshSkills', rootId:root.id, projectId:root.projectId, runnerId:root.runnerId, background:true }, actor);
      await reconcile(scope);
    })));
  }
  async function command(command, actor) {
    const scope = await authorize(command, actor);
    if (command.action === 'registerSkillRoot') {
      const runner = state.runners.find(value => value.id === command.runnerId && value.organizationId === scope.organizationId);
      if (!runner) throw new Error('Skill runner unavailable.');
      if (command.scope === 'project' && (!runner.projectIds.includes(command.projectId) || !within(runner.repository, resolve(command.path)))) throw new Error('Project skill root must belong to its registered repository.');
      const approval = await runners.skillFiles(runner,{operation:'approve',root:{path:command.path,allowSymlinks:command.allowSymlinks, ...(command.scope==='project'?{repositoryPath:runner.repository}:{})}});
      const root = sources.registerRoot({...command,...approval}, scope);
      await reconcile({ ...scope, runnerId:root.runnerId }); subscribe(root, actor); await save(); return root;
    }
    if (command.action === 'unregisterSkillRoot') {
      const result = sources.unregisterRoot(command.rootId, command.expectedRevision, scope);
      subscriptions.get(command.rootId)?.(); subscriptions.delete(command.rootId); await save(); return result;
    }
    if(command.action==='updateSkillRoot') {
      const changes=Object.fromEntries(['readable','writable','trusted'].filter(key=>command[key]!==undefined).map(key=>[key,command[key]]));
      const result=sources.updateRoot(command.rootId,command.expectedRevision,changes,scope);
      await save();return result;
    }
    if (['catalogueSkills','refreshSkills'].includes(command.action)) return reconcile(scope);
    if (command.action === 'readSkillSource') return read(command.sourceId, scope);
    if (command.action === 'saveSkillSource') {
      const source = sources.source(command.sourceId, scope), root = sources.assertWrite(source.rootId, scope), location = host(root, scope);
      const result = await runners.skillFiles(location.runner, { operation:'save', root:location.root, relativePath:source.relativeDirectory, expectedDigest:command.expectedDigest, files:command.files, requestId:command.requestId ?? randomUUID() });
      assertMutation(result);
      sources.observe(root.id, location.context, { complete:false, packages:[result], diagnostics:[] }, location.scope);
      await save(); return read(source.id, location.scope);
    }
    if (command.action === 'createSkillSource') return install(command.rootId,command.relativeDirectory,command.files,scope,command);
    if (command.action === 'saveStoredSkillToFolder') {
      const bundle = capabilities.command({ action:'exportSkill', organizationId:scope.organizationId, name:command.name, version:command.version });
      return install(command.rootId,command.relativeDirectory,Object.entries(bundle.files).map(([path,content])=>({path,content,encoding:'utf8'})),scope,command);
    }
    if (command.action === 'captureSkillSelections') return captureSelections(command.selections,scope);
    if (command.action === 'provisionSkillSnapshot') {
      const snapshot = sources.snapshot({snapshotId:command.snapshotId},scope);
      sources.assertProvision({snapshotId:snapshot.id},command.targetRootId,scope);
      const installed=await install(command.targetRootId,command.relativeDirectory,snapshot.files,scope,command,'provision');
      const result=sources.recordProvision(installed.id,{snapshotId:snapshot.id},scope);
      await save();return result;
    }
    if (['inspectSkillMutation','reconcileSkillMutation'].includes(command.action)) {
      const source = command.sourceId ? sources.source(command.sourceId,scope) : undefined;
      const root = sources.assertWrite(source?.rootId ?? command.rootId,scope), location = host(root,scope);
      let relativePath=source?.relativeDirectory ?? command.relativeDirectory;
      if(!source && location.root.skillRootPaths && !location.root.skillRootPaths.some(path=>relativePath.includes(path+'/')))
        relativePath=join(relative(location.root.repositoryPath,location.root.path),relativePath);
      const result = await runners.skillFiles(location.runner, { operation:command.action==='inspectSkillMutation'?'inspect':'reconcile', root:location.root, relativePath, expectedDigest:command.expectedDigest ?? null, requestId:command.requestId });
      if (command.action === 'reconcileSkillMutation') await reconcile(scope);
      return result;
    }
    throw new Error('Unknown skill source command.');
  }
  async function captureSession(session, actor, signal) {
    const selections = session.capabilityProfile?.skillSelections ?? [];
    if (!selections.length) return;
    const scope = await authorize({action:'captureSkillSelections',projectId:session.projectId,runnerId:session.runnerId,workspaceId:session.workspace?.path ? session.id : undefined,workingDirectory:session.workingDirectory,execution:true},actor);
    if (session.skillSnapshots) {
      for (const ref of session.skillSnapshots) sources.snapshot(ref,scope);
      return;
    }
    const workflowRefs = session.workflow?.skillSnapshots;
    const snapshots = workflowRefs && session.workflow?.capabilityProfile?.id === session.capabilityProfile.id && session.workflow.capabilityProfile.version === session.capabilityProfile.version
      ? workflowRefs.map(ref=>sources.snapshot(ref,scope)) : await captureSelections(selections,scope,signal);
    assertDeclaredSkills(session.workflow,session.capabilityProfile,snapshots);
    session.skillSnapshots=snapshots.map(value=>({snapshotId:value.id,digest:value.digest}));
    await save();
  }
  async function pinWorkflow(command, actor) {
    const {skillSnapshots:ignored,...workflow} = command.workflow;
    command={...command,workflow};
    const effectiveProfile=workflow.capabilityProfile ?? state.projectProfiles?.[command.projectId];
    if (!effectiveProfile) {
      assertDeclaredSkills(workflow,null,[]);
      return {...command,workflow:{...workflow,capabilityProfilePinned:true}};
    }
    const organizationId = command.organizationId;
    const profile = state.capabilityProfiles.find(value=>value.id===effectiveProfile.id&&value.version===effectiveProfile.version&&value.organizationId===organizationId);
    if (!profile) throw new Error('Workflow profile revision unavailable.');
    if (!profile.skillSelections?.length) {
      assertDeclaredSkills(workflow,profile,[]);
      return {...command,workflow:{...workflow,capabilityProfilePinned:true,capabilityProfile:{id:profile.id,version:profile.version}}};
    }
    const scope = await authorize({action:'captureSkillSelections',projectId:command.projectId,execution:true},actor);
    const snapshots = await captureSelections(profile.skillSelections,scope);
    assertDeclaredSkills(workflow,profile,snapshots);
    return { ...command, workflow:{...workflow,capabilityProfilePinned:true,capabilityProfile:{id:profile.id,version:profile.version},skillSnapshots:snapshots.map(value=>({snapshotId:value.id,digest:value.digest,sourceId:value.sourceId}))} };
  }
  function assertDeclaredSkills(workflow,profile,snapshots) {
    const available=new Set([...(profile?.skills ?? []).map(value=>value.name),...snapshots.map(value=>value.name)]);
    for(const node of workflow?.nodes ?? workflow?.steps ?? [])for(const name of node.skills ?? [])
      if(!available.has(name))throw new Error(`Workflow skill ${name} is not selected in its captured profile.`);
  }
  function restore() {
    for (const root of state.skillRoots ?? []) if(!root.removed && root.registeredBy) subscribe(root,root.registeredBy);
  }
  function close() {closed=true;for(const stop of subscriptions.values())stop();subscriptions.clear();}
  return { command, captureSession, pinWorkflow, captureSelections, reconcile, restore, close };
}
