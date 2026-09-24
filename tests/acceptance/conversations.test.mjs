import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
const reply = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now() });
const call = (name, args, id = name) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }], stopReason: 'toolUse', timestamp: Date.now() });
async function until(fn) { for (let i=0;i<400;i++) { const value=await fn(); if(value)return value; await new Promise(r=>setTimeout(r,10)); } throw new Error('Timed out'); }
async function fixture(t, generate) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-conversations-test-'));
  const prompts = [];
  const options = { directory, models: [{ id: 'test' }], auth: { token: async()=> 'fake', status: async()=>({ connected:true }) },
    generate: async function* (input) { prompts.push(structuredClone({ messages: input.prompt?.messages ?? input.messages, systemPrompt: input.prompt ? [input.prompt.stableInstructions, input.prompt.turnInstructions].filter(Boolean).join('\n\n') : input.systemPrompt, tools: input.tools })); const value = generate ? await generate(input, prompts.length) : reply('Done'); yield { type:'result', ...(value.role === 'assistant' ? { message: value } : value) }; },
    runners: { execute: async (_r, c) => c.action==='probe' ? {repository:'/fixture', tools:['read_file'], shell:false} : c.action==='provision' ? {path:'/fixture/'+c.workspaceId,branch:c.workspaceId} : c.action==='diff' ? {digest:'unchanged'} : {text:'File',sha256:'hash'} } };
  const runtime=await createRuntime(options); t.after(()=>runtime.close());
  const act=(action, data={})=>runtime.command({action,client:'conversation-test',...data});
  const c=await act('createConversation',{requestId:'new-chat'});
  await act('claim',{sessionId:c.sessionId,label:'Web'});
  const session=async()=> (await runtime.snapshot()).sessions.find(s=>s.id===c.sessionId);
  const chat=(action,data={})=>act(action,{sessionId:c.sessionId,...data});
  const ticket=title=>act('createTicket',{title,description:'Scope and acceptance criteria',projectId:'agent-platform',agent:'Unassigned',requestId:title});
  const done=()=>until(async()=> { const s=await session(); return !s.control.busy && ['awaiting_review','accepted','failed'].includes(s.status); });
  return {runtime,options,act,c,chat,session,ticket,prompts,done};
}

test('ticket-free workspace starts lazily and keeps history and agent when taking an ordinary ticket',async t=>{
  const f=await fixture(t);
  await f.act('registerRunner',{name:'Local repository',kind:'local',repository:'/fixture',projectIds:['agent-platform']});
  const runner=(await f.runtime.snapshot()).runners[0];
  const input={requestId:'workspace-chat',projectId:'agent-platform',placement:{mode:'pinned',runnerId:runner.id}};
  const c=await f.act('createConversation',input);
  const chat=(action,data={})=>f.act(action,{sessionId:c.sessionId,...data});
  const session=async()=>(await f.runtime.snapshot()).sessions.find(s=>s.id===c.sessionId);
  assert.equal((await session()).workspace,null);
  assert.equal((await session()).status,'idle');
  assert.equal((await f.runtime.snapshot()).tickets.length,0);
  assert.equal((await f.act('createConversation',input)).id,c.id);
  await assert.rejects(f.act('createConversation',{...input,placement:{mode:'none'}}),/different settings/);
  await chat('claim');await chat('start',{text:'Remember the blue architecture',model:'test',requestId:'first'});
  await until(async()=>{const s=await session();return s.workspace&&!s.control.busy;});
  const before=await session();assert.equal(before.runnerId,runner.id);
  assert.ok(f.prompts.at(-1).tools.some(t=>t.name==='read_file'));
  const ticket=await f.ticket('Ordinary-ticket');
  await chat('requestExecution',{ticketId:ticket.id,mode:'continue',brief:'Implement our earlier decision',requestId:'take'});
  await until(async()=>!(await session()).control.busy);
  const after=await session();
  assert.equal(after.currentAgentSessionId,before.currentAgentSessionId);
  assert.deepEqual(after.workspace,before.workspace);
  assert.equal(after.activeTicketId,ticket.id);
  assert.ok(JSON.stringify(f.prompts.at(-1).messages).includes('blue architecture'));
});

