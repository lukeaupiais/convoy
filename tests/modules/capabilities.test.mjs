import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCapabilities,parseSkill} from '../../apps/daemon/src/modules/library/capabilities.mjs';
import {parseExtensionManifest} from '../../apps/daemon/src/modules/library/extensions.mjs';
import {createRuntime} from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import {validateToolCall} from '../../apps/daemon/src/modules/library/tool-registry.mjs';

const files=(body='Secret procedure: validate accessibility')=>({'SKILL.md':`---\nname: review-work\ndescription: Review work when requested.\nallowed-tools: shell\n---\n${body}\n`,'references/checks.md':'Check keyboard navigation.'});
function catalog(){const state={sessions:{old:{}},projects:[{id:'p'}],runners:[]};return {state,c:createCapabilities({state})};}
function publish(c){c.command({action:'publishSkill',files:files(),trusted:true});return c.command({action:'publishProfile',id:'review',name:'Review',tools:['convoy.read_file'],skills:[{name:'review-work',version:1}]});}

test('standard skill parsing is deterministic, bounded and preserves advisory metadata',()=>{
  const a=parseSkill(files());assert.equal(a.name,'review-work');assert.equal(a.warnings.length,1);
  assert.equal(a.hash,parseSkill(Object.fromEntries(Object.entries(files()).reverse())).hash);
  assert.throws(()=>parseSkill({...files(),'../secret':'no'}),/path/);
  assert.throws(()=>parseSkill({...files(),'.env':'SECRET=no'}),/path/);
  assert.throws(()=>parseSkill({...files(),'binary':'\0'}),/non-text/);
  assert.throws(()=>parseSkill({'SKILL.md':'not frontmatter'}),/frontmatter/);
  assert.throws(()=>parseSkill({'SKILL.md':'---\nname: bad--name\ndescription: a\n---\nb'}),/names/);
  assert.throws(()=>parseSkill({'SKILL.md':'---\nname: a\nname: b\ndescription: c\n---\nb'}),/YAML/);
  assert.throws(()=>parseSkill({'SKILL.md':'---\nname: &n review-work\ndescription: *n\n---\nb'}));
});
test('untrusted publication and stale updates fail; old profiles and resources remain pinned',()=>{
  const {c,state}=catalog();assert.equal(state.sessions.old.capabilityProfile,null);
  assert.throws(()=>c.command({action:'publishSkill',files:files()}),/trust/);
  const p=publish(c);const s={};c.pin(s,p);
  c.command({action:'publishSkill',files:files('Changed procedure'),trusted:true,baseVersion:1});
  assert.throws(()=>c.command({action:'publishSkill',files:files('Stale'),trusted:true,baseVersion:1}),/changed/);
  assert(!c.prompt(s).includes('Secret procedure'));assert(c.prompt(s).includes('Review work when requested'));
  assert.throws(()=>c.load(s,null,'review-work','references/checks.md'),/Activate/);
  assert.match(c.load(s,null,'review-work').content,/Secret procedure/);
  assert.match(c.prompt(s),/Secret procedure/);assert(!c.prompt(s).includes('Changed procedure'));
  assert.equal(c.load(s,null,'review-work','references/checks.md').content,'Check keyboard navigation.');
  assert.throws(()=>c.load(s,null,'review-work','../secret'),/Resource/);
  assert.throws(()=>c.load(s,{skills:['other']},'review-work'),/not selected/);
  assert.throws(()=>c.command({action:'publishProfile',id:'review',name:'Stale',tools:[],skills:[]}),/changed/);
});
test('effective tools intersect profile, workflow, runner capabilities and live policy',()=>{
  const {c,state}=catalog();const p=publish(c);const s={};c.pin(s,p);
  let preview=c.preview(s);assert.match(preview.tools.find(t=>t.name==='read_file').reason,/workspace/);assert.match(preview.tools.find(t=>t.name==='write_file').reason,/profile/);
  s.workspace={path:'/work'};s.runnerId='runner';state.runners.push({id:'runner',capabilities:{tools:['read_file']}});
  assert(c.preview(s).tools.find(t=>t.name==='read_file').available);
  assert.match(c.preview(s,{permissions:'none'}).tools.find(t=>t.name==='read_file').reason,/workflow/);
  c.command({action:'setToolEnabled',id:'convoy.read_file',enabled:false});assert.throws(()=>c.validate(s,null,'read_file',{path:'a'}),/Disabled/);
  assert(c.preview(s).tools.find(t=>t.name==='load_skill').available);assert(!c.preview(s).tools.find(t=>t.name==='shell').available);
  assert.throws(()=>validateToolCall('read_file',{path:3}),/Invalid arguments/);
  assert.throws(()=>validateToolCall('read_file',{path:'a',escape:true}),/Invalid arguments/);
  validateToolCall('apply_patch',{path:'a',expectedHash:'0'.repeat(64),edits:[{oldText:'before',newText:'after'}]});
  assert.throws(()=>validateToolCall('apply_patch',{path:'a',expectedHash:'hash',edits:[]}),/Invalid arguments/);
  validateToolCall('submit_step',{summary:'done',artifacts:[]});
  validateToolCall('move_ticket',{ticketId:42,revision:3,boardId:'delivery',columnId:'done',reason:'Review passed.'});
  assert.throws(()=>validateToolCall('move_ticket',{ticketId:42,revision:3,boardId:'delivery',columnId:'done'}),/Invalid arguments/);
});
test('project defaults affect only newly pinned sessions; stale default updates fail',()=>{
  const {c,state}=catalog();const p=publish(c);const ref={id:p.id,version:p.version};
  c.command({action:'setProjectProfile',projectId:'p',profile:ref});
  const existing=state.sessions.old;existing.projectId='p';c.pinDefault(existing);assert.equal(existing.capabilityProfile,null);
  const fresh={projectId:'p'};c.pinDefault(fresh);assert.equal(fresh.capabilityProfile.hash,p.hash);
  c.command({action:'setProjectProfile',projectId:'p',expected:ref,profile:null});assert.equal(fresh.capabilityProfile.hash,p.hash);
  assert.throws(()=>c.command({action:'setProjectProfile',projectId:'p',expected:ref,profile:null}),/changed/);
});

