import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createRuntime} from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import {createApp} from '../../apps/daemon/src/http/app.mjs';
const reply=text=>({type:'result',message:{role:'assistant',content:[{type:'text',text}],timestamp:Date.now(),stopReason:'stop'}});
async function until(fn){for(let i=0;i<400;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out');}
async function fixture(t,generate){
  const options={directory:await mkdtemp(join(tmpdir(),'convoy-live-test-')),models:[{id:'test'}],auth:{token:async()=> 'fake',status:async()=>({connected:true})},generate};
  const runtime=await createRuntime(options);t.after(()=>runtime.close());const app=createApp({...options,runtime});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>{app.closeAllConnections();app.close();});
  const command=(action,input={})=>runtime.command({action,client:'stream-test',...input});const c=await command('createConversation',{requestId:'stream'});const act=(action,input={})=>command(action,{sessionId:c.sessionId,...input});await act('claim');
  const session=async()=>(await runtime.snapshot()).sessions[0];
  const open=(headers={},id=c.sessionId)=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:app.address().port,path:`/api/runtime/${id}/events`,headers:{Host:'127.0.0.1:4317',...headers}},res=>{const frames=[];let buffer='';res.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n\n'))!==-1){const part=buffer.slice(0,end);buffer=buffer.slice(end+2);const type=/event: (.+)/.exec(part)?.[1];const data=/data: (.+)/.exec(part)?.[1];if(type&&data)frames.push({type,data:JSON.parse(data)});}});res.on('error',()=>{});resolve({frames,status:res.statusCode,headers:res.headers,close:()=>{res.destroy();req.destroy();}});});req.on('error',reject);req.end();});
  return {runtime,act,session,open};
}

test('SSE delivers progressive text before completion; reconnect snapshots recover without replaying work',async t=>{
  let next,finish;let calls=0;
  const f=await fixture(t,async function*({signal}){calls++;yield {type:'delta',text:'Hello'};await new Promise((r,j)=>{next=r;signal.addEventListener('abort',()=>j(new Error('Stopped')),{once:true});});yield {type:'delta',text:' world'};await new Promise((r,j)=>{finish=r;signal.addEventListener('abort',()=>j(new Error('Stopped')),{once:true});});yield reply('Hello world');});
  const stream=await f.open();t.after(stream.close);assert.equal(stream.status,200);assert.match(stream.headers['content-type'],/event-stream/);await until(()=>stream.frames.some(f=>f.type==='session'));
  await f.act('sendMessage',{text:'Hi',model:'test',mode:'queue',requestId:'hi'});
  const first=await until(()=>stream.frames.find(f=>f.type==='partial'&&f.data.text==='Hello'));assert.equal((await f.session()).control.busy,true);
  next();const second=await until(()=>stream.frames.find(f=>f.type==='partial'&&f.data.text==='Hello world'));assert.ok(second.data.version>first.data.version);
  stream.close();assert.equal((await f.session()).control.busy,true);const reconnect=await f.open();t.after(reconnect.close);
  await until(()=>reconnect.frames.some(f=>f.type==='session'&&f.data.partial==='Hello world'));finish();
  const final=await until(()=>reconnect.frames.find(f=>f.type==='session'&&f.data.status==='awaiting_review'&&!f.data.control.busy));assert.equal(final.data.partial,'');assert.equal(final.data.events.filter(e=>e.type==='assistant').length,1);assert.equal(calls,1);assert.equal(final.data.lease.client,'stream-test');
});

test('tool events correlate exact approval and denial; observing never grants control',async t=>{
  let turn=0;
  const f=await fixture(t,async function*(){yield ++turn===1?{type:'result',message:{role:'assistant',content:[{type:'toolCall',id:'call-one',name:'create_ticket',arguments:{requestKey:'one',projectId:'agent-platform',title:'Proposed work',description:'Do not execute'}}],timestamp:Date.now(),stopReason:'toolUse'}}:reply('Denied');});
  const stream=await f.open();t.after(stream.close);await f.act('sendMessage',{text:'Propose',model:'test',mode:'queue',requestId:'propose'});
  const pending=await until(()=>stream.frames.find(f=>f.type==='session'&&f.data.pending)?.data.pending);assert.equal(pending.callId,'call-one');assert.equal(pending.args.title,'Proposed work');
  await assert.rejects(f.act('decide',{client:'foreign-client',approvalId:pending.id,allow:true}),/Claim/);await f.act('decide',{approvalId:pending.id,allow:false});
  await until(async()=>!(await f.session()).control.busy);const s=await f.session();const request=s.events.find(e=>e.type==='tool_requested');const result=s.events.find(e=>e.type==='tool_result');assert.equal(request.callId,result.callId);assert.equal(result.isError,true);assert.ok(!s.events.some(e=>e.type==='tool_started'));assert.equal((await f.runtime.snapshot()).tickets.length,0);
});

test('provider failure retains streamed partial text as interrupted, not completed',async t=>{
  const f=await fixture(t,async function*(){yield {type:'delta',text:'Unfinished evidence'};throw new Error('Provider disconnected');});await f.act('sendMessage',{text:'Go',model:'test',mode:'queue',requestId:'go'});await until(async()=>!(await f.session()).control.busy);const s=await f.session();assert.equal(s.status,'failed');assert.equal(s.partial,'');assert.ok(s.events.some(e=>e.type==='assistant_interrupted'&&e.text==='Unfinished evidence'));assert.ok(!s.events.some(e=>e.type==='assistant'));
});

test('SSE enforces origin and session validation and removes observers on disconnect',async t=>{
  const f=await fixture(t,async function*(){yield reply('Done');});const denied=await f.open({Origin:'https://evil.example'});assert.equal(denied.status,403);denied.close();const missing=await f.open({},'99');assert.equal(missing.status,404);missing.close();
  let notifications=0;const remove=f.runtime.subscribe(()=>notifications++);await f.act('heartbeat');assert.ok(notifications);remove();const prior=notifications;await f.act('heartbeat');assert.equal(notifications,prior);
});

test('large snapshots survive normal socket backpressure and still receive later changes',async t=>{
  const f=await fixture(t,async function*(){yield reply('Large response '.repeat(10000));});await f.act('sendMessage',{text:'Large',model:'test',mode:'queue',requestId:'large'});await until(async()=>!(await f.session()).control.busy);
  const stream=await f.open();t.after(stream.close);const first=await until(()=>stream.frames.find(f=>f.type==='session'));assert.ok(JSON.stringify(first.data).length>100000);await f.act('release');await until(()=>stream.frames.some(f=>f.type==='session'&&f.data.lease===null));
});
