import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { skillFiles, watchSkillRoots } from '../../packages/runner/src/index.mjs';

const content = (name,body='Original instructions') => `---\nname: ${name}\ndescription: Review evidence for ${name}.\n---\n${body}\n`;
async function fixture(t, generate) {
  const directory=await mkdtemp(join(tmpdir(),'convoy-file-skills-'));
  const repository=join(directory,'repository');await mkdir(repository);
  const runners={executionIdentity:async()=>`uid:${userInfo().uid}`,skillFiles:async(_runner,request,signal)=>skillFiles(request,signal),watchSkillRoots:(_runner,roots,callback)=>watchSkillRoots(roots,callback),close:async()=>{},execute:async(_runner,request)=>{
    if(request.action==='probe')return {repository,tools:['read_file'],shell:false,executionIdentity:`uid:${userInfo().uid}`};
    if(request.action==='diff')return {digest:'unchanged'};
    throw new Error(`Unexpected execution ${request.action}`);
  }};
  const options={directory:join(directory,'state'),runners,models:[{id:'test-model'}],auth:{token:async()=> 'token',status:async()=>({connected:true})},generate:generate ?? async function*(){yield {type:'result',message:{role:'assistant',content:[{type:'text',text:'Done'}],timestamp:Date.now(),stopReason:'stop'}};}};
  let runtime=await createRuntime(options);
  t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
  const act=(action,args={})=>runtime.command({action,client:'skills-test-client',...args});
  await act('registerRunner',{name:'Skills host',repository,kind:'local'});
  const state=await runtime.snapshot();const runner=state.runners[0],project=state.projects[0];
  return {directory,repository,runner,project,act,snapshot:()=>runtime.snapshot(),restart:async()=>{await runtime.close();runtime=await createRuntime(options);},runtime:()=>runtime};
}

test('source commands synchronize original files, retain immutable binary snapshots and legacy bundles across restart',async t=>{
  const f=await fixture(t);const rootPath=join(f.repository,'.agents','skills');const folder=join(rootPath,'review');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'SKILL.md'),content('code-review'));
  await writeFile(join(folder,'reference.md'),'Original reference');await writeFile(join(folder,'asset.bin'),Buffer.from([0,255,13]));
  await assert.rejects(f.act('registerSkillRoot',{scope:'personal',runnerId:f.runner.id,path:rootPath,executionIdentity:'uid:wrong',writable:true,trusted:true}),/verified runner execution identity/);
  const root=await f.act('registerSkillRoot',{scope:'project',projectId:f.project.id,runnerId:f.runner.id,path:rootPath,executionIdentity:`uid:${userInfo().uid}`,writable:true,trusted:true});
  let catalogue=await f.act('catalogueSkills',{projectId:f.project.id,runnerId:f.runner.id});
  assert.equal(catalogue.sources.length,1);assert.equal(catalogue.sources[0].name,'code-review');
  const source=catalogue.sources[0];const before=await f.act('readSkillSource',{sourceId:source.id});
  const pinned=await f.act('captureSkillSelections',{selections:[{mode:'source-current',sourceId:source.id}]});
  assert.equal(pinned[0].files.find(file=>file.path==='asset.bin').content,'AP8N');
  await writeFile(join(folder,'reference.md'),'External reference');
  await assert.rejects(f.act('saveSkillSource',{sourceId:source.id,expectedDigest:before.digest,files:before.files,requestId:'conflict-check'}),/changed/);
  assert.equal(await readFile(join(folder,'reference.md'),'utf8'),'External reference');
  const latest=await f.act('readSkillSource',{sourceId:source.id});
  const updated=latest.files.map(file=>file.path==='SKILL.md'?{...file,content:content('code-review','Edited in Convoy')}:file);
  await f.act('saveSkillSource',{sourceId:source.id,expectedDigest:latest.digest,files:updated,requestId:'save-check'});
  assert.equal(await readFile(join(folder,'SKILL.md'),'utf8'),content('code-review','Edited in Convoy'));
  const snapshot=await f.act('captureSkillSelections',{selections:[{mode:'snapshot-pinned',snapshotId:pinned[0].id,digest:pinned[0].digest}]});
  assert.equal(snapshot[0].body.trim(),'Original instructions');
  await f.act('publishSkill',{files:{'SKILL.md':content('legacy-review')},trusted:true});
  const installed=await f.act('saveStoredSkillToFolder',{name:'legacy-review',version:1,rootId:root.id,relativeDirectory:'legacy-review',trusted:true});
  assert.equal(installed.name,'legacy-review');assert.equal(await readFile(join(rootPath,'legacy-review','SKILL.md'),'utf8'),content('legacy-review'));
  await f.restart();catalogue=await f.act('refreshSkills',{projectId:f.project.id});assert.equal(catalogue.sources.length,2);
  assert.equal((await f.snapshot()).capabilities.skills.find(value=>value.name==='legacy-review').version,1);
  await f.act('unregisterSkillRoot',{rootId:root.id,expectedRevision:root.revision});
  await assert.rejects(f.act('captureSkillSelections',{selections:[{mode:'source-current',sourceId:source.id}]}),/unavailable/);
  const retained=await f.act('captureSkillSelections',{selections:[{mode:'snapshot-pinned',snapshotId:pinned[0].id,digest:pinned[0].digest}]});assert.equal(retained[0].digest,pinned[0].digest);
});

