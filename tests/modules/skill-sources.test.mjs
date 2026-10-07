import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSkillSources,createCapabilities} from '../../apps/daemon/src/modules/library/index.mjs';
import {skillPackageDigest} from '../../packages/runner/src/index.mjs';
const scope={organizationId:'north',userId:'alice',projectId:'code',canWriteProject:true,canManageOrganization:true,executionIdentities:[{runnerId:'local',executionIdentity:'os-alice'}],runnerId:'local',workspaceId:'main',cwd:'/repo/packages/api'};
const files=(body='Review code',resource='one')=>[{path:'SKILL.md',encoding:'utf8',content:`---\nname: review\ndescription: Review a bounded subject\n---\n${body}`},{path:'references/check.md',encoding:'utf8',content:resource},{path:'assets/example.bin',encoding:'base64',content:'AP8='}];
const observe=(domain,root,content=files(),workspaceId='main',extra={})=>domain.observe(root.id,{runnerId:'local',workspaceId}, {packages:[{relativeDirectory:'review',canonicalPath:'/repo/review',digest:skillPackageDigest(content),files:content}],...extra},scope);
function setup(kind='personal'){const state={sessions:{},projects:[],runners:[]};const domain=createSkillSources({state});const root=domain.registerRoot({scope:kind,path:'/repo',runnerId:'local',executionIdentity:'os-alice',projectId:'code',writable:true,trusted:true},scope);return {state,domain,root};}
test('personal roots require execution association and isolate users and organizations',()=>{
 const {domain,root}=setup();observe(domain,root);assert.equal(domain.catalogue(scope).sources.length,1);
 assert.equal(domain.catalogue({...scope,userId:'bob'}).sources.length,0);assert.equal(domain.catalogue({...scope,organizationId:'south'}).sources.length,0);
 assert.throws(()=>domain.registerRoot({scope:'personal',path:'/private',runnerId:'local',executionIdentity:'other'},scope),/authorized execution identity/);
 assert.throws(()=>domain.source(domain.catalogue(scope).sources[0].id,{...scope,userId:'bob'}),/denied/);
});
test('project roots retain directory relevance and unrelated inventory project isolation',()=>{
 const {domain,root}=setup('project');assert.equal(domain.catalogue({...scope,projectId:'inventory'}).sources.length,0);
 const nested=domain.registerRoot({scope:'project',projectId:'code',path:'/repo/packages/api/.agents/skills',relevancePath:'/repo/packages/api',runnerId:'local',executionIdentity:'os-alice',writable:true,trusted:true},scope);observe(domain,nested);
 const source=domain.catalogue(scope).sources[0];assert.throws(()=>domain.capture(source.id,source.instances[0].id,source.instances[0].digest,{...scope,cwd:'/repo/packages/web'}),/relevance/);
 assert.equal(domain.capture(source.id,source.instances[0].id,source.instances[0].digest,scope).name,'review');assert(root);
});
test('worktree instances never overwrite each other and complete binary resources are immutable',()=>{
 const {domain,root}=setup();observe(domain,root);const s=domain.catalogue(scope).sources[0];const captured=domain.capture(s.id,s.instances[0].id,s.instances[0].digest,scope);
 observe(domain,root,files('Inventory analysis','different'),'other');assert.equal(domain.source(s.id,scope).instances[0].digest,captured.digest);
 observe(domain,root,files('Changed future','new'));assert.equal(domain.snapshot({snapshotId:captured.id},scope).body,'Review code');assert.equal(captured.files.find(f=>f.encoding==='base64').content,'AP8=');
 domain.unregisterRoot(root.id,1,scope);assert.equal(domain.catalogue(scope).sources.length,0);assert.equal(domain.snapshot({snapshotId:captured.id},scope).body,'Review code');
});
test('missing, disconnected, invalid and forged captures fail closed without affecting other sources',()=>{
 const {domain,root}=setup();observe(domain,root);const s=domain.catalogue(scope).sources[0];const i=s.instances[0];
 domain.observe(root.id,{runnerId:'local',workspaceId:'main'},{packages:[{relativeDirectory:'broken',canonicalPath:'/repo/broken',digest:'forged',files:files()}],complete:false},scope);
 assert.equal(domain.source(s.id,scope).instances[0].state,'current');assert.equal(domain.catalogue(scope).sources.find(s=>s.relativeDirectory==='broken').instances[0].state,'invalid');
 domain.disconnect('local');assert.throws(()=>domain.capture(s.id,i.id,i.digest,scope),/unavailable/);observe(domain,root);assert.equal(domain.source(s.id,scope).instances[0].state,'current');
 domain.observe(root.id,{runnerId:'local',workspaceId:'main'},{packages:[]},scope);assert.throws(()=>domain.resolveSelections([{mode:'source-current',sourceId:s.id}],scope),/available/);
});
test('same names remain explicit identities and pinned source resource reads survive edits',()=>{
 const {state,domain,root}=setup();observe(domain,root);const orgRoot=domain.registerRoot({scope:'organization',path:'/org',runnerId:'local',executionIdentity:'managed',writable:true,trusted:true},scope);observe(domain,orgRoot,files('Organization procedure'));
 const sources=domain.catalogue(scope).sources;assert.equal(sources.length,2);assert.notEqual(sources[0].id,sources[1].id);
 const snapshots=domain.resolveSelections(sources.map(s=>({mode:'source-current',sourceId:s.id})),scope);
 const capabilities=createCapabilities({state,skillSources:domain});const session={projectId:'code',skillUserId:'alice',skillSnapshots:snapshots.map(s=>({snapshotId:s.id,digest:s.digest}))};state.projects=[{id:'code',organizationId:'north'}];
 assert.throws(()=>capabilities.load(session,null,'review'),/ambiguous/);assert.match(capabilities.load(session,null,snapshots[0].id).content,/Review code/);
 assert.equal(capabilities.load(session,null,snapshots[0].id,'references/check.md').content,'one');assert.equal(capabilities.load(session,null,snapshots[0].id,'assets/example.bin').encoding,'base64');
 state.skillRoots.find(r=>r.id===root.id).trusted=false;assert.throws(()=>capabilities.load(session,null,snapshots[0].id),/revoked/);
});
test('profile publication preserves explicit source mode and legacy selections until opt-in migration',()=>{
 const {state,domain,root}=setup();observe(domain,root);const source=domain.catalogue(scope).sources[0];const capabilities=createCapabilities({state,skillSources:domain});
 const selected={mode:'source-current',sourceId:source.id};const profile=capabilities.command({action:'publishProfile',organizationId:'north',projectId:'code',id:'reviewer',name:'Reviewer',tools:[],skills:[],skillSelections:[selected],skillScope:scope});
 assert.deepEqual(profile.skillSelections,[selected]);assert.deepEqual(capabilities.profileSelections(profile,'north'),[selected]);
 assert.throws(()=>capabilities.command({action:'publishProfile',organizationId:'north',projectId:'code',id:'denied',name:'Denied',tools:[],skills:[],skillSelections:[selected],skillScope:{...scope,userId:'bob'}}),/denied/);
 const session={projectId:'code',skillUserId:'alice',capabilityProfile:profile,skillSnapshots:[{snapshotId:'capture',digest:'exact'}]};state.projects=[{id:'code',organizationId:'north'}];capabilities.pin(session,profile);assert.equal(session.skillSnapshots[0].digest,'exact');capabilities.pin(session,null);assert.equal(session.skillSnapshots,undefined);
});
test('read-only registered roots can be unregistered and recreated without rebinding removed sources',()=>{
 const {domain,root}=setup();observe(domain,root);const old=domain.catalogue(scope).sources[0];
 // File-write access and registration management are separate capabilities.
 const readonly=domain.registerRoot({scope:'personal',path:'/readonly',runnerId:'local',executionIdentity:'os-alice',writable:false,trusted:true},scope);assert.throws(()=>domain.assertWrite(readonly.id,scope),/read-only/);assert.equal(domain.unregisterRoot(readonly.id,1,scope).removed,true);
 domain.unregisterRoot(root.id,1,scope);const replacement=domain.registerRoot({scope:'personal',path:'/repo',runnerId:'local',executionIdentity:'os-alice',writable:true,trusted:true},scope);observe(domain,replacement);assert.notEqual(domain.catalogue(scope).sources[0].id,old.id);assert.throws(()=>domain.source(old.id,scope),/denied/);
});
test('canonical aliases deduplicate only within the same ownership and workspace',()=>{
 const {domain,root}=setup();observe(domain,root);const first=domain.catalogue(scope).sources[0];
 const alias=domain.registerRoot({scope:'personal',path:'/alias',runnerId:'local',executionIdentity:'os-alice',writable:true,trusted:true},scope);observe(domain,alias);assert.equal(domain.catalogue(scope).sources.length,1);assert.equal(domain.catalogue(scope).sources[0].id,first.id);
 const organization=domain.registerRoot({scope:'organization',path:'/shared',runnerId:'local',executionIdentity:'os-managed',writable:true,trusted:true},scope);observe(domain,organization);assert.equal(domain.catalogue(scope).sources.length,2);
});
test('root-specific alias paths survive primary unregister and retain exact capture identity',()=>{
 const {domain}=setup();const first=domain.registerRoot({scope:'personal',path:'/parent',runnerId:'local',executionIdentity:'os-alice',writable:true,trusted:true},scope);const second=domain.registerRoot({scope:'personal',path:'/parent/group',runnerId:'local',executionIdentity:'os-alice',writable:true,trusted:true},scope);
 const content=files();const packageAt=relativeDirectory=>({relativeDirectory,canonicalPath:'/parent/group/review',digest:skillPackageDigest(content),files:content});
 domain.observe(first.id,{runnerId:'local',workspaceId:'main'},{packages:[packageAt('group/review')]},scope);const original=domain.catalogue(scope).sources.find(s=>s.rootId===first.id);const before=domain.capture(original.id,original.instances[0].id,original.instances[0].digest,scope);
 domain.observe(second.id,{runnerId:'local',workspaceId:'main'},{packages:[packageAt('review')]},scope);assert.equal(domain.catalogue(scope).sources.length,1);domain.unregisterRoot(first.id,1,scope);
 const available=domain.source(original.id,scope);assert.equal(available.rootId,second.id);assert.equal(available.relativeDirectory,'review');assert.equal(available.instances[0].state,'current');assert.equal(domain.capture(available.id,available.instances[0].id,available.instances[0].digest,scope).id,before.id);
 domain.observe(second.id,{runnerId:'local',workspaceId:'main'},{packages:[packageAt('review')]},scope);assert.equal(domain.catalogue(scope).sources[0].id,original.id);
});
test('a registered root containing SKILL.md uses its empty relative directory',()=>{
 const {domain,root}=setup();const content=files();domain.observe(root.id,{runnerId:'local',workspaceId:'main'},{packages:[{relativeDirectory:'',canonicalPath:'/repo',files:content,digest:skillPackageDigest(content)}]},scope);
 const source=domain.catalogue(scope).sources[0];assert.equal(source.relativeDirectory,'');assert.equal(source.name,'review');assert.equal(domain.capture(source.id,source.instances[0].id,source.instances[0].digest,scope).files.length,3);
});
test('profile catalogues do not expose another user private selections, while removed own selections remain visible',()=>{
 const {state,domain,root}=setup();observe(domain,root);const source=domain.catalogue(scope).sources[0];const capabilities=createCapabilities({state,skillSources:domain});
 const profile=capabilities.command({action:'publishProfile',organizationId:'north',projectId:'code',id:'private-profile',name:'Private profile',tools:[],skills:[],skillSelections:[{mode:'source-current',sourceId:source.id}],skillScope:scope});
 assert.equal(capabilities.snapshot(scope).profiles.length,1);assert.equal(capabilities.snapshot({...scope,userId:'bob'}).profiles.length,0);
 domain.unregisterRoot(root.id,1,scope);assert.equal(capabilities.snapshot(scope).profiles[0].id,profile.id);assert.equal(capabilities.snapshot({...scope,userId:'bob'}).profiles.length,0);
});
test('worktree metadata is instance-specific rather than last-observation wins',()=>{
 const {domain,root}=setup();observe(domain,root);const original=domain.catalogue(scope).sources[0];const other=files();other[0].content=other[0].content.replace('name: review','name: inventory').replace('description: Review a bounded subject','description: Analyze stock');observe(domain,root,other,'inventory-tree');
 assert.equal(domain.source(original.id,scope).name,'review');assert.equal(domain.source(original.id,{...scope,workspaceId:'inventory-tree'}).name,'inventory');assert.equal(domain.source(original.id,{...scope,workspaceId:'inventory-tree'}).description,'Analyze stock');
 const broad=domain.source(original.id,{...scope,workspaceId:undefined});assert.equal(broad.name,'review');assert.equal(broad.description,'');assert.equal(broad.instances.find(i=>i.workspaceId==='inventory-tree').name,'inventory');
});
test('root availability diagnostics do not create phantom skills and clear on successful reconciliation',()=>{
 const {domain,root}=setup();domain.observe(root.id,{runnerId:'local',workspaceId:'main'},{packages:[],diagnostics:[{relativeDirectory:'',code:'missing',message:'Root missing'}]},scope);
 const missing=domain.catalogue(scope);assert.equal(missing.sources.length,0);assert.equal(missing.roots[0].diagnostics[0].state,'missing');assert.equal(domain.catalogue({...scope,workspaceId:'other'}).roots[0].diagnostics.length,0);
 observe(domain,root);assert.equal(domain.catalogue(scope).roots[0].diagnostics.length,0);
 const source=domain.catalogue(scope).sources[0];const snapshot=domain.capture(source.id,source.instances[0].id,source.instances[0].digest,scope);assert.equal(snapshot.instanceId,source.instances[0].id);assert.equal(snapshot.path,source.instances[0].path);
});
test('catalogue write capabilities reflect the viewing actor rather than registration owner',()=>{
 const {domain,root}=setup('project');assert.equal(domain.catalogue(scope).roots.find(r=>r.id===root.id).writable,true);assert.equal(domain.catalogue({...scope,canWriteProject:false}).roots.find(r=>r.id===root.id).writable,false);
 const organization=domain.registerRoot({scope:'organization',path:'/managed',runnerId:'local',executionIdentity:'managed',writable:true,trusted:true},scope);assert.equal(domain.catalogue({...scope,canManageOrganization:false}).roots.find(r=>r.id===organization.id).writable,false);
});
test('session previews and captured references remain private to their skill owner',()=>{
 const {state,domain,root}=setup();observe(domain,root);const source=domain.catalogue(scope).sources[0];const snapshot=domain.capture(source.id,source.instances[0].id,source.instances[0].digest,scope);const capabilities=createCapabilities({state,skillSources:domain});state.projects=[{id:'code',organizationId:'north'}];
 const profile=capabilities.command({action:'publishProfile',organizationId:'north',projectId:'code',id:'personal-context',name:'Personal context',tools:[],skills:[],skillSelections:[{mode:'source-current',sourceId:source.id}],skillScope:scope});const session={projectId:'code',skillUserId:'alice',capabilityProfile:profile,skillSnapshots:[{snapshotId:snapshot.id,digest:snapshot.digest,sourceId:source.id}]};
 assert.equal(capabilities.filterSessionPreview(session,scope).skills[0].sourceId,source.id);const bob={...scope,userId:'bob'};assert.equal(capabilities.filterSessionPreview(session,bob).skills.length,0);assert.equal(capabilities.filterSessionPreview(session,bob).profile,null);assert.deepEqual(capabilities.sessionSkillProjection(session,bob),{capabilityProfile:null,skillSnapshots:[],activeSkills:[],events:[]});assert.equal(capabilities.sessionSkillProjection(session,scope).skillSnapshots[0].snapshotId,snapshot.id);
});
test('authorized revision-checked policy updates revoke snapshots without permitting identity changes',()=>{
 const {domain,root}=setup();observe(domain,root);const source=domain.catalogue(scope).sources[0];const snapshot=domain.capture(source.id,source.instances[0].id,source.instances[0].digest,scope);
 assert.throws(()=>domain.updateRoot(root.id,1,{trusted:false},{...scope,userId:'bob'}),/denied/);assert.throws(()=>domain.updateRoot(root.id,1,{path:'/elsewhere'},scope),/Only explicit/);
 const changed=domain.updateRoot(root.id,1,{writable:false,trusted:false},scope);assert.equal(changed.revision,2);assert.equal(changed.path,root.path);assert.throws(()=>domain.snapshot({snapshotId:snapshot.id},scope),/revoked/);assert.throws(()=>domain.updateRoot(root.id,1,{trusted:true},scope),/changed/);
 const restored=domain.updateRoot(root.id,2,{trusted:true},scope);assert.equal(restored.writable,false);assert.equal(domain.snapshot({snapshotId:snapshot.id},scope).digest,snapshot.digest);domain.updateRoot(root.id,3,{readable:false},scope);assert.throws(()=>domain.snapshot({snapshotId:snapshot.id},scope),/revoked/);
});
test('session workflow references are projected by current viewer ownership without rewriting publication',()=>{
 const {state,domain,root}=setup();observe(domain,root);const source=domain.catalogue(scope).sources[0];const snapshot=domain.capture(source.id,source.instances[0].id,source.instances[0].digest,scope);const capabilities=createCapabilities({state,skillSources:domain});const ref={snapshotId:snapshot.id,digest:snapshot.digest,sourceId:source.id};const session={workflow:{id:'durable',skillSnapshots:[ref]}};
 assert.deepEqual(capabilities.sessionSkillProjection(session,{...scope,userId:'bob'}).workflow.skillSnapshots,[]);assert.deepEqual(capabilities.sessionSkillProjection(session,scope).workflow.skillSnapshots,[ref]);assert.deepEqual(session.workflow.skillSnapshots,[ref]);
});
test('a revoked captured source does not prevent previewing other healthy skills, while execution remains strict',()=>{
 const {state,domain,root}=setup();observe(domain,root);const shared=domain.registerRoot({scope:'organization',path:'/shared',runnerId:'local',executionIdentity:'managed',writable:true,trusted:true},scope);observe(domain,shared,files('Shared instructions'));
 const snapshots=domain.resolveSelections(domain.catalogue(scope).sources.map(s=>({mode:'source-current',sourceId:s.id})),scope);const capabilities=createCapabilities({state,skillSources:domain});state.projects=[{id:'code',organizationId:'north'}];const session={projectId:'code',skillUserId:'alice',skillSnapshots:snapshots.map(s=>({snapshotId:s.id,digest:s.digest}))};
 domain.updateRoot(root.id,1,{trusted:false},scope);const preview=capabilities.filterSessionPreview(session,scope);assert.equal(preview.skills.length,1);assert.equal(preview.skills[0].snapshotId,snapshots.find(s=>s.rootId===shared.id).id);assert.throws(()=>capabilities.load(session,null,snapshots[0].id),/revoked/);
});
test('an explicitly empty organization context never acts as an unscoped library catalogue',()=>{
 const state={sessions:{},projects:[],runners:[]};const capabilities=createCapabilities({state});capabilities.command({action:'publishSkill',organizationId:'north',files:{'SKILL.md':'---\nname: private-record\ndescription: Organization instructions\n---\nSecret'},trusted:true});capabilities.command({action:'publishProfile',organizationId:'north',id:'private-profile',name:'Private',tools:[],skills:[{name:'private-record',version:1}]});
 assert.equal(capabilities.snapshot().skills.length,1);const empty=capabilities.snapshot({organizationId:undefined,projectIds:[]});assert.deepEqual(empty.skills,[]);assert.deepEqual(empty.profiles,[]);assert.deepEqual(empty.extensions,[]);assert.deepEqual(empty.projectProfiles,{});assert.deepEqual(empty.disabledTools,[]);
});
test('provisioned copies retain snapshot provenance and cannot widen source visibility',()=>{
 const {domain,root}=setup();observe(domain,root);const original=domain.catalogue(scope).sources[0];const snapshot=domain.capture(original.id,original.instances[0].id,original.instances[0].digest,scope);
 const target=domain.registerRoot({scope:'personal',path:'/copy',runnerId:'local',executionIdentity:'os-alice',writable:true,trusted:true},scope);const copied=files();domain.observe(target.id,{runnerId:'local',workspaceId:'main'},{packages:[{relativeDirectory:'copy',canonicalPath:'/copy/copy',files:copied,digest:skillPackageDigest(copied)}]},scope);const destination=domain.catalogue(scope).sources.find(s=>s.rootId===target.id);
 const recorded=domain.recordProvision(destination.id,{snapshotId:snapshot.id,digest:snapshot.digest},scope);assert.deepEqual(recorded.provisionedFrom,{snapshotId:snapshot.id,digest:snapshot.digest,sourceId:original.id,runnerId:'local'});assert.notEqual(recorded.id,original.id);
 const shared=domain.registerRoot({scope:'organization',path:'/shared-copy',runnerId:'local',executionIdentity:'managed',writable:true,trusted:true},scope);assert.throws(()=>domain.assertProvision({snapshotId:snapshot.id},shared.id,scope),/preserve/);
});
test('session projections redact private activation identities, skill tool bytes and profile digests without changing execution history',()=>{
 const {state,domain,root}=setup();observe(domain,root);const source=domain.catalogue(scope).sources[0];const snapshot=domain.capture(source.id,source.instances[0].id,source.instances[0].digest,scope);const capabilities=createCapabilities({state,skillSources:domain});state.projects=[{id:'code',organizationId:'north'}];const profile=capabilities.command({action:'publishProfile',organizationId:'north',projectId:'code',id:'private-events',name:'Personal profile',tools:[],skills:[],skillSelections:[{mode:'source-current',sourceId:source.id}],skillScope:scope});
 const session={projectId:'code',skillUserId:'alice',capabilityProfile:profile,skillSnapshots:[{snapshotId:snapshot.id,digest:snapshot.digest}],activeSkills:[snapshot.id],events:[{type:'tool_requested',tool:'load_skill',callId:'private-call',args:{name:snapshot.id}},{type:'tool_result',tool:'load_skill',callId:'private-call',output:{name:snapshot.name,hash:snapshot.digest,content:'Private instructions'}},{type:'tool_result',tool:'read_skill_resource',callId:'resource-call',output:{name:snapshot.name,hash:snapshot.digest,path:'assets/example.bin',encoding:'base64',content:'AP8='}},{type:'profile_applied',profile:{id:profile.id,version:profile.version,hash:profile.hash}},{type:'tool_result',tool:'read_file',callId:'ordinary',output:{content:'Shared source code'}}]};
 const original=structuredClone(session);const bob=capabilities.sessionSkillProjection(session,{...scope,userId:'bob'});assert.deepEqual(bob.activeSkills,[]);assert.equal(bob.events[0].args.unavailable,true);assert.equal(bob.events[1].output.content,undefined);assert.equal(bob.events[1].output.hash,undefined);assert.equal(bob.events[2].output.content,undefined);assert.equal(bob.events[3].profile,null);assert.equal(bob.events[4].output.content,'Shared source code');assert(!JSON.stringify(bob).includes(snapshot.id));assert(!JSON.stringify(bob).includes(snapshot.digest));assert(!JSON.stringify(bob).includes('Private instructions'));assert.deepEqual(session,original);
 const alice=capabilities.sessionSkillProjection(session,scope);assert.equal(alice.events[1].output.content,'Private instructions');assert.deepEqual(alice.activeSkills,[snapshot.id]);
});
test('new published workflows freeze both explicit legacy profiles and absent profile against future defaults',()=>{
 const {state,domain,root}=setup();observe(domain,root);const source=domain.catalogue(scope).sources[0];const capabilities=createCapabilities({state,skillSources:domain});state.projects=[{id:'code',organizationId:'north'}];const legacy=capabilities.command({action:'publishProfile',organizationId:'north',id:'legacy-profile',name:'Legacy profile',tools:[],skills:[]});const mutable=capabilities.command({action:'publishProfile',organizationId:'north',id:'mutable-profile',name:'Source profile',tools:[],skills:[],skillSelections:[{mode:'source-current',sourceId:source.id}],skillScope:scope});state.projectProfiles.code={id:mutable.id,version:mutable.version};const session={projectId:'code',skillUserId:'alice',capabilityProfile:mutable};
 const none={capabilityProfilePinned:true,nodes:[]};assert.equal(capabilities.resolveForWorkflow(session,none),null);const pinned={capabilityProfilePinned:true,capabilityProfile:{id:legacy.id,version:legacy.version},nodes:[]};assert.equal(capabilities.resolveForWorkflow(session,pinned).id,legacy.id);assert.equal(capabilities.resolveForWorkflow(session,none,{profile:{id:mutable.id,version:mutable.version}}).id,mutable.id);assert.equal(capabilities.resolveForWorkflow(session,{nodes:[]}).id,mutable.id);
});
test('public skill selections require explicit string identities and exact pinned digests',()=>{
 const {domain,root}=setup();observe(domain,root);const source=domain.catalogue(scope).sources[0];const snapshot=domain.capture(source.id,source.instances[0].id,source.instances[0].digest,scope);
 for(const digest of [undefined,'','fake','A'.repeat(64),snapshot.digest.slice(1),42])assert.throws(()=>domain.validateSelections([{mode:'snapshot-pinned',snapshotId:snapshot.id,digest}],scope),/exact snapshot/);
 for(const sourceId of [null,42,{},'',[]])assert.throws(()=>domain.validateSelections([{mode:'source-current',sourceId}],scope),/identity/);
 assert.deepEqual(domain.validateSelections([{mode:'snapshot-pinned',snapshotId:snapshot.id,digest:snapshot.digest}],scope),[{mode:'snapshot-pinned',snapshotId:snapshot.id,digest:snapshot.digest}]);
});
test('read policy blocks IO authority while untrusted sources remain reviewable and identities retain diagnostics',()=>{
 const {domain,root}=setup();observe(domain,root);domain.updateRoot(root.id,1,{trusted:false},scope);assert.equal(domain.assertRead(root.id,scope).trusted,false);domain.updateRoot(root.id,2,{readable:false},scope);assert.throws(()=>domain.assertRead(root.id,scope),/Read access.*denied/);const catalogue=domain.catalogue(scope);assert.equal(catalogue.roots[0].id,root.id);assert.equal(catalogue.sources[0].instances[0].state,'denied');assert.match(catalogue.sources[0].instances[0].diagnostic,/Read access/);assert.equal(catalogue.sources[0].instances[0].package,undefined);
});