test('reviewed runner extensions are immutable, bounded, and profile-pinned',()=>{
  const manifest={id:'review-mcp',kind:'mcp',revision:'sha256:1234',execution:{location:'runner',adapter:'mcp-stdio'},tools:[{id:'review.findings',name:'review_findings',description:'Read findings from the reviewed server.',approval:'ask',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}]};
  const parsed=parseExtensionManifest(manifest);assert.equal(parsed.execution.location,'runner');
  assert.throws(()=>parseExtensionManifest({...manifest,endpoint:'https://unsafe'}),/Unsupported/);
  assert.throws(()=>parseExtensionManifest({...manifest,execution:{location:'daemon',adapter:'mcp-stdio'}}),/runner/);
  const {c,state}=catalog();const published=c.command({action:'publishExtension',manifest,trusted:true});
  assert.equal(c.command({action:'publishExtension',manifest,trusted:true}).hash,published.hash);
  assert.throws(()=>c.command({action:'publishExtension',manifest:{...manifest,tools:[...manifest.tools,{...manifest.tools[0],id:'other'}]},trusted:true}),/already exists/);
  const profile=c.command({action:'publishProfile',id:'with-extension',name:'With extension',tools:[],skills:[],extensions:[{id:published.id,revision:published.revision,hash:published.hash}]});
  const session={};c.pin(session,profile);assert.deepEqual(session.capabilityProfile.extensions,[{id:published.id,revision:published.revision,hash:published.hash}]);
  assert.equal(state.extensions.length,1);
});