test('workflow publication captures dependencies and rejects declared skills outside its profile',async t=>{
  const f=await fixture(t);const rootPath=join(f.repository,'.agents','skills');const folder=join(rootPath,'inventory');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'SKILL.md'),content('inventory-analysis'));
  await f.act('registerSkillRoot',{scope:'project',projectId:f.project.id,runnerId:f.runner.id,path:rootPath,executionIdentity:`uid:${userInfo().uid}`,writable:true,trusted:true});
  const source=(await f.act('catalogueSkills',{projectId:f.project.id})).sources[0];
  const profile=await f.act('publishProfile',{id:'inventory',name:'Inventory',tools:[],skills:[],skillSelections:[{mode:'source-current',sourceId:source.id}],projectId:f.project.id});
  await f.act('setProjectProfile',{projectId:f.project.id,profile:{id:profile.id,version:profile.version}});
  const workflow={id:'inventory-review',name:'Inventory review',capabilityProfile:{id:profile.id,version:profile.version},steps:[{id:'review',name:'Review',kind:'agent',prompt:'Review inventory',skills:['inventory-analysis']}]};
  const {capabilityProfile:ignored,...usingDefault}=workflow;
  const published=await f.act('saveWorkflow',{workflow:usingDefault,baseVersion:0});assert.deepEqual(published.capabilityProfile,{id:profile.id,version:profile.version});assert.equal(published.skillSnapshots.length,1);
  const ref=published.skillSnapshots[0];await writeFile(join(folder,'SKILL.md'),content('inventory-analysis','New instructions'));
  const pinned=await f.act('captureSkillSelections',{selections:[{mode:'snapshot-pinned',snapshotId:ref.snapshotId,digest:ref.digest}]});assert.equal(pinned[0].body.trim(),'Original instructions');
  await assert.rejects(f.act('saveWorkflow',{workflow:{...workflow,id:'unknown-skill',steps:[{...workflow.steps[0],skills:['unselected']}]},baseVersion:0}),/not selected/);
  const removed=await f.act('catalogueSkills',{projectId:f.project.id});const root=removed.roots[0];await f.act('unregisterSkillRoot',{rootId:root.id,expectedRevision:root.revision});
  const preserved=await f.act('captureSkillSelections',{selections:[{mode:'snapshot-pinned',snapshotId:ref.snapshotId,digest:ref.digest}]});assert.equal(preserved[0].body.trim(),'Original instructions');
});

