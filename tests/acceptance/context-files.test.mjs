import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request} from 'node:http';
import {createContextFiles} from '../../apps/daemon/src/adapters/persistence/context-files.mjs';
import {createRuntime} from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import {createApp} from '../../apps/daemon/src/http/app.mjs';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=';
const file=(name,text)=>({name,mime:'text/plain',data:Buffer.from(text).toString('base64')});
const image={name:'screenshot.png',mime:'image/png',data:png};
async function until(fn){for(let i=0;i<300;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,10));}throw new Error('Timed out');}
async function fixture(t,generate,runners){
  const directory=await mkdtemp(join(tmpdir(),'convoy-context-test-'));const prompts=[];
  const options={directory,models:[{id:'vision',input:['text','image']},{id:'text-only',input:['text']}],auth:{token:async()=> 'fake',status:async()=>({connected:true})},runners,
    generate:async function*(input){prompts.push(structuredClone(input.messages));if(generate)await generate(input,prompts.length);yield {type:'result',message:{role:'assistant',content:[{type:'text',text:'Done'}],timestamp:Date.now(),stopReason:'stop'}};}};
  const runtime=await createRuntime(options);t.after(()=>runtime.close());
  const act=(action,data={})=>runtime.command({action,client:'context-test',...data});
  const c=await act('createConversation',{requestId:'chat',projectId:'agent-platform'});const chat=(action,data={})=>act(action,{sessionId:c.sessionId,...data});await chat('claim');
  const session=async()=>(await runtime.snapshot()).sessions.find(s=>s.id===c.sessionId);
  const done=()=>until(async()=>{const s=await session();return !s.control.busy&&s.status==='awaiting_review';});
  const send=(text,attachmentIds,extra={})=>chat('sendMessage',{text,attachmentIds,model:'vision',mode:'queue',requestId:text||'attachment-only',...extra});
  return {directory,options,runtime,act,chat,session,done,send,prompts,c};
}

test('immutable attachment storage validates formats, ownership, limits, integrity and permissions',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'convoy-files-test-'));const files=createContextFiles(directory);const s={id:'one'};
  const meta=await files.add(s,file('scope.md','# Scope\nBuild search'));
  assert.deepEqual(await files.add(s,file('scope.md','# Scope\nBuild search')),meta);
  assert.equal((await stat(join(directory,'context-files',meta.id))).mode&0o777,0o600);
  await assert.rejects(files.read({id:'other'},meta.id),/not found/);
  await assert.rejects(files.add(s,file('../scope.md','bad')),/filename/);
  await assert.rejects(files.add(s,file('document.pdf','%PDF')),/not supported/);
  await assert.rejects(files.add(s,file('binary.txt','\0bad')),/Binary/);
  await assert.rejects(files.add(s,file('large.txt','x'.repeat(64001))),/64 KB/);
  await assert.rejects(files.add(s,{...image,data:Buffer.from('not an image').toString('base64')}),/Invalid/);
  const img=await files.add(s,image);await assert.rejects(files.select(s,[img.id],{input:['text']}),/does not support/);
  await assert.rejects(files.select(s,[meta.id,meta.id]),/distinct/);
  await writeFile(join(directory,'context-files',meta.id),'tampered');await assert.rejects(files.read(s,meta.id),/changed/);
});

test('text and images reach the provider as content, not paths or base64 prose; snapshots omit payloads',async t=>{
  const f=await fixture(t);const text=await f.chat('attachContext',file('scope.md','UNIQUE_FILE_CONTENT'));const img=await f.chat('attachContext',image);
  await f.send('Use these',[text.id,img.id]);await f.done();const content=f.prompts[0][0].content;
  assert.ok(content.some(c=>c.type==='text'&&c.text.includes('UNIQUE_FILE_CONTENT')));assert.ok(content.some(c=>c.type==='image'&&c.data===png&&c.mimeType==='image/png'));
  const snapshot=JSON.stringify(await f.runtime.snapshot());assert.ok(!snapshot.includes(png));assert.ok(!snapshot.includes('UNIQUE_FILE_CONTENT'));assert.equal((await f.session()).events.find(e=>e.type==='user').attachments.length,2);
  await f.send('Use these',[text.id,img.id]);assert.equal(f.prompts.length,1);
  await assert.rejects(f.send('Use these',[text.id]),/different input/);
  const other=await f.act('createConversation',{requestId:'other'});await f.act('claim',{sessionId:other.sessionId});await assert.rejects(f.act('sendMessage',{sessionId:other.sessionId,text:'Steal',attachmentIds:[text.id],model:'vision',mode:'queue',requestId:'steal'}),/not found/);
});