test('a pinned extension is visible only on a workspace runner with its reviewed adapter',()=>{
  const manifest={id:'review-mcp',kind:'mcp',revision:'sha256:5678',execution:{location:'runner',adapter:'mcp-stdio'},tools:[{id:'review.findings',name:'review_findings',description:'Read reviewed findings.',approval:'ask',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}]};
  const {c,state}=catalog();const extension=c.command({action:'publishExtension',manifest,trusted:true});
  const profile=c.command({action:'publishProfile',id:'extension-runner',name:'Extension runner',tools:[],skills:[],extensions:[{id:extension.id,revision:extension.revision,hash:extension.hash}]});
  const session={workspace:{path:'/work'},runnerId:'runner'};c.pin(session,profile);
  state.runners.push({id:'runner',capabilities:{tools:[],extensionAdapters:[]}});
  assert.match(c.preview(session).tools.find(t=>t.name==='review_findings').reason,/not installed/);
  state.runners[0].capabilities.extensionAdapters.push('mcp-stdio');
  assert(c.preview(session).tools.find(t=>t.name==='review_findings').available);
  assert.throws(()=>c.validate(session,null,'review_findings',{path:1}),/Invalid extension/);
  assert.equal(c.extensionTool(session,null,'review_findings').extension.adapter,'mcp-stdio');
});