test('publication freezes no profile and validates required skills before accepting a workflow',async t=>{
  const f=await fixture(t);
  const workflow={id:'independent',name:'Independent',steps:[{id:'review',name:'Review',kind:'agent',prompt:'Review'}]};
  const published=await f.act('saveWorkflow',{workflow,baseVersion:0});
  assert.equal(published.capabilityProfilePinned,true);assert.equal(published.capabilityProfile,undefined);
  await assert.rejects(f.act('saveWorkflow',{workflow:{...workflow,id:'unresolved',steps:[{...workflow.steps[0],skills:['required-review']}]},baseVersion:0}),/not selected/);
  const legacy=await f.act('publishProfile',{id:'legacy-empty',name:'Legacy empty',tools:[],skills:[],projectId:f.project.id});
  await f.act('setProjectProfile',{projectId:f.project.id,profile:{id:legacy.id,version:legacy.version}});
  await assert.rejects(f.act('saveWorkflow',{workflow:{...workflow,id:'legacy-unresolved',steps:[{...workflow.steps[0],skills:['required-review']}]},baseVersion:0}),/not selected/);
  const withLegacy=await f.act('saveWorkflow',{workflow:{...workflow,id:'legacy-frozen'},baseVersion:0});
  assert.equal(withLegacy.capabilityProfilePinned,true);assert.deepEqual(withLegacy.capabilityProfile,{id:legacy.id,version:legacy.version});
  const next=await f.act('publishProfile',{id:'later-default',name:'Later default',tools:[],skills:[],projectId:f.project.id});
  await f.act('setProjectProfile',{projectId:f.project.id,expected:{id:legacy.id,version:legacy.version},profile:{id:next.id,version:next.version}});
  const snapshot=await f.snapshot();const saved=snapshot.workflows.find(value=>value.id===published.id);
  assert.equal(saved.capabilityProfilePinned,true);assert.equal(saved.capabilityProfile,undefined);
  assert.deepEqual(snapshot.workflows.find(value=>value.id===withLegacy.id).capabilityProfile,{id:legacy.id,version:legacy.version});
});