test('conversation assignment treats ticket status as project data', async t => {
  const f = await fixture(t);
  const ticket = await f.ticket('Archived-by-project');
  await f.act('updateTicket', { taskId: ticket.id, revision: ticket.revision, patch: { status: 'Done' } });
  const assigned = await f.chat('requestExecution', { ticketId: ticket.id, mode: 'continue', brief: 'Review this record', requestId: 'assign-project-status' });
  assert.equal(assigned.ticketId, ticket.id);
});

test('chat workspace validation is atomic and project restrictions cannot be bypassed',async t=>{
  const f=await fixture(t);
  await f.act('registerRunner',{name:'Restricted',kind:'local',repository:'/fixture',projectIds:[]});
  const runner=(await f.runtime.snapshot()).runners[0];
  const before=(await f.runtime.snapshot()).conversations.length;
  await assert.rejects(f.act('createConversation',{requestId:'no-project',placement:{mode:'pinned',runnerId:runner.id}}),/Choose a project/);
  await assert.rejects(f.act('createConversation',{requestId:'restricted',projectId:'agent-platform',placement:{mode:'pinned',runnerId:runner.id}}),/unavailable/);
  await assert.rejects(f.act('createConversation',{requestId:'invalid',projectId:'agent-platform',placement:{mode:'pinned',runnerId:'not-registered'}}),/Runner not found/);
  assert.equal((await f.runtime.snapshot()).conversations.length,before);
  const c=await f.act('createConversation',{requestId:'restricted',projectId:'agent-platform',placement:{mode:'none'}});
  assert.equal((await f.runtime.snapshot()).sessions.find(s=>s.id===c.id).placement.mode,'none');
});

test('selected remote chat workspace survives taking a ticket before the first message; explicit conflicts stay blocked',async t=>{
  const f=await fixture(t);
  const env=await f.act('saveEnvironment',{name:'Remote lab',kind:'ssh',host:'fixture-host'});
  await f.act('registerRunner',{name:'Remote repository',environmentId:env.id,repository:'/fixture',projectIds:['agent-platform']});
  const runner=(await f.runtime.snapshot()).runners[0];
  const c=await f.act('createConversation',{requestId:'remote-chat',projectId:'agent-platform',placement:{mode:'pinned',runnerId:runner.id}});
  const chat=(action,data={})=>f.act(action,{sessionId:c.id,...data});
  const session=async()=>(await f.runtime.snapshot()).sessions.find(s=>s.id===c.id);
  await chat('claim');
  const blocked=await f.ticket('Explicit-discussion-only');
  await f.act('setPlacement',{taskId:blocked.id,revision:blocked.revision,placement:{mode:'none'}});
  await assert.rejects(chat('requestExecution',{ticketId:blocked.id,mode:'continue',brief:'Do not start'}),/does not match/);
  assert.equal((await session()).activeTicketId,null);
  const ticket=await f.ticket('Remote-ticket');
  await chat('requestExecution',{ticketId:ticket.id,mode:'continue',brief:'Start in our selected repository'});
  await until(async()=>{const s=await session();return s.workspace&&!s.control.busy;});
  assert.equal((await session()).runnerId,runner.id);
  assert.equal((await session()).assignment.environmentId,env.id);
});

test('independent conversations persist without board items; legacy migration is idempotent',async t=>{
  const f=await fixture(t);
  assert.equal((await f.runtime.snapshot()).tickets.length,0);
  assert.equal((await f.act('createConversation',{requestId:'new-chat'})).id,f.c.id);
  await f.chat('start',{text:'Explore an idea without making tickets',model:'test',requestId:'message'});
  await f.done(); assert.equal((await f.runtime.snapshot()).tickets.length,0);
  await f.act('ensure',{taskId:42,title:'Legacy ticket'});
  await f.runtime.close();
  const restarted=await createRuntime(f.options);
  const state=await restarted.snapshot();
  assert.equal(state.tickets.length,1); assert.equal(state.conversations.length,2);
  assert.equal(state.sessions.find(s=>s.id===f.c.sessionId).events.filter(e=>e.type==='user').length,1);
  assert.equal(state.conversations.find(c=>c.sessionId==='42').linkedTicketIds[0],42);
  await restarted.close();
});

