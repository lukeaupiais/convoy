import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createSteering } from '../../apps/daemon/src/modules/conversations/steering.mjs';

const result = content => ({type:'result',message:{role:'assistant',content,stopReason:'stop',timestamp:Date.now()}});
const reply = text => result([{type:'text',text}]);
const userDirections = messages => messages
  .filter(message => message.role === 'user' && !String(message.content).startsWith('Convoy runtime snapshot'))
  .map(message => message.content);
async function until(fn) { for(let i=0;i<400;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out'); }
function gate(signal) { let release;const promise=new Promise((resolve,reject)=>{release=resolve;if(signal.aborted)reject(new Error('Stopped'));else signal.addEventListener('abort',()=>reject(new Error('Stopped')),{once:true});});return {promise,release}; }
async function fixture(t, generate, runners) {
  const options={directory:await mkdtemp(join(tmpdir(),'convoy-steering-test-')),models:[{id:'test'}],auth:{token:async()=> 'fake',status:async()=>({connected:true})},generate,runners};
  const runtime=await createRuntime(options);t.after(()=>runtime.close());
  const act=(action,input={})=>runtime.command({action,client:'steering-test',...input});
  const c=await act('createConversation',{requestId:'chat',projectId:'agent-platform'});
  const chat=(action,input={})=>act(action,{sessionId:c.sessionId,...input});
  await chat('claim');
  const session=async()=>(await runtime.snapshot()).sessions.find(s=>s.id===c.sessionId);
  const send=(text,mode='queue',requestId=text)=>chat('sendMessage',{text,mode,model:'test',requestId});
  const done=()=>until(async()=>{const s=await session();return !s.control.busy&&s.status==='awaiting_review'&&s;});
  return {runtime,options,act,chat,session,send,done,c};
}

test('queue is FIFO, removable and idempotent; delivery preserves conversation identity',async t=>{
  let first;const prompts=[];
  const f=await fixture(t,async function*(input){prompts.push(structuredClone(input.prompt?.messages ?? input.messages));if(prompts.length===1){first=gate(input.signal);await first.promise;}yield reply('Done');});
  await f.send('Original');await until(()=>first);const identity=(await f.session()).currentAgentSessionId;
  await f.send('Second');await f.send('Second');await f.send('Remove');await f.chat('discardMessage',{requestId:'Remove'});await f.send('Third');
  assert.equal((await f.session()).pendingMessages.length,2);
  await assert.rejects(f.send('Different','queue','Second'),/different input/);
  await assert.rejects(f.chat('sendMessage',{client:'foreign-client',text:'No',mode:'queue',model:'test',requestId:'foreign'}),/Claim/);
  first.release();await f.done();
  assert.deepEqual(userDirections(prompts[1]),['Original','Second','Third']);
  assert.equal((await f.session()).currentAgentSessionId,identity);
  await f.send('Second');assert.equal(prompts.length,2);
});

test('stop holds queued messages; explicit resume retains context and interrupted text',async t=>{
  let first;const prompts=[];
  const f=await fixture(t,async function*(input){prompts.push(structuredClone(input.prompt?.messages ?? input.messages));if(prompts.length===1){yield {type:'delta',text:'Partial thought'};first=gate(input.signal);await first.promise;}yield reply('Finished');});
  await f.send('Remember this');await until(()=>first);await f.send('Next direction');await f.chat('stop');
  let s=await f.session();assert.equal(s.status,'interrupted');assert.equal(s.pendingMessages[0].held,true);assert.equal(prompts.length,1);
  assert.ok(s.events.some(e=>e.type==='assistant_interrupted'&&e.text==='Partial thought'));
  await f.chat('resumeSession',{requestId:'resume'});await f.done();await f.chat('resumeSession',{requestId:'resume'});
  assert.equal(prompts.length,2);assert.deepEqual(userDirections(prompts[1]),['Remember this','Next direction']);
});

test('interrupt and send resumes the same agent once; late provider replies are fenced',async t=>{
  let started=false;const prompts=[];
  const f=await fixture(t,async function*(input){prompts.push(structuredClone(input.prompt?.messages ?? input.messages));if(prompts.length===1){started=true;await new Promise(r=>input.signal.addEventListener('abort',r,{once:true}));yield reply('Obsolete reply');}else yield reply('New direction applied');});
  await f.send('Old direction');await until(()=>started);const identity=(await f.session()).currentAgentSessionId;
  await f.send('New direction','interrupt');await f.done();await f.send('New direction','interrupt');
  const s=await f.session();assert.equal(s.currentAgentSessionId,identity);assert.equal(prompts.length,2);assert.ok(!s.events.some(e=>e.type==='assistant'&&e.text==='Obsolete reply'));
});

test('interrupting approval never executes the tool and settles all requested calls',async t=>{
  let turn=0;
  const f=await fixture(t,async function*(){yield ++turn===1?result(['one','two'].map(id=>({type:'toolCall',id,name:'create_ticket',arguments:{requestKey:id,projectId:'agent-platform',title:id,description:'Scope'}}))):reply('Stopped work');});
  await f.send('Suggest tickets');await until(async()=>(await f.session()).pending);
  await f.send('Do not create tickets','interrupt');await f.done();
  assert.equal((await f.runtime.snapshot()).tickets.length,0);
  const s=await f.session();assert.equal(s.events.filter(e=>e.type==='tool_result').length,2);assert.equal(s.interruption.needsReview,false);
});

test('interrupted mutation requires review before resuming and cannot bypass through start',async t=>{
  let executing=false;let turn=0;
  const runners={execute:async(_r,c,signal)=>{
    if(c.action==='probe')return {repository:'/fixture',tools:['write_file'],shell:false};
    if(c.action==='provision')return {path:'/fixture/work',branch:'test'};
    if(c.action==='diff')return {digest:'unchanged'};
    executing=true;await gate(signal).promise;
  }};
  const f=await fixture(t,async function*(){yield ++turn===1?result([{type:'toolCall',id:'write',name:'write_file',arguments:{path:'a.md',content:'changed',expectedHash:''}}]):reply('Inspected and continued');},runners);
  await f.act('registerRunner',{name:'Fixture',kind:'local',repository:'/fixture'});
  await f.chat('configure',{runnerId:(await f.runtime.snapshot()).runners[0].id});
  await f.send('Write');const approval=await until(async()=>(await f.session()).pending);await f.chat('decide',{approvalId:approval.id,allow:true});await until(()=>executing);
  await f.send('Instead inspect','interrupt');let s=await f.session();assert.equal(s.interruption.needsReview,true);assert.equal(turn,1);assert.equal(s.pendingMessages[0].held,true);
  await assert.rejects(f.chat('resumeSession',{requestId:'resume'}),/Inspect/);
  await assert.rejects(f.chat('start',{text:'Bypass',model:'test',requestId:'bypass'}),/Review/);
  await assert.rejects(f.chat('requestExecution',{ticketId:1,mode:'continue',brief:'Bypass'}),/Review/);
  await f.chat('resumeSession',{requestId:'reviewed',acknowledge:true});await f.done();assert.equal(turn,2);
});

test('restart preserves held messages without running a provider',async t=>{
  let first;let calls=0;
  const f=await fixture(t,async function*(input){calls++;if(calls===1){first=gate(input.signal);await first.promise;}yield reply('Done');});
  await f.send('Original');await until(()=>first);await f.send('Persist me');await f.chat('stop');await f.runtime.close();
  const restarted=await createRuntime(f.options);t.after(()=>restarted.close());
  const s=(await restarted.snapshot()).sessions.find(s=>s.id===f.c.sessionId);assert.equal(s.pendingMessages[0].held,true);assert.equal(calls,1);
  await restarted.command({action:'claim',sessionId:s.id,client:'restart-client'});
  await restarted.command({action:'resumeSession',sessionId:s.id,client:'restart-client',requestId:'resume'});
  await until(()=>calls===2);
});

test('message bindings prevent cross-step delivery and queue limits are bounded',()=>{
  const steering=createSteering(()=>{});const s={messages:[],events:[],currentAgentSessionId:'main',flow:{id:'flow',instance:'one',status:'running'}};
  steering.enqueue(s,{requestId:'one',text:'Only step one',mode:'queue',model:'test'});
  s.flow.instance='two';assert.equal(steering.deliver(s),0);assert.throws(()=>steering.release(s),/changed/);
  steering.discard(s,'one');for(let i=0;i<20;i++)steering.enqueue(s,{requestId:String(i),text:'x',mode:'queue',model:'test'});
  assert.throws(()=>steering.enqueue(s,{requestId:'overflow',text:'x',mode:'queue',model:'test'}),/full/);
});

test('Stop overrides an interrupt while the old provider is winding down',async t=>{
  let first;let calls=0;
  const f=await fixture(t,async function*(){calls++;first={};await new Promise(r=>first.release=r);yield reply('Late');});
  await f.send('Work');await until(()=>first?.release);
  const interrupt=f.send('New direction','interrupt');await until(async()=>(await f.session()).control.stopping);
  const stop=f.chat('stop');await until(async()=>(await f.session()).stopRequested?.mode==='stop');
  first.release();await Promise.all([interrupt,stop]);assert.equal(calls,1);assert.equal((await f.session()).pendingMessages[0].held,true);assert.equal((await f.session()).status,'interrupted');
});

test('workflow guidance is consumed before submission without changing the agent or bypassing a gate',async t=>{
  let first;let turn=0;const prompts=[];
  const f=await fixture(t,async function*(input){prompts.push(structuredClone(input.prompt?.messages ?? input.messages));if(++turn===1){first=gate(input.signal);await first.promise;}yield result([{type:'toolCall',id:'submit-'+turn,name:'submit_step',arguments:{summary:'Done',artifacts:[]}}]);});
  await f.act('saveWorkflow',{workflow:{id:'guided',name:'Guided',steps:[{id:'work',kind:'agent',name:'Work',prompt:'Do work'},{id:'review',kind:'human',name:'Review',prompt:'Review work'}]}});
  await f.chat('configure',{workflow:'guided'});await f.chat('startWorkflow');await until(()=>first);
  const s=await f.session();await f.send('Apply this constraint');first.release();
  await until(async()=>{const s=await f.session();return s.flow.status==='waiting_gate'&&!s.control.busy;});
  assert.equal(turn,2);assert.ok(prompts[1].some(m=>m.role==='user'&&m.content==='Apply this constraint'));assert.equal((await f.session()).currentAgentSessionId,s.currentAgentSessionId);
  await assert.rejects(f.send('Skip review'),/decision controls/);
});

test('stopping during provisioning retains the original input for explicit resume',async t=>{
  let provisioning;let provisions=0;const prompts=[];
  const f=await fixture(t,async function*(input){prompts.push(input.prompt?.messages ?? input.messages);yield reply('Done');},{execute:async(_r,c,signal)=>{
    if(c.action==='probe')return {repository:'/fixture',tools:['read_file'],shell:false};
    if(c.action==='provision'){if(++provisions===1){provisioning=gate(signal);await provisioning.promise;}return {path:'/fixture/work',branch:'test'};}
    if(c.action==='diff')return {digest:'same'};
  }});
  await f.act('registerRunner',{name:'Local',kind:'local',repository:'/fixture'});
  await f.act('setPlacement',{projectId:'agent-platform',revision:1,placement:{mode:'pinned',runnerId:(await f.runtime.snapshot()).runners[0].id}});
  const ticket=await f.act('createTicket',{title:'Work',projectId:'agent-platform',requestId:'ticket'});
  await f.chat('requestExecution',{ticketId:ticket.id,mode:'continue',brief:'Preserve this original request',requestId:'execute'});
  await until(()=>provisioning);await f.chat('stop');assert.match((await f.session()).queuedInput,/Preserve this original request/);assert.equal(prompts.length,0);
});