async function until(read) {for(let attempt=0;attempt<100;attempt++){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Expected runtime state did not arrive.');}

test('registered missing roots and resource changes synchronize without a refresh command; provisioning creates an independent copy',async t=>{
  const f=await fixture(t);const rootPath=join(f.repository,'.agents','skills');
  const root=await f.act('registerSkillRoot',{scope:'project',projectId:f.project.id,runnerId:f.runner.id,path:rootPath,executionIdentity:`uid:${userInfo().uid}`,writable:true,trusted:true});
  const folder=join(rootPath,'watched');await mkdir(folder,{recursive:true});await writeFile(join(folder,'SKILL.md'),content('watched-review'));await writeFile(join(folder,'reference.md'),'Original reference');
  const source=await until(async()=>(await f.snapshot()).capabilities.skillCatalogue.sources.find(value=>value.name==='watched-review'&&value.instances.some(instance=>instance.state==='current')));
  const originalDigest=source.instances[0].digest;
  await writeFile(join(folder,'reference.md'),'Externally changed');
  await until(async()=>{const value=(await f.snapshot()).capabilities.skillCatalogue.sources.find(value=>value.id===source.id);return value?.instances.some(instance=>instance.state==='current'&&instance.digest!==originalDigest);});
  const [snapshot]=await f.act('captureSkillSelections',{selections:[{mode:'source-current',sourceId:source.id}]});
  const copy=await f.act('provisionSkillSnapshot',{snapshotId:snapshot.id,targetRootId:root.id,relativeDirectory:'copied',trusted:true,requestId:'explicit-copy'});
  assert.notEqual(copy.id,source.id);assert.equal(copy.provisionedFrom.snapshotId,snapshot.id);
  assert.equal(await readFile(join(rootPath,'copied','reference.md'),'utf8'),'Externally changed');
  await writeFile(join(folder,'reference.md'),'Later original edit');
  assert.equal(await readFile(join(rootPath,'copied','reference.md'),'utf8'),'Externally changed');
  await rm(folder,{recursive:true});
  await until(async()=>{const value=(await f.snapshot()).capabilities.skillCatalogue.sources.find(value=>value.id===source.id);return value?.instances.some(instance=>instance.state==='missing');});
});

test('interactive executions and restart keep captured instructions while a new session captures changed files',async t=>{
  let rounds=0;let proceed;const ready=new Promise(resolve=>{proceed=resolve});
  const f=await fixture(t,async function*(){
    const round=rounds++;
    if(round===0)await ready;
    const content=round%3===0 ? [{type:'toolCall',id:`load-${round}`,name:'load_skill',arguments:{name:'code-review'}}]
      : round%3===1 ? [{type:'toolCall',id:`read-${round}`,name:'read_skill_resource',arguments:{name:'code-review',path:'reference.md'}}]
      : [{type:'text',text:'Reviewed'}];
    yield {type:'result',message:{role:'assistant',content,timestamp:Date.now(),stopReason:round%3===2?'stop':'toolUse'}};
  });
  const rootPath=join(f.repository,'.agents','skills'),folder=join(rootPath,'review');await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'SKILL.md'),content('code-review'));await writeFile(join(folder,'reference.md'),'Original reference');
  await f.act('registerSkillRoot',{scope:'project',projectId:f.project.id,runnerId:f.runner.id,path:rootPath,executionIdentity:`uid:${userInfo().uid}`,writable:true,trusted:true});
  const source=(await f.act('catalogueSkills',{projectId:f.project.id})).sources[0];
  const profile=await f.act('publishProfile',{id:'live-review',name:'Live review',tools:[],skills:[],projectId:f.project.id,skillSelections:[{mode:'source-current',sourceId:source.id}]});
  await f.act('setProjectProfile',{projectId:f.project.id,profile:{id:profile.id,version:profile.version}});
  const conversation=await f.act('createConversation',{projectId:f.project.id,requestId:'original-session'});
  await f.act('claim',{sessionId:conversation.sessionId});
  await f.act('start',{sessionId:conversation.sessionId,text:'Review',model:'test-model',requestId:'original-turn'});
  await until(async()=>(await f.runtime().snapshot(conversation.sessionId)).sessions[0].skillSnapshots?.length);
  const initial=(await f.runtime().snapshot(conversation.sessionId)).sessions[0].skillSnapshots[0];
  await writeFile(join(folder,'SKILL.md'),content('code-review','Changed instructions'));await writeFile(join(folder,'reference.md'),'Changed reference');proceed();
  let session=await until(async()=>{const s=(await f.runtime().snapshot(conversation.sessionId)).sessions[0];return s.events.some(e=>e.callId==='read-1'&&e.type==='tool_result')&&s.status==='awaiting_review'?s:null;});
  assert.equal(session.events.find(e=>e.callId==='read-1'&&e.type==='tool_result').isError,false);
  assert.equal(session.events.find(e=>e.callId==='read-1'&&e.type==='tool_result').output.content,'Original reference');
  await f.restart();await f.act('claim',{sessionId:conversation.sessionId});
  await f.act('start',{sessionId:conversation.sessionId,text:'Continue review',model:'test-model',requestId:'resumed-turn'});
  session=await until(async()=>{const s=(await f.runtime().snapshot(conversation.sessionId)).sessions[0];return s.events.some(e=>e.callId==='read-4'&&e.type==='tool_result')&&s.status==='awaiting_review'?s:null;});
  assert.deepEqual(session.skillSnapshots[0],initial);assert.equal(session.events.find(e=>e.callId==='read-4'&&e.type==='tool_result').output.content,'Original reference');
  const next=await f.act('createConversation',{projectId:f.project.id,requestId:'new-session'});await f.act('claim',{sessionId:next.sessionId});
  await f.act('start',{sessionId:next.sessionId,text:'Review current files',model:'test-model',requestId:'new-turn'});
  const fresh=await until(async()=>{const s=(await f.runtime().snapshot(next.sessionId)).sessions[0];return s.events.some(e=>e.callId==='read-7'&&e.type==='tool_result')&&s.status==='awaiting_review'?s:null;});
  assert.notEqual(fresh.skillSnapshots[0].digest,initial.digest);assert.equal(fresh.events.find(e=>e.callId==='read-7'&&e.type==='tool_result').output.content,'Changed reference');
});