test('chat snapshots retain provider-reported input, output and cache usage across turns', async t => {
  const f = await fixture(t, (_input, n) => ({
    message: reply('Done'),
    usage: { inputTokens: 1000 + n, outputTokens: 20, cachedInputTokens: n === 1 ? 0 : 800 },
  }));
  await f.chat('sendMessage', { text: 'First', model: 'test', mode: 'queue', requestId: 'usage-1' });
  await f.done();
  await f.chat('sendMessage', { text: 'Second', model: 'test', mode: 'queue', requestId: 'usage-2' });
  await f.done();
  assert.deepEqual((await f.session()).modelUsage, {
    requests: 2,
    inputTokens: 2003,
    outputTokens: 40,
    cachedInputTokens: 800,
  });
});

test('agent creates an approved unassigned ticket, reuses request key and links without execution',async t=>{
  const args={requestKey:'work-one',projectId:'agent-platform',title:'Implement search',description:'Scope: add search. Acceptance: matching results.'};
  const f=await fixture(t,(_input,n)=>n<3?call('create_ticket',args,'create-'+n):reply('Recorded'));
  await f.chat('start',{text:'Record work, do not execute it',model:'test',requestId:'create'});
  let previous='';
  for(let n=0;n<2;n++){const p=await until(async()=>{const p=(await f.session()).pending;return p?.id!==previous&&p;});previous=p.id;if(!n)assert.equal((await f.runtime.snapshot()).tickets.length,0);await f.chat('decide',{approvalId:p.id,allow:true});}
  await f.done();const state=await f.runtime.snapshot();
  assert.equal(state.tickets.length,1);assert.equal(state.tickets[0].agent,'Unassigned');assert.equal(state.tickets[0].status,'Backlog');assert.equal(state.sessions.length,1);assert.equal((await f.session()).activeTicketId,null);
  assert.deepEqual(state.conversations[0].linkedTicketIds,[state.tickets[0].id]);
  assert.ok(f.prompts[0].tools.some(t=>t.name==='create_ticket'));
});

test('denied ticket creation has no board side effects',async t=>{
  const f=await fixture(t,(_i,n)=>n===1?call('create_ticket',{requestKey:'denied',projectId:'agent-platform',title:'Denied',description:'No'}):reply('Not created'));
  await f.chat('start',{text:'Suggest work',model:'test',requestId:'deny'});
  const p=await until(async()=>(await f.session()).pending);await f.chat('decide',{approvalId:p.id,allow:false});await f.done();
  assert.equal((await f.runtime.snapshot()).tickets.length,0);
});

test('agent discovers a board and moves a ticket only after approval without changing ticket status', async t => {
  let ticketId;
  let boardId;
  const f = await fixture(t, (_input, n) => n === 1
    ? call('list_work', {})
    : n === 2
      ? call('move_ticket', { ticketId, revision: 1, boardId, columnId: 'done', reason: 'Human review accepted the delivery.' })
      : reply('Moved the card explicitly.'));
  const ticket = await f.ticket('move-after-review');
  ticketId = ticket.id;
  const board = await f.act('saveBoard', {
    name: 'Delivery board',
    projectIds: ['agent-platform'],
    columns: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
    grouping: { mode: 'local' },
  });
  boardId = board.id;

  await f.chat('start', { text: 'Inspect the board, then move the reviewed ticket to Done.', model: 'test', requestId: 'move-card' });
  const pending = await until(async () => (await f.session()).pending);
  let state = await f.runtime.snapshot();
  assert.equal(pending.tool, 'move_ticket');
  assert.equal(state.tickets.find(value => value.id === ticket.id).status, 'Backlog');
  assert.equal(state.boards.find(value => value.id === board.id).tickets.find(value => value.ticketId === ticket.id).columnId, 'todo');
  assert.ok(f.prompts[0].tools.some(tool => tool.name === 'move_ticket'));
  const listed = JSON.parse(f.prompts[1].messages.find(message => message.role === 'toolResult').content[0].text);
  const listedBoard = listed.boards.find(value => value.id === board.id);
  assert.equal(listedBoard.name, 'Delivery board');
  assert.deepEqual(listedBoard.columns.map(column => column.id), ['todo', 'done']);
  assert.deepEqual(listedBoard.placements, [{ ticketId: ticket.id, columnId: 'todo' }]);

  await f.chat('decide', { approvalId: pending.id, allow: true });
  await f.done();
  state = await f.runtime.snapshot();
  assert.equal(state.boards.find(value => value.id === board.id).tickets.find(value => value.ticketId === ticket.id).columnId, 'done');
  assert.equal(state.tickets.find(value => value.id === ticket.id).status, 'Backlog');
  const moveResult = JSON.parse(f.prompts[2].messages.filter(message => message.role === 'toolResult').at(-1).content[0].text);
  assert.deepEqual(moveResult, {
    ticketId: ticket.id,
    boardId: board.id,
    placement: { columnId: 'done', swimlaneKey: null, revision: 1 },
    fromColumnId: 'todo',
    toColumnId: 'done',
    ticketFieldsChanged: [],
    revision: 2,
  });
});