const reply=text=>({role:'assistant',content:[{type:'text',text}],stopReason:'stop',timestamp:Date.now()});
const call=(name,args)=>({role:'assistant',content:[{type:'toolCall',id:name,name,arguments:args}],stopReason:'toolUse',timestamp:Date.now()});
async function until(fn){for(let i=0;i<300;i++){const r=await fn();if(r)return r;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out');}
async function fixture(t,generate){
  const directory=await mkdtemp(join(tmpdir(),'convoy-capabilities-'));const prompts=[];
  const options={directory,models:[{id:'fake'}],auth:{token:async()=>'fake',status:async()=>({connected:true})},runners:{execute:async()=>{throw new Error('Unexpected runner call');}},generate:async function*(input){prompts.push(input);yield {type:'result',message:await generate(input,prompts.length)};}};
  const runtime=await createRuntime(options);t.after(()=>runtime.close());const act=(action,input={})=>runtime.command({action,client:'capability-test',...input});
  const c=await act('createConversation',{requestId:'chat',projectId:'agent-platform'});await act('claim',{sessionId:c.sessionId,label:'Test'});
  const session=async()=>(await runtime.snapshot(c.sessionId)).sessions[0];return {runtime,options,act,c,session,prompts};
}
test('runtime loads skills on demand, keeps context and restores pinned profile after restart',async t=>{
  const f=await fixture(t,(_input,n)=>n===1?call('load_skill',{name:'review-work'}):n===2?call('read_skill_resource',{name:'review-work',path:'references/checks.md'}):reply('Done'));
  await f.act('publishSkill',{files:files(),trusted:true});const p=await f.act('publishProfile',{id:'review',name:'Review',tools:[],skills:[{name:'review-work',version:1}]});
  await f.act('setCapabilityProfile',{sessionId:f.c.sessionId,profile:p});
  await f.act('start',{sessionId:f.c.sessionId,text:'Review this',model:'fake',requestId:'one'});
  await until(async()=>(await f.session()).status==='awaiting_review');
  assert(!f.prompts[0].prompt.turnInstructions.includes('Secret procedure'));assert(f.prompts[1].prompt.turnInstructions.includes('Secret procedure'));
  assert(f.prompts[2].prompt.messages.some(m=>m.role==='toolResult'&&JSON.stringify(m).includes('keyboard navigation')));
  const before=await f.session();assert.equal(before.capabilityProfile.hash,p.hash);assert(before.effectiveCapabilities.skills[0].active);
  await f.runtime.close();const restarted=await createRuntime(f.options);t.after(()=>restarted.close());const after=(await restarted.snapshot(f.c.sessionId)).sessions[0];assert.equal(after.capabilityProfile.hash,p.hash);assert(after.effectiveCapabilities.skills[0].active);
});
test('revoking a tool while approval is pending prevents execution; profile changes are locked',async t=>{
  const f=await fixture(t,(_input,n)=>n===1?call('create_ticket',{requestKey:'denied',projectId:'agent-platform',title:'Not created',description:'No'}):reply('Stopped'));
  await f.act('start',{sessionId:f.c.sessionId,text:'Record work',model:'fake',requestId:'one'});
  const s=await until(async()=>{const s=await f.session();return s.pending?s:null;});
  await assert.rejects(f.act('setCapabilityProfile',{sessionId:s.id,profile:null}),/Stop or finish/);
  await f.act('setToolEnabled',{id:'convoy.create_ticket',enabled:false});
  await f.act('decide',{sessionId:s.id,approvalId:s.pending.id,allow:true});
  await until(async()=>(await f.session()).status==='awaiting_review');
  assert.equal((await f.runtime.snapshot()).tickets.length,0);assert((await f.session()).events.some(e=>e.type==='tool_result'&&JSON.stringify(e.output).includes('Disabled')));
});
test('an explicit profile exposes approved project tools in workflow steps without session switching',()=>{
  const {c}=catalog();const p=c.command({action:'publishProfile',id:'coordinate',name:'Coordinate',tools:['convoy.create_ticket','convoy.request_execution'],skills:[]});const s={};c.pin(s,p);
  const effective=c.preview(s,{permissions:'read-write'}).tools;
  assert(effective.find(t=>t.name==='create_ticket').available);assert.match(effective.find(t=>t.name==='request_execution').reason,/assignment/);
  assert(!c.preview(s,{permissions:'read'}).tools.find(t=>t.name==='create_ticket').available);
});

test('workflow executes an explicitly selected ticket tool only after approval, preserving its session',async t=>{
  const f=await fixture(t,(_input,n)=>n===1?call('create_ticket',{requestKey:'followup',projectId:'agent-platform',title:'Follow-up',description:'Independent work'}):call('submit_step',{summary:'Recorded follow-up',artifacts:[]}));
  const p=await f.act('publishProfile',{id:'coordinate',name:'Coordinate',tools:['convoy.create_ticket'],skills:[]});
  await f.act('setCapabilityProfile',{sessionId:f.c.sessionId,profile:p});
  await f.act('saveWorkflow',{workflow:{id:'record',name:'Record',nodes:[{id:'record',kind:'agent',name:'Record follow-up',prompt:'Create a follow-up ticket and submit.',permissions:'read-write'}]}});
  await f.act('configure',{sessionId:f.c.sessionId,runnerId:'',workflow:'record'});
  await f.act('startWorkflow',{sessionId:f.c.sessionId});
  const s=await until(async()=>{const s=await f.session();return s.pending?s:null;});assert.equal((await f.runtime.snapshot()).tickets.length,0);
  await f.act('decide',{sessionId:s.id,approvalId:s.pending.id,allow:true});
  await until(async()=>(await f.session()).flow?.status==='completed');
  const state=await f.runtime.snapshot();assert.equal(state.tickets.length,1);assert.equal(state.tickets[0].agent,'Unassigned');assert.equal(state.sessions.length,1);assert.equal(state.sessions[0].id,f.c.sessionId);
});

test('workflow profiles resolve in project scope, validate required skills, and pin immutable revisions', () => {
  const { c, state } = catalog();
  const first = publish(c);
  const workflow = { capabilityProfile: { id: first.id, version: 1 }, nodes: [{ name: 'Editorial review', skills: ['review-work'] }] };
  const session = { projectId: 'p', capabilityProfile: null };
  c.validateWorkflow(workflow);
  c.pin(session, c.resolveForWorkflow(session, workflow));
  c.command({ action: 'publishProfile', id: 'review', name: 'Changed', baseVersion: 1, tools: [], skills: [] });
  assert.equal(session.capabilityProfile.version, 1);
  assert.equal(c.resolveForWorkflow(session, workflow).hash, first.hash);
  assert.throws(() => c.resolveForWorkflow(session, workflow, { profile: { id: 'review', version: 2 } }), /missing skill review-work/);
  assert.throws(() => c.resolveForWorkflow(session, workflow, { profile: null }), /missing skill review-work/);
  assert.throws(() => c.validateWorkflow({ ...workflow, capabilityProfile: { id: 'review', version: 2 } }), /missing skill/);
  state.projects.push({ id: 'foreign', organizationId: 'other' });
  assert.throws(() => c.resolveForWorkflow({ projectId: 'foreign' }, workflow), /not found/);
  assert.throws(() => c.validateWorkflow({ ...workflow, organizationId: 'other' }), /not found/);
  const preview = c.preview(session, { permissions: 'read', skills: ['review-work'] });
  assert.equal(preview.skills[0].version, 1);
  assert.equal(preview.tools.find(tool => tool.name === 'shell').available, false);
});