test('attachment-only messages work; unsupported models and foreign controllers are rejected',async t=>{
  const f=await fixture(t);const img=await f.chat('attachContext',image);
  await assert.rejects(f.send('',[img.id],{model:'text-only'}),/does not support/);
  await assert.rejects(f.chat('attachContext',{...file('no.md','no'),client:'foreign-client'}),/Claim/);
  await f.send('',[img.id]);await f.done();assert.equal((await f.session()).title,'screenshot.png');
  assert.equal(f.prompts[0][0].content.filter(c=>c.type==='image').length,1);
  assert.ok(!f.prompts[0][0].content.some(c=>c.type==='text'&&!c.text));
  await assert.rejects(f.send('Switch model',[],{model:'text-only'}),/contains images/);
});

test('queued attachments survive stop and restart and are delivered once on resume',async t=>{
  let started=false;let calls=0;
  const f=await fixture(t,async(input)=>{if(++calls===1){started=true;await new Promise((resolve,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('Stopped')),{once:true}));}});
  await f.send('Start',[]);await until(()=>started);const img=await f.chat('attachContext',image);await f.send('Next',[img.id]);await f.chat('stop');await f.runtime.close();
  const restarted=await createRuntime(f.options);t.after(()=>restarted.close());assert.equal(calls,1);
  await restarted.command({action:'claim',sessionId:f.c.sessionId,client:'restart-client'});await restarted.command({action:'resumeSession',sessionId:f.c.sessionId,client:'restart-client',requestId:'resume'});
  await until(()=>calls===2);assert.ok(f.prompts[1].at(-1).content.some(c=>c.type==='image'&&c.data===png));
});

test('workspace references use the assigned runner and pin bytes instead of rereading at send',async t=>{
  let contents='Version one';const reads=[];
  const f=await fixture(t,null,{execute:async(r,c)=>{
    if(c.action==='probe')return {repository:'/fixture',tools:['read_file'],shell:false};
    if(c.action==='provision')return {path:'/fixture/work',branch:'fixture'};
    if(c.action==='tool'){reads.push({runner:r.id,...c});return {text:contents};}
    return {digest:'same'};
  }});
  await assert.rejects(f.chat('attachContext',{path:'src/a.ts'}),/No workspace/);
  await f.act('registerRunner',{name:'Fixture',kind:'local',repository:'/fixture'});const runner=(await f.runtime.snapshot()).runners[0];await f.chat('configure',{runnerId:runner.id});
  await assert.rejects(f.chat('attachContext',{path:'../private'}),/relative/);
  const meta=await f.chat('attachContext',{path:'src/a.ts'});contents='Version two';await f.send('Review',[meta.id]);await f.done();
  assert.equal(reads.length,1);assert.equal(reads[0].runner,runner.id);assert.equal(meta.source.path,'src/a.ts');assert.ok(JSON.stringify(f.prompts[0]).includes('Version one'));assert.ok(!JSON.stringify(f.prompts[0]).includes('Version two'));
});

test('attachment downloads retain local access guards and safe content headers',async t=>{
  const f=await fixture(t);const meta=await f.chat('attachContext',file('page.html','<script>not executable</script>'));
  const app=createApp({...f.options,runtime:f.runtime});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(()=>{app.closeAllConnections();app.close();});
  const get=(path,headers={})=>new Promise((resolve,reject)=>{const req=request({host:'127.0.0.1',port:app.address().port,path,headers:{Host:'127.0.0.1:4317',...headers}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.end();});
  const path=`/api/context/${f.c.sessionId}/${meta.id}`;const result=await get(path);assert.equal(result.status,200);assert.equal(result.headers['content-type'],'text/plain');assert.equal(result.headers['x-content-type-options'],'nosniff');assert.match(result.headers['content-security-policy'],/sandbox/);
  assert.equal((await get(path,{Origin:'https://evil.example'})).status,403);assert.equal((await get(`/api/context/99/${meta.id}`)).status,404);
});