test('agent takes a ticket during a live conversation and gains tools without replacing context', async t=>{
  let ticketId;
  const f=await fixture(t,(_input,n)=>n===1?call('request_execution',{ticketId,mode:'continue',brief:'Implement here'}):reply('Same agent continuing'));
  ticketId=(await f.ticket('agent-takes-work')).id;
  await f.act('registerRunner',{name:'Fixture',kind:'local',repository:'/fixture'});
  await f.act('setPlacement',{projectId:'agent-platform',revision:1,placement:{mode:'pinned',runnerId:(await f.runtime.snapshot()).runners[0].id}});
  await f.chat('start',{text:'You implement this ticket, retaining this decision: blue',model:'test',requestId:'take'});
  const pending=await until(async()=>(await f.session()).pending);
  const identity=(await f.session()).currentAgentSessionId;
  await f.chat('decide',{approvalId:pending.id,allow:true}); await f.done();
  assert.equal((await f.session()).activeTicketId,ticketId);
  assert.equal((await f.session()).currentAgentSessionId,identity);
  assert.ok(f.prompts[1].tools.some(t=>t.name==='read_file'));
  assert.match(f.prompts[1].messages[0].content,/blue/);
  assert.match(JSON.stringify(f.prompts[1].messages),/agent-takes-work/);
  assert.doesNotMatch(f.prompts[1].systemPrompt,/agent-takes-work/);
});

test('continue here retains history and agent identity, uses placement and enforces one assignment',async t=>{
  const f=await fixture(t);await f.chat('start',{text:'Remember the blue architecture decision',model:'test',requestId:'plan'});await f.done();
  const identity=(await f.session()).currentAgentSessionId;
  const ticket=await f.ticket('first');const second=await f.ticket('second');
  await f.act('registerRunner',{name:'Fixture',kind:'local',repository:'/fixture'});
  const runner=(await f.runtime.snapshot()).runners[0];
  await f.act('setPlacement',{projectId:'agent-platform',revision:1,placement:{mode:'pinned',runnerId:runner.id}});
  await f.chat('requestExecution',{ticketId:ticket.id,mode:'continue',brief:'Implement the blue decision',requestId:'execute'});await f.done();
  assert.equal((await f.session()).currentAgentSessionId,identity);assert.equal((await f.session()).activeTicketId,ticket.id);assert.ok((await f.session()).workspace);
  assert.match(f.prompts[1].messages[0].content,/blue architecture/);assert.ok(f.prompts[1].tools.some(t=>t.name==='read_file'));
  assert.equal((await f.runtime.snapshot(ticket.id)).sessions[0].id,f.c.sessionId);
  await assert.rejects(f.chat('requestExecution',{ticketId:second.id,mode:'continue',brief:'Do second'}),/active assignment/);
  await until(async()=>{try{await f.chat('releaseTicket');return true;}catch(e){if(!/Finish/.test(e.message))throw e;}});
  await f.chat('requestExecution',{ticketId:second.id,mode:'continue',brief:'Do second'});await f.done();
  assert.equal((await f.session()).currentAgentSessionId,identity);assert.equal((await f.session()).activeTicketId,second.id);
  await f.act('updateTicket',{taskId:ticket.id,revision:(await f.runtime.snapshot()).tickets.find(t=>t.id===ticket.id).revision,patch:{description:'Independent prior ticket'}});
  assert.notEqual((await f.session()).description,'Independent prior ticket');
});