test('nested sources require the configured session directory and policy revocation blocks execution without breaking inspection',async t=>{
  let modelCalls=0;const f=await fixture(t,async function*(){modelCalls++;yield {type:'result',message:{role:'assistant',content:[{type:'text',text:'Done'}],timestamp:Date.now(),stopReason:'stop'}};});
  const rootPath=join(f.repository,'.agents','skills');const nested=join(f.repository,'packages','api','.agents','skills','review');await mkdir(nested,{recursive:true});await writeFile(join(nested,'SKILL.md'),content('package-review'));
  const root=await f.act('registerSkillRoot',{scope:'project',projectId:f.project.id,runnerId:f.runner.id,path:rootPath,executionIdentity:`uid:${userInfo().uid}`,writable:true,trusted:true});
  const source=(await f.act('catalogueSkills',{projectId:f.project.id})).sources[0];assert.equal(source.relativeDirectory,'packages/api/.agents/skills/review');
  await assert.rejects(f.act('captureSkillSelections',{selections:[{mode:'source-current',sourceId:source.id}]}),/relevance boundary/);
  const profile=await f.act('publishProfile',{id:'package-review',name:'Package review',tools:[],skills:[],projectId:f.project.id,skillSelections:[{mode:'source-current',sourceId:source.id}]});await f.act('setProjectProfile',{projectId:f.project.id,profile:{id:profile.id,version:profile.version}});
  const conversation=await f.act('createConversation',{projectId:f.project.id,requestId:'nested-session'});await f.act('claim',{sessionId:conversation.sessionId});
  await assert.rejects(f.act('configure',{sessionId:conversation.sessionId,workingDirectory:'../outside'}),/relative working directory/);
  await f.act('configure',{sessionId:conversation.sessionId,workingDirectory:'packages/api'});
  await f.act('start',{sessionId:conversation.sessionId,text:'Review package',model:'test-model',requestId:'nested-turn'});
  const captured=await until(async()=>{const s=(await f.runtime().snapshot(conversation.sessionId)).sessions[0];return s.status==='awaiting_review'?s:null;});assert.equal(modelCalls,1);assert.equal(captured.skillSnapshots.length,1);
  await f.act('updateSkillRoot',{rootId:root.id,expectedRevision:root.revision,trusted:false});
  const inspected=await f.runtime().snapshot(conversation.sessionId);assert.equal(inspected.sessions[0].effectiveCapabilities.skills.length,0);
  await f.act('start',{sessionId:conversation.sessionId,text:'Continue',model:'test-model',requestId:'revoked-turn'});
  const failed=await until(async()=>{const s=(await f.runtime().snapshot(conversation.sessionId)).sessions[0];return s.status==='failed'?s:null;});assert.equal(modelCalls,1);assert(failed.events.some(e=>e.message?.includes('revoked')));
  const current=(await f.act('catalogueSkills',{projectId:f.project.id})).roots.find(value=>value.id===root.id);
  await f.act('updateSkillRoot',{rootId:root.id,expectedRevision:current.revision,readable:false});
  await assert.rejects(f.act('readSkillSource',{sourceId:source.id}),/access.*denied/i);
  const denied=await f.act('catalogueSkills',{projectId:f.project.id});
  assert(denied.sources.find(value=>value.id===source.id).instances.every(instance=>instance.state==='denied'));
});
