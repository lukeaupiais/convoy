import test from 'node:test';
import assert from 'node:assert/strict';
import { boardAutomationRelationships, normalizeWorkflow } from '../../apps/daemon/src/modules/workflows/index.mjs';
import { resolveBoardEffect, workAutomationCapabilities } from '../../apps/daemon/src/modules/work/index.mjs';
const project = { id:'procurement', organizationId:'personal' };
const board = id => ({ id, revision:1, projectIds:[project.id], columns:[{id:'ready',name:'Ready',value:'Ready'}], grouping:{mode:'field',field:'status'} });
const workflow = (version,nodes=[]) => ({id:'assessment',organizationId:'personal',name:'Assessment',version,nodes});
const rule = {id:'r',name:'Assess supplier',organizationId:'personal',projectId:project.id,when:{event:'ticket_moved',boardId:'intake',columnId:'ready'},if:[],then:{action:'start_workflow',workflowId:'assessment',workflowVersion:1},revision:2,enabled:false};
const resolveEffect = input => resolveBoardEffect(input);
test('cross-board effects retain exact pinned publications and rule provenance',()=>{
 const v1=workflow(1,[{id:'route',name:'Route supplier',kind:'action',operation:'move_ticket',input:{boardId:'purchasing',placement:{columnId:'ready'}}}]);
 const result=boardAutomationRelationships({boards:[board('intake'),board('purchasing')],projects:[project],workflows:[v1,workflow(2)],rules:[rule],resolveEffect});
 assert.equal(result.intake.relationships[0].enabled,false);
 assert.deepEqual(result.purchasing.relationships.map(r=>[r.kind,r.workflowVersion,r.olderVersion]),[['effect',1,true]]);
 assert.equal(result.purchasing.relationships[0].referencedBy[0].ruleId,'r');
 assert.equal(boardAutomationRelationships({boards:[board('purchasing')],projects:[project],workflows:[v1,workflow(2)],rules:[],resolveEffect}).purchasing.relationships.length,0);
});
test('mapped external effects require explicit mapping and authorized connection',()=>{
 const input={connectionId:'external',status:'awaiting'};
 const connections=[{id:'external',manifest:{operations:{status:{}},values:{status:{awaiting:'Ready'}}}}];
 const bindings=[{id:'source',projectId:project.id,connectionId:'external',workType:'supplier'}];
 const args={operation:'set_external_status',input,board:board('purchasing'),connections,bindings};
 assert.equal(resolveBoardEffect(args).columnId,'ready');
 assert.equal(resolveBoardEffect(args).indirect,true);
 assert.equal(resolveBoardEffect({...args,connections:[]}),null);
 assert.equal(resolveBoardEffect({...args,input:{...input,status:'unknown'}}).unresolved,true);
 assert.equal(resolveBoardEffect({...args,board:{...args.board,filters:{query:'arbitrary'}}}).unresolved,true);
});
test('editorial and facilities effects use declared field values without name inference',()=>{
 for(const name of ['Editorial','Facilities']){
  const b={...board(name),columns:[{id:'done',name:'Finished',value:'accepted'}]};
  assert.equal(resolveBoardEffect({operation:'update_ticket',input:{patch:{status:'accepted'}},board:b}).columnId,'done');
  assert.equal(resolveBoardEffect({operation:'update_ticket',input:{patch:{status:'Finished'}},board:b}).unresolved,true);
 }
});
test('canonical actions reject legacy payloads and embedded triggers',()=>{
 assert.throws(()=>normalizeWorkflow({id:'test',name:'Test',nodes:[{id:'a',name:'A',kind:'action',operation:'move_ticket',args:{boardId:'x',columnId:'y'}}]}),/canonical/);
 assert.throws(()=>normalizeWorkflow({id:'test',name:'Test',nodes:[{id:'a',name:'A',kind:'human'}],triggers:[{event:'ticket_created'}]}),/Embedded/);
 assert.equal(workAutomationCapabilities.events.find(e=>e.id==='ticket_message_received').label,'Message received');
});

test('effects respect team eligibility and explicit ticket targets',()=>{
 const boards=[board('b')];
 const rows=boardAutomationRelationships({boards,projects:[{...project,teamId:'b'},{id:'other',organizationId:'personal',teamId:'a'}],workflows:[{...workflow(1,[{id:'update',name:'Update',kind:'action',operation:'update_ticket',input:{ticketSource:'active_ticket',patch:{status:'Ready'}}}]),teamId:'a'}],rules:[],resolveEffect}).b.relationships;
 assert.deepEqual(rows,[]);
 const args={operation:'update_ticket',input:{ticketId:123,patch:{status:'Ready'}},board:boards[0],tickets:[{id:123,projectId:'other'}]};
 assert.equal(resolveBoardEffect(args),null);
 assert.equal(resolveBoardEffect({...args,input:{ticketSource:'last_created',patch:{status:'Ready'}}}).unresolved,true);
});
