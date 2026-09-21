// The stream observes execution; losing a browser connection never aborts a job.
export async function sessionStream(req,res,runtime,id,principal) {
  const client=req.headers['x-convoy-client'];
  let initial;try{initial=(await runtime.snapshot(id,client,principal)).sessions[0];}catch{return false;}
  if(req.destroyed||res.destroyed)return true;
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders();
  let closed=false;let timer;let partialTimer;let latestPartial;let reading=false;let dirty=false;
  let blocked=false;const pending=new Map();
  const send=(type,data)=>{if(closed)return;if(blocked){pending.set(type,data);return;}blocked=!res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);};
  // Coalesce while the socket drains; normal large snapshots are not disconnects.
  const drain=()=>{blocked=false;for(const [type,data] of pending){pending.delete(type);send(type,data);if(blocked)break;}};
  res.on('drain',drain);
  send('session',initial);
  async function refresh(){
    timer=undefined;if(closed)return;if(reading){dirty=true;return;}reading=true;
    try{send('session',(await runtime.snapshot(initial.id,client,principal)).sessions[0]);}catch{res.destroy();}finally{reading=false;if(dirty){dirty=false;schedule();}}
  }
  function schedule(){if(!closed&&!timer)timer=setTimeout(refresh,100);}
  const unsubscribe=runtime.subscribe(change=>{
    if(change.type==='partial'&&change.id===initial.id){latestPartial=change;if(!partialTimer)partialTimer=setTimeout(()=>{partialTimer=undefined;send('partial',latestPartial);},35);}
    else if(change.type==='change')schedule();
  });
  const heartbeat=setInterval(()=>{if(!closed&&!blocked)blocked=!res.write(': heartbeat\n\n');},15000);
  const close=()=>{if(closed)return;closed=true;unsubscribe();res.off('drain',drain);pending.clear();clearTimeout(timer);clearTimeout(partialTimer);clearInterval(heartbeat);};
  res.on('close',close);req.on('aborted',close);schedule();return true;
}