test('delegation uses separate history and returns results; queue creates no session',async t=>{
  const f=await fixture(t);const one=await f.ticket('delegated');const two=await f.ticket('queued');
  await f.chat('start',{text:'Private exploratory discussion',model:'test',requestId:'talk'});await f.done();
  await f.chat('rememberContext',{summary:'Decision: implement accessible search. Artifact: design.md (source workspace only).'});
  const delegated=await f.chat('requestExecution',{ticketId:one.id,mode:'delegate',brief:'Implement accessible search; review design.md if available',requestId:'delegate-once'});
  await until(async()=>(await f.session()).events.some(e=>e.type==='delegation_result'));
  const state=await f.runtime.snapshot();const child=state.sessions.find(s=>s.id===delegated.sessionId);
  assert.notEqual(child.id,f.c.sessionId);assert.equal(child.activeTicketId,one.id);assert.equal((await f.session()).activeTicketId,null);
  assert.equal(f.prompts[1].messages.length,2);assert.doesNotMatch(f.prompts[1].messages[0].content,/Private exploratory/);assert.match(f.prompts[1].messages[0].content,/No source worktree/);assert.match(f.prompts[1].messages[1].content,/convoy_runtime_snapshot/);
  const again=await f.chat('requestExecution',{ticketId:one.id,mode:'delegate',brief:'Same retry',requestId:'delegate-once'});assert.equal(again.sessionId,child.id);
  await f.chat('requestExecution',{ticketId:two.id,mode:'queue'});assert.equal((await f.runtime.snapshot()).sessions.length,2);
  assert.equal((await f.runtime.snapshot()).tickets.find(t=>t.id===two.id).executionSessionId,undefined);
});

test('project context cannot leak through reassignment; workflow decisions and release do not control ticket status',async t=>{
  const f=await fixture(t);const one=await f.ticket('one');
  await f.chat('requestExecution',{ticketId:one.id,mode:'continue',brief:'Plan'});await f.done();
  await f.act('saveWorkflow',{workflow:{id:'same-agent',name:'Review',steps:[{id:'review',kind:'human',name:'Review',prompt:'Approve',phase:'In review'}]}});
  await f.chat('configure',{workflow:'same-agent'});const identity=(await f.session()).currentAgentSessionId;await f.chat('startWorkflow');
  assert.equal((await f.runtime.snapshot()).tickets[0].status,'Backlog');
  const instance=(await f.session()).flow.instance;
  await f.act('updateTicket',{taskId:one.id,revision:(await f.runtime.snapshot()).tickets[0].revision,patch:{status:'Ready'}});
  assert.equal((await f.session()).flow.instance,instance);
  assert.equal((await f.session()).flow.status,'waiting_gate');
  await f.chat('approveGate',{instance:(await f.session()).flow.instance});
  await f.chat('releaseTicket');assert.equal((await f.runtime.snapshot()).tickets[0].status,'Ready');
  const p=await f.act('saveProject',{name:'Other'});
  const other=await f.act('createTicket',{title:'Other work',projectId:p.id,requestId:'other'});
  await assert.rejects(f.chat('requestExecution',{ticketId:other.id,mode:'continue',brief:'Other'}),/another project/);
  assert.equal((await f.session()).currentAgentSessionId,identity);
});

test('context compaction retains full history and a durable checkpoint',async t=>{
  const f=await fixture(t,(input)=>input.systemPrompt?.startsWith('Summarize conversation')?reply('Decision: blue architecture; do not deploy.'):reply('Continuing'));
  await f.runtime.close();
  const path=join(f.options.directory,'state.json');const data=JSON.parse(await readFile(path,'utf8'));
  const s=data.sessions[f.c.sessionId];s.messages=Array.from({length:24},(_,i)=>i%2?reply('Evidence '+ 'x'.repeat(9500)):{role:'user',content:'Blue architecture '+ 'y'.repeat(9500),timestamp:Date.now()});
  await writeFile(path,JSON.stringify(data));
  const runtime=await createRuntime(f.options);
  try {
    await runtime.command({action:'claim',sessionId:s.id,client:'context-test'});
    await runtime.command({action:'start',sessionId:s.id,client:'context-test',model:'test',text:'Continue',requestId:'continue'});
    await until(async()=>(await runtime.snapshot()).sessions[0].status==='awaiting_review');
    assert.ok(f.prompts.at(-1).messages.length<24);assert.match(f.prompts.at(-1).messages[0].content,/blue architecture/);
  } finally { await runtime.close(); }
  const saved=JSON.parse(await readFile(path,'utf8')).sessions[s.id];
  assert.equal(saved.messages.length,27);assert.ok(saved.agentSessions[saved.currentAgentSessionId].checkpoint.summary);
});
