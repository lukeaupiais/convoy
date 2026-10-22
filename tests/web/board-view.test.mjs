import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = ts.transpileModule(await readFile(new URL('../../apps/web/src/features/board/BoardView.tsx', import.meta.url),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText.replace(/^import[\s\S]*?;\n/gm,'');
const {sameBoardView}=await import('data:text/javascript;base64,'+Buffer.from('const memo = component => component;\n'+source).toString('base64'));
const callback=()=>{};
const base={
 board:{id:'suppliers',columns:[{id:'intake',name:'Intake'}],tickets:[{ticketId:1,columnId:'intake'}],filters:{},cardFields:['priority']},
 tickets:[{id:1,title:'Review supplier',revision:1}],
 state:{projects:[{id:'p',name:'Purchasing'}],ticketConnections:[{id:'source',enabled:true}],ticketImportMemberships:[],boardAutomations:{suppliers:{relationships:[]}}},
 query:'',view:'board',runtimeAvailable:true,moves:{},moveRevision:0,
 projectName:callback,onMove:callback,onSelectTicket:callback,onNewTicket:callback,onOpenWorkflow:callback,
};
const copy=()=>({...structuredClone({board:base.board,tickets:base.tickets,state:base.state}),...Object.fromEntries(Object.entries(base).filter(([key])=>!['board','tickets','state'].includes(key)))});
test('unchanged polling and unrelated provider activity preserve the board view',()=>{
 const next=copy();next.state.providerOutcomes=[{id:'new-turn'}];
 assert.equal(sameBoardView(base,next),true);
});
test('ticket edits, placement, field configuration and automation changes always refresh the view',()=>{
 for(const change of [
  next=>next.tickets[0].title='Changed',
  next=>next.tickets[0].revision++,
  next=>next.board.tickets[0].columnId='review',
  next=>next.board.cardFields.push('status'),
  next=>next.state.projects[0].name='Publication',
  next=>next.state.ticketConnections[0].enabled=false,
  next=>next.state.ticketImportMemberships.push({ticketId:1,bindingId:'import'}),
  next=>next.state.boardAutomations.suppliers.relationships.push({workflowId:'approval'}),
 ]){const next=copy();change(next);assert.equal(sameBoardView(base,next),false);}
});
test('disconnect, error, pending moves, view selection and changed actions never get cached away',()=>{
 for(const patch of [{runtimeAvailable:false},{runtimeError:'Disconnected'},{moveRevision:1},{moves:{}},{query:'supplier'},{view:'list'},{onMove:()=>{}}])
  assert.equal(sameBoardView(base,{...copy(),...patch}),false);
});
