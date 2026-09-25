import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
test('authorized snapshots explain cross-board actions without running or mutating workflows', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-board-visibility-'));
    const runtime = await createRuntime({ directory, models: [{ id: 'fixture' }],
        auth: { token: async () => 'fixture', status: async () => ({ connected: false }) },
        generate: async function* () { throw new Error('Inspection must never generate'); } });
    t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
    const client = 'board-visibility-test';
    const act = (action, input) => runtime.command({ action, client, ...input });
    const projectId = 'agent-platform';
    const intake = await act('saveBoard', { name: 'Supplier intake', projectIds: [projectId], columns: [{ id: 'ready', name: 'Awaiting assessment' }] });
    const purchasing = await act('saveBoard', { name: 'Purchasing', projectIds: [projectId], columns: [{ id: 'approved', name: 'Approved' }] });
    const workflow = { id: 'supplier-assessment', name: 'Supplier assessment', nodes: [
            { id: 'route', name: 'Route supplier', kind: 'action', operation: 'move_ticket', input: { boardId: purchasing.id, placement: { columnId: 'approved' } } },
        ] };
    await act('saveWorkflow', { workflow, baseVersion: 0 });
    const rule = await act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'Assess supplier', projectId,
            enabled: false,
            when: { event: 'ticket_moved', boardId: intake.id, columnId: 'ready' },
            if: [],
            then: { action: "start_workflow", workflowId: workflow.id, workflowVersion: 1 }
        } });
    await act('saveWorkflow', { workflow: { ...workflow, nodes: [{ id: 'review', name: 'Review', kind: 'human', prompt: 'Review documents' }] }, baseVersion: 1 });
    const before = await readFile(join(directory, 'state.json'), 'utf8');
    const snapshot = await runtime.snapshot(undefined, client);
    assert.equal(snapshot.boardAutomations[intake.id].relationships[0].ruleId, rule.id);
    assert.equal(snapshot.boardAutomations[purchasing.id].relationships[0].workflowVersion, 1);
    assert.equal(snapshot.boardAutomations[purchasing.id].relationships[0].nodeId, 'route');
    assert.equal(snapshot.boardAutomations[purchasing.id].relationships[0].olderVersion, true);
    assert.deepEqual(snapshot.sessions, []);
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), before);
    const org = await act('createOrganization', { slug: 'editorial', displayName: 'Editorial', kind: 'enterprise' });
    const editorial = await act('saveProject', { organizationId: org.id, name: 'Publication' });
    await act('selectActiveContext', { context: { organizationId: org.id, projectId: editorial.id } });
    const scoped = await runtime.snapshot(undefined, client);
    assert.equal(scoped.boardAutomations[intake.id], undefined);
    assert.equal(JSON.stringify(scoped.boardAutomations).includes('supplier-assessment'), false);
});

test('field-backed column entry uses Work before/after facts and does not retrigger unchanged values', async t => {
 const directory = await mkdtemp(join(tmpdir(),'convoy-column-facts-'));
 const runtime = await createRuntime({directory,models:[{id:'fixture'}],auth:{token:async()=> 'fixture',status:async()=>({connected:false})},generate:async function*(){}});
 t.after(async()=>{await runtime.close();await rm(directory,{recursive:true,force:true});});
 const act=(action,input)=>runtime.command({action,client:'field-test',...input});
 const board=await act('saveBoard',{name:'Facilities',projectIds:['agent-platform'],grouping:{mode:'field',field:'status'},columns:[{id:'new',name:'New',value:'New'},{id:'ready',name:'Scheduled',value:'Scheduled'}]});
 await act('saveWorkflow',{workflow:{id:'inspection',name:'Inspection',nodes:[{id:'review',name:'Review request',kind:'human'}]}});
 await act('saveAutomation',{organizationId:'personal',revision:0,rule:{name:'Schedule review',projectId:'agent-platform',when:{event:'ticket_moved',boardId:board.id,columnId:'ready'},if:[],then:{action:'start_workflow',workflowId:'inspection',workflowVersion:1},enabled:true}});
 const ticket=await act('createTicket',{requestId:'facility',projectId:'agent-platform',title:'Inspect ventilation',status:'New'});
 const changed=await act('updateTicket',{taskId:ticket.id,revision:ticket.revision,patch:{status:'Scheduled'}});
 let snapshot=await runtime.snapshot();assert.equal(snapshot.automationDecisions.filter(d=>d.status==='started').length,1);
 await act('updateTicket',{taskId:ticket.id,revision:changed.revision,patch:{status:'Scheduled'}});
 snapshot=await runtime.snapshot();assert.equal(snapshot.automationDecisions.length,1);
});
