import { digest } from '../../../../../packages/runner/src/index.mjs';

export const CONTINUE_INPUT = 'Continue from recorded results and the latest user direction. Do not repeat completed operations or automatically retry operations with unknown outcomes. Inspect the available evidence first.';
export const activeFlow = s => !!s.flow && !['completed','cancelled'].includes(s.flow.status);
export function messageBinding(s) { return activeFlow(s) ? `${s.flow.id}:${s.flow.instance}` : `chat:${s.currentAgentSessionId ?? 'main'}`; }
export function canMessage(s) {
  if (!activeFlow(s)) return !s.workflow || ['completed','cancelled'].includes(s.flow?.status);
  const node = (s.workflow?.nodes ?? s.workflow?.steps ?? []).find(n=>n.id===s.flow.nodeId);
  return node?.kind==='agent' && !['waiting_gate','awaiting_continue'].includes(s.flow.status);
}

export function createSteering(event) {
  function request(s, id, payload) {
    if(typeof id!=='string'||!id.trim()||id.length>100)throw new Error('A valid message request ID is required.');
    s.steeringRequests??={};const hash=digest(JSON.stringify(payload));
    if(Object.hasOwn(s.steeringRequests,id)){if(s.steeringRequests[id]!==hash)throw new Error('Request ID already used for different input.');return false;}
    if(Object.keys(s.steeringRequests).length>=2000)throw new Error('Session message request limit reached. Start a new conversation.');
    s.steeringRequests[id]=hash;return true;
  }
  return {
    enqueue(s,c,held=false) {
      if(typeof c.text!=='string'||(!c.text.trim()&&!c.attachments?.length)||c.text.length>12000)throw new Error('Add a message or attachment (text limit: 12000 characters).');
      if(!['queue','interrupt'].includes(c.mode))throw new Error('Choose queue or interrupt.');
      const payload={text:c.text.trim(),mode:c.mode,model:c.model,...(c.attachments?.length?{attachmentIds:c.attachments.map(f=>f.id)}:{})};
      // Check retries before limits; never duplicate a delivered or discarded message.
      if(Object.hasOwn(s.steeringRequests??{},c.requestId)){request(s,c.requestId,payload);return false;}
      s.pendingMessages??=[];
      const textBytes=items=>items.reduce((n,m)=>n+(m.attachments??[]).filter(f=>f.mime==='text/plain').reduce((a,f)=>a+f.size,0),0);
      if(textBytes([...s.pendingMessages,c])>128000)throw new Error('Queued text attachments exceed 128 KB. Wait for delivery before adding more.');
      if(s.pendingMessages.length>=20||s.pendingMessages.reduce((n,m)=>n+m.text.length,0)+payload.text.length>60000)throw new Error('Message queue is full. Remove a message or let the agent continue.');
      request(s,c.requestId,payload);
      s.pendingMessages.push({id:c.requestId,text:payload.text,attachments:c.attachments??[],model:c.model,binding:messageBinding(s),held,at:new Date().toISOString()});
      event(s,'message_queued',{requestId:c.requestId,text:payload.text,attachments:c.attachments??[],held});return true;
    },
    resumeRequest(s,c){return request(s,c.requestId,{action:'resumeSession',acknowledge:c.acknowledge===true});},
    ready(s){return (s.pendingMessages??[]).some(m=>!m.held&&m.binding===messageBinding(s));},
    deliver(s){
      const messages=(s.pendingMessages??[]).filter(m=>!m.held&&m.binding===messageBinding(s));
      s.pendingMessages=(s.pendingMessages??[]).filter(m=>!messages.includes(m));
      for(const m of messages){s.messages.push({role:'user',content:m.text,attachments:m.attachments??[],timestamp:Date.now()});event(s,'user',{text:m.text,attachments:m.attachments??[],requestId:m.id,queued:true});}
      return messages.length;
    },
    hold(s,reason){for(const m of s.pendingMessages??[]){m.held=true;m.reason=reason;}},
    release(s){
      if((s.pendingMessages??[]).some(m=>m.binding!==messageBinding(s)))throw new Error('The workflow or agent session changed. Remove held messages and send fresh direction for the current step.');
      for(const m of s.pendingMessages??[]){m.held=false;delete m.reason;}
    },
    discard(s,id){const m=s.pendingMessages?.find(m=>m.id===id);if(!m)throw new Error('Message was already delivered or removed.');s.pendingMessages=s.pendingMessages.filter(m=>m.id!==id);event(s,'message_removed',{requestId:id});},
    interrupt(s,reason,needsReview=false){
      const partial=s.partial||'';if(partial)event(s,'assistant_interrupted',{text:partial});s.partial='';
      const previous=s.interruption;
      s.interruption={at:new Date().toISOString(),reason,needsReview:needsReview||previous?.needsReview===true,tool:s.inFlightTool?.name??(previous?.needsReview?previous.tool:undefined),lastCompletedTool:s.events.filter(e=>e.type==='tool_result'&&!e.isError).at(-1)?.tool};
      event(s,'execution_interrupted',{message:reason,needsReview:s.interruption.needsReview,tool:s.interruption.tool});
    },
    settle(s){
      const resolved=new Set(s.messages.filter(m=>m.role==='toolResult').map(m=>m.toolCallId));
      for(const m of [...s.messages])for(const call of m.role==='assistant'?(m.content??[]):[]){
        if(call.type==='toolCall'&&!resolved.has(call.id)){
          const unknown=s.inFlightTool?.callId===call.id;
          const output={error:unknown?'Execution was interrupted; outcome may be partial. Inspect before retrying.':'Not executed: this turn was stopped before the tool ran.'};
          s.messages.push({role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:JSON.stringify(output)}],isError:true,timestamp:Date.now()});resolved.add(call.id);
          event(s,'tool_result',{tool:call.name,callId:call.id,output,isError:true});
        }
      }
    },
  };
}
