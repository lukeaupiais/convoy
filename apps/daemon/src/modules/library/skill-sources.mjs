import { createHash, randomUUID } from 'node:crypto';
import { skillPackageDigest } from '../../../../../packages/runner/src/index.mjs';
import { parseSkill } from './capabilities.mjs';

const clone = structuredClone;
const key = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const within = (path, parent) => path === parent || path.startsWith(parent.replace(/\/$/, '') + '/');
const directory = (value) => value === '' || relative(value);
const relative = (value) => typeof value === 'string' && value.length <= 240 && value.split('/').every(p => p && p !== '.' && p !== '..') && !/[\\\x00-\x1f]/.test(value) && !value.startsWith('/');

/** Identity, authorization and immutable capture. File IO belongs to runner adapters. */
export function createSkillSources({ state, now = () => new Date().toISOString() }) {
  for (const name of ['skillRoots', 'skillSources', 'skillSourceInstances', 'skillSnapshots']) state[name] ??= [];
  const projectWritable = (scope, projectId) => Array.isArray(scope.projectWriteIds) ? scope.projectWriteIds.includes(projectId) : scope.canWriteProject === true;
  function permitted(record, scope) {
    if (!scope?.organizationId || record.organizationId !== scope.organizationId) return false;
    if (record.scope === 'personal') return !!scope.userId && record.ownerUserId === scope.userId;
    if (record.scope === 'project') return scope.projectId ? record.projectId === scope.projectId : scope.projectIds?.includes(record.projectId);
    return true;
  }
  function root(id, scope, includeRemoved = false) {
    const value = state.skillRoots.find(r => r.id === id && (includeRemoved || !r.removed) && permitted(r, scope));
    if (!value) throw new Error('Skill root unavailable or denied.');
    return clone(value);
  }
  function source(id, scope) {
    const value = state.skillSources.find(r => r.id === id && permitted(r, scope));
    if (!value) throw new Error('Skill source unavailable or denied.');
    const locations = value.registrations ?? [{rootId:value.rootId,relativeDirectory:value.relativeDirectory}];
    const active = locations.find(location=>state.skillRoots.some(r=>r.id===location.rootId&&!r.removed&&permitted(r,scope)&&(!scope.runnerId||r.runnerId===scope.runnerId)));
    if(!active)throw new Error('Skill root unavailable or denied.');
    const {registrations:ignored,aliasRootIds:ignoredAliases,...visible}=value;
    const instances=state.skillSourceInstances.filter(i => i.sourceId === id && (!scope.runnerId || i.runnerId === scope.runnerId) && (!scope.workspaceId || i.workspaceId === scope.workspaceId));
    const observed=instances.filter(i=>i.name&&i.description);
    const identical=observed.length && observed.every(i=>i.name===observed[0].name&&i.description===observed[0].description);
    return clone({...visible, rootId:active.rootId,relativeDirectory:active.relativeDirectory,name:identical?observed[0].name:(active.relativeDirectory.split('/').at(-1)||'Skill'),description:identical?observed[0].description:'',instances});
  }
  function assertRead(id, scope) {
    const value=root(id,scope);if(!value.readable)throw new Error('Read access to the skill root is denied.');return value;
  }
  function assertWrite(id, scope) {
    const r = root(id, scope);
    if (!r.writable || !r.readable || (r.scope === 'organization' && !scope.canManageOrganization) || (r.scope === 'project' && !projectWritable(scope,r.projectId))) throw new Error('Skill source is read-only or write access denied.');
    if (scope.runnerId && scope.runnerId !== r.runnerId) throw new Error('Skill root belongs to another runner.');
    return r;
  }
  function registerRoot(command, scope) {
    const value = command.root ?? command;
    if (!scope?.organizationId || !['personal','project','organization'].includes(value.scope) || typeof value.path !== 'string' || !value.path.startsWith('/') || /[\x00-\x1f]/.test(value.path) || !value.runnerId || !value.executionIdentity) throw new Error('Invalid skill root.');
    if (value.scope === 'personal' && (!scope.userId || !scope.executionIdentities?.some(i => i.runnerId === value.runnerId && i.executionIdentity === value.executionIdentity))) throw new Error('Personal skill root requires an authorized execution identity.');
    if (value.scope === 'project' && (!value.projectId || !projectWritable(scope,value.projectId) || !(value.projectId === scope.projectId || scope.projectIds?.includes(value.projectId)))) throw new Error('Project skill root access denied.');
    if (value.scope === 'organization' && !scope.canManageOrganization) throw new Error('Organization skill roots require management access.');
    const owner = value.scope === 'personal' ? scope.userId : value.scope === 'project' ? value.projectId : scope.organizationId;
    const duplicate = state.skillRoots.find(r => !r.removed && r.organizationId === scope.organizationId && r.scope === value.scope && (r.ownerUserId ?? r.projectId ?? r.organizationId) === owner && r.runnerId === value.runnerId && r.path === value.path);
    if (duplicate) return root(duplicate.id, scope);
    const record = { id: randomUUID(), revision: 1, registeredBy: clone(scope.principal ?? {kind:'user',userId:scope.userId}), organizationId: scope.organizationId, scope: value.scope,
      ...(value.scope === 'personal' ? { ownerUserId: scope.userId } : {}), ...(value.scope === 'project' ? {projectId:value.projectId, repositoryId:value.repositoryId} : {}),
      runnerId: value.runnerId, executionIdentity:value.executionIdentity, path:value.path,
      ...(value.approvedCanonicalPath ? {approvedCanonicalPath:value.approvedCanonicalPath} : {}),
      ...(value.approvedRepositoryPath ? {approvedRepositoryPath:value.approvedRepositoryPath} : {}),
      ...((value.relevancePath ?? (value.scope==='project' ? value.path.replace(/\/(?:\.agents|\.claude|\.github|\.cursor|\.codex)\/skills\/?$/, '') : undefined)) ? {relevancePath:value.relevancePath ?? value.path.replace(/\/(?:\.agents|\.claude|\.github|\.cursor|\.codex)\/skills\/?$/, '')} : {}), provenance:value.provenance ?? (value.scope === 'project' ? 'project' : value.scope === 'organization' ? 'managed' : 'user'),
      readable:value.readable !== false, writable:value.writable === true, trusted:value.trusted === true, allowSymlinks:value.allowSymlinks === true };
    state.skillRoots.push(record); return clone(record);
  }
  function observe(rootId, context, result, scope) {
    const r = root(rootId, scope);
    if (context.runnerId !== r.runnerId || !context.workspaceId) throw new Error('Skill observation runner/workspace mismatch.');
    const touched = new Set();
    const storedRoot=state.skillRoots.find(root=>root.id===rootId);
    storedRoot.observations ??= [];
    const rootDiagnostic=(result.diagnostics??[]).find(item=>item.relativeDirectory==='');
    const previousRoot=storedRoot.observations.find(observation=>observation.runnerId===context.runnerId&&observation.workspaceId===context.workspaceId);
    const rootObservation={runnerId:context.runnerId,workspaceId:context.workspaceId,state:rootDiagnostic?.code??'current',...(rootDiagnostic?{message:rootDiagnostic.message}:{}),observedAt:now()};
    if(previousRoot){delete previousRoot.message;Object.assign(previousRoot,rootObservation);}else storedRoot.observations.push(rootObservation);
    for (const item of [...(result.packages ?? []), ...(result.diagnostics ?? [])]) {
      if (!directory(item.relativeDirectory) || (item.code && item.relativeDirectory==='')) continue;
      let s = state.skillSources.find(s => (s.registrations ?? [{rootId:s.rootId,relativeDirectory:s.relativeDirectory}]).some(location=>location.rootId===rootId&&location.relativeDirectory===item.relativeDirectory));
      if (!s && item.canonicalPath) { const alias=state.skillSourceInstances.find(i=>i.state==='current'&&state.skillSources.some(s=>s.id===i.sourceId&&(s.registrations??[{rootId:s.rootId}]).some(location=>state.skillRoots.some(r=>r.id===location.rootId&&!r.removed)))&&i.runnerId===context.runnerId&&i.workspaceId===context.workspaceId&&i.path===item.canonicalPath&&state.skillSources.some(candidate=>candidate.id===i.sourceId&&candidate.organizationId===r.organizationId&&candidate.scope===r.scope&&candidate.ownerUserId===r.ownerUserId&&candidate.projectId===r.projectId)); if(alias)s=state.skillSources.find(s=>s.id===alias.sourceId); }
      if (!s) { s = { id:key(rootId,item.relativeDirectory), rootId, organizationId:r.organizationId, scope:r.scope, ownerUserId:r.ownerUserId, projectId:r.projectId, relativeDirectory:item.relativeDirectory, name:item.relativeDirectory.split('/').at(-1), description:'' }; state.skillSources.push(s); }
      s.registrations ??= [{rootId:s.rootId,relativeDirectory:s.relativeDirectory}];
      if(!s.registrations.some(location=>location.rootId===rootId&&location.relativeDirectory===item.relativeDirectory))s.registrations.push({rootId,relativeDirectory:item.relativeDirectory});
      s.aliasRootIds ??= [];if(s.rootId!==rootId&&!s.aliasRootIds.includes(rootId))s.aliasRootIds.push(rootId);
      const id = key(s.id,context.runnerId,context.workspaceId);
      touched.add(id);
      const previous = state.skillSourceInstances.find(i => i.id === id);
      const instance = {id,sourceId:s.id,runnerId:context.runnerId,workspaceId:context.workspaceId,repositoryRevision:context.repositoryRevision,path:item.canonicalPath ?? `${r.path}/${s.relativeDirectory}`,observedAt:now(),generation:(previous?.generation ?? 0)+1,state:'current'};
      if (item.code) { instance.state = item.code === 'missing' ? 'missing' : item.code === 'unreadable' ? 'unreadable' : item.code === 'unstable' ? 'unstable' : 'invalid'; instance.diagnostic=item.message; }
      else {
        try {
          const files = item.files;
          if (!Array.isArray(files) || files.length > 256 || files.reduce((total,f)=>total+Buffer.byteLength(f.content ?? '', f.encoding === 'base64' ? 'base64' : 'utf8'),0)>4194304 || files.some(f => !relative(f.path) || !['utf8','base64'].includes(f.encoding) || typeof f.content !== 'string')) throw new Error('Unsupported or invalid skill resource.');
          const text = Object.fromEntries(files.filter(f=>f.encoding === 'utf8' && f.path === 'SKILL.md').map(f=>[f.path,f.content]));
          const parsed = parseSkill(text);
          // Parse metadata without discarding binary resources from the immutable package.
          if (!item.digest || item.digest !== skillPackageDigest(files) || new Set(files.map(f=>f.path)).size !== files.length) throw new Error('Missing digest or duplicate resources.');
          instance.name=parsed.name; instance.description=parsed.description;
          instance.warnings=parsed.warnings; instance.digest=item.digest; instance.relevanceBoundary=item.relevanceBoundary; instance.package={name:parsed.name,description:parsed.description,body:parsed.body,warnings:parsed.warnings,files:clone(files)};
        } catch(error) { instance.state='invalid'; instance.diagnostic=error.message; }
      }
      instance.registrations=clone(previous?.registrations ?? []);
      const location=instance.registrations.find(location=>location.rootId===rootId);
      if(location)Object.assign(location,{relativeDirectory:item.relativeDirectory,state:instance.state});else instance.registrations.push({rootId,relativeDirectory:item.relativeDirectory,state:instance.state});
      if (previous) { if(!instance.diagnostic)delete previous.diagnostic;Object.assign(previous,instance); } else state.skillSourceInstances.push(instance);
    }
    if (result.complete !== false) for (const i of state.skillSourceInstances.filter(i=>i.runnerId===context.runnerId && i.workspaceId===context.workspaceId && state.skillSources.some(s=>s.id===i.sourceId&&(s.rootId===rootId||s.aliasRootIds?.includes(rootId))))) if (!touched.has(i.id)) {for(const location of i.registrations??[])if(location.rootId===rootId)location.state='missing';if(!(i.registrations??[]).some(location=>location.state==='current'&&state.skillRoots.some(r=>r.id===location.rootId&&!r.removed))){i.state='missing';i.diagnostic='Skill directory was removed.';delete i.package;}i.observedAt=now();}
    return catalogue(scope);
  }
  function catalogue(scope) {
    const roots=state.skillRoots.filter(r=>!r.removed && permitted(r,scope)&&(!scope.scope || r.scope===scope.scope)&&(!scope.runnerId||r.runnerId===scope.runnerId));
    return {roots:roots.map(({registeredBy,observations,...r})=>clone({...r,manageable:r.scope==='personal'||(r.scope==='organization'?scope.canManageOrganization===true:projectWritable(scope,r.projectId)),writable:r.readable&&r.writable&&(r.scope==='personal'||(r.scope==='organization'?scope.canManageOrganization===true:projectWritable(scope,r.projectId))),diagnostics:(observations??[]).filter(observation=>observation.state!=='current'&&(!scope.runnerId||observation.runnerId===scope.runnerId)&&(!scope.workspaceId||observation.workspaceId===scope.workspaceId))})),sources:state.skillSources.filter(s=>roots.some(r=>r.id===s.rootId||s.aliasRootIds?.includes(r.id))).map(s=>{const value=source(s.id,scope);delete value.canonicalPath;delete value.aliasRootIds;value.instances=value.instances.map(({package:ignored,registrations:ignoredLocations,...instance})=>roots.find(root=>root.id===value.rootId)?.readable===false ? {...instance,state:'denied',diagnostic:'Read access to the skill root is denied.'} : instance);return value;})};
  }
  function relevant(s,r,scope) {
    if (r.scope === 'project' && r.relevancePath && (!scope.cwd || !within(scope.cwd,scope.relevancePath ?? r.relevancePath))) throw new Error('Skill source is outside the working-directory relevance boundary.');
    if (!r.readable) throw new Error('Skill source access denied.');
  }
  function capture(sourceId, instanceId, expectedDigest, scope) {
    const s=source(sourceId,scope);const r=root(s.rootId,scope);relevant(s,r,scope);
    const instance=state.skillSourceInstances.find(i=>i.id===instanceId&&i.sourceId===sourceId&&(!scope.runnerId||i.runnerId===scope.runnerId)&&(!scope.workspaceId||i.workspaceId===scope.workspaceId));
    if (!instance || instance.state!=='current' || !instance.package || instance.digest!==expectedDigest) throw new Error('Skill source changed or is unavailable; reconcile before capture.');
    if (instance.relevanceBoundary && (!scope.cwd || !within(scope.cwd, `${scope.repositoryPath ?? r.path}/${instance.relevanceBoundary}`))) throw new Error('Skill source is outside its nested directory relevance boundary.');
    if (!r.trusted) throw new Error('Skill source requires trust review before execution.');
    const id=key(sourceId,instance.id,instance.digest,instance.repositoryRevision);
    let value=state.skillSnapshots.find(s=>s.id===id);
    if (!value) {value={id,sourceId,rootId:r.id,organizationId:r.organizationId,scope:r.scope,ownerUserId:r.ownerUserId,projectId:r.projectId,digest:instance.digest,...clone(instance.package),trusted:r.trusted,runnerId:instance.runnerId,workspaceId:instance.workspaceId,instanceId:instance.id,path:instance.path,repositoryRevision:instance.repositoryRevision,capturedAt:now()};state.skillSnapshots.push(value);}
    return clone(value);
  }
  function snapshot(ref,scope) {
    const value=state.skillSnapshots.find(s=>s.id===(ref.snapshotId??ref.id)&&permitted(s,scope));
    if (!value || (ref.digest&&ref.digest!==value.digest)) throw new Error('Skill snapshot unavailable or denied.');
    const r=root(value.rootId,scope,true);if (!r.readable||!r.trusted) throw new Error('Skill snapshot policy was revoked.');
    return clone(value);
  }
  function canInspectSelections(selections,scope) {
    return (selections ?? []).every(selection=>{
      const record=selection.mode==='source-current' ? state.skillSources.find(s=>s.id===selection.sourceId) : state.skillSnapshots.find(s=>s.id===selection.snapshotId);
      return !!record && permitted(record,scope);
    });
  }
  function validateSelections(selections,scope) {
    if (!Array.isArray(selections)||selections.length>30) throw new Error('Select a bounded skill list.');
    const keys=new Set();
    return selections.map(selection=>{if(!selection||typeof selection!=='object'||Array.isArray(selection))throw new Error('Invalid skill selection.');if(selection.mode==='source-current'){if(typeof selection.sourceId!=='string'||!selection.sourceId||selection.sourceId.length>240)throw new Error('Invalid skill source identity.');source(selection.sourceId,scope);}else if(selection.mode==='snapshot-pinned'){if(typeof selection.snapshotId!=='string'||!selection.snapshotId||selection.snapshotId.length>240||typeof selection.digest!=='string'||!/^[a-f0-9]{64}$/.test(selection.digest))throw new Error('Pinned skill selections require an exact snapshot identity and digest.');snapshot(selection,scope);}else throw new Error('Invalid skill selection.');const identity=selection.sourceId??selection.snapshotId;if(keys.has(identity)) throw new Error('Duplicate skill selection.');keys.add(identity);return clone(selection);});
  }
  function resolveSelections(selections,scope) {
    return validateSelections(selections,scope).map(selection=>{if(selection.mode==='snapshot-pinned')return snapshot(selection,scope);const s=source(selection.sourceId,scope);const instances=s.instances.filter(i=>i.state==='current');if(instances.length!==1)throw new Error('Select one available skill runner/workspace instance.');return capture(s.id,instances[0].id,instances[0].digest,scope);});
  }
  function assertProvision(snapshotRef, targetRootId, scope) {
    const captured=snapshot(snapshotRef,scope);
    const destination=assertWrite(targetRootId,scope);
    if(destination.organizationId!==captured.organizationId || destination.scope!==captured.scope || destination.ownerUserId!==captured.ownerUserId || destination.projectId!==captured.projectId)throw new Error('Snapshot provisioning must preserve its ownership and visibility.');
    return destination;
  }
  function recordProvision(sourceId, snapshotRef, scope) {
    const target=source(sourceId,scope);
    const captured=snapshot(snapshotRef,scope);
    assertProvision(snapshotRef,target.rootId,scope);
    if(!target.instances.some(instance=>instance.state==='current'&&instance.digest===captured.digest))throw new Error('Provisioned source does not match the copied snapshot.');
    const stored=state.skillSources.find(source=>source.id===sourceId);
    stored.provisionedFrom={snapshotId:captured.id,digest:captured.digest,sourceId:captured.sourceId,runnerId:captured.runnerId};
    return source(sourceId,scope);
  }
  function updateRoot(id, expectedRevision, changes, scope) {
    const value=root(id,scope);
    if((value.scope==='organization'&&!scope.canManageOrganization)||(value.scope==='project'&&!projectWritable(scope,value.projectId)))throw new Error('Skill root management access denied.');
    if(value.revision!==expectedRevision)throw new Error('Skill root changed; reload before updating.');
    if(!changes || Object.keys(changes).some(field=>!['readable','writable','trusted'].includes(field)) || Object.values(changes).some(value=>typeof value!=='boolean'))throw new Error('Only explicit read, write and trust policy may be updated.');
    const stored=state.skillRoots.find(root=>root.id===id);Object.assign(stored,changes);stored.revision+=1;
    return root(id,scope);
  }
  function unregisterRoot(id, expectedRevision, scope) {
    const value=root(id,scope);if((value.scope==='organization'&&!scope.canManageOrganization)||(value.scope==='project'&&!projectWritable(scope,value.projectId)))throw new Error('Skill root management access denied.');if(value.revision!==expectedRevision)throw new Error('Skill root changed; reload before removing.');
    const stored=state.skillRoots.find(r=>r.id===id);stored.removed=true;stored.revision+=1;
    // Retain records and immutable snapshots for audit; removal revokes new resolution.
    for(const i of state.skillSourceInstances)if(state.skillSources.some(s=>s.id===i.sourceId&&(s.rootId===id||s.aliasRootIds?.includes(id)))){for(const location of i.registrations??[])if(location.rootId===id)location.state='missing';if(!(i.registrations??[]).some(location=>location.state==='current'&&state.skillRoots.some(r=>r.id===location.rootId&&!r.removed))){i.state='missing';delete i.package;}}
    return {removed:true};
  }
  function roots(scope) { return catalogue(scope).roots; }
  function disconnect(runnerId) {for(const i of state.skillSourceInstances)if(i.runnerId===runnerId){i.state='disconnected';i.diagnostic='Runner disconnected; reconciliation required.';delete i.package;}}
  return {registerRoot,updateRoot,unregisterRoot,roots,root,source,assertRead,assertWrite,assertProvision,recordProvision,observe,catalogue,capture,snapshot,canInspectSelections,validateSelections,resolveSelections,disconnect};
}
