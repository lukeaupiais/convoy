'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
async function snapshot(locator,limit=6000){const t=await locator.ariaSnapshot({timeout:2000});return t.length>limit?t.slice(0,limit)+'\n[Truncated; inspect a narrower region.]':t;}
function clean(v){if(Array.isArray(v))return v.map(clean);if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,/password|secret|token|cookie|authorization|credential|csrf|api.?key/i.test(k)?'[redacted]':clean(x)]));return v;}
function preview(v){if(Array.isArray(v))return {items:v.length};if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,x&&typeof x==='object'?Array.isArray(x)?{items:x.length}:JSON.stringify(x).slice(0,240):typeof x==='string'?x.slice(0,240):x]));return v;}
async function withPage({modulePath,cdpEndpoint,evidenceDir=path.join(__dirname,'evidence')},action){
 if(!modulePath||!cdpEndpoint)throw Error('Use the runtime-declared browser configuration.');
 const{chromium}=require(modulePath);let browser,page,listener;const pending=[],records=[];
 try{
  browser=await chromium.connectOverCDP(cdpEndpoint,{timeout:10000});page=browser.contexts()[0]?.pages()[0];if(!page)throw Error('No existing page; inspect readiness.');
  page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(10000);
  listener=r=>{let u;try{u=new URL(r.url());if(u.origin!==new URL(page.url()).origin)return;}catch{return;}if(pending.length>=24||/auth|login|token|session/i.test(u.pathname)||!['fetch','xhr'].includes(r.request().resourceType())||!/json/i.test(r.headers()['content-type']||''))return;pending.push((async()=>{
   const item={method:r.request().method(),path:u.pathname,status:r.status(),omitted:'Body pending'};records.push(item);
   try{if(Number(r.headers()['content-length'])>65536){item.omitted='Response too large';return;}const text=await r.text();if(text.length>65536){item.omitted='Response too large';return;}item.body=clean(JSON.parse(text));delete item.omitted;}catch(e){item.omitted='Response body unavailable';}
  })().catch(()=>{}));};page.on('response',listener);
  return await action(page);
 }catch(error){if(page){console.error('Browser action failed:',error.message,'URL:',page.url());try{console.error(await snapshot(page.locator('body')))}catch{}}throw error;
 }finally{
  if(page&&listener)page.off('response',listener);
  await Promise.race([Promise.allSettled(pending),new Promise(r=>{const t=setTimeout(r,2000);t.unref();})]);
  if(records.length){try{
   fs.mkdirSync(evidenceDir,{recursive:true});const file=path.join(evidenceDir,'browser-'+crypto.randomUUID()+'.json');let bytes=0;const kept=records.slice(-12).map(r=>{const n=Buffer.byteLength(JSON.stringify(r));if(bytes+n>48000)return {method:r.method,path:r.path,status:r.status,omitted:'Evidence size limit'};bytes+=n;return r;});fs.writeFileSync(file,JSON.stringify({url:page?.url()?.split('?')[0],responses:kept}),{mode:0o644});
   const seen=new Set();const unique=kept.filter(r=>{const k=JSON.stringify(r);if(seen.has(k))return false;seen.add(k);return true;});const brief=unique.map(r=>({...r,body:preview(r.body?.data??r.body)}));let out=JSON.stringify({responses:brief});if(out.length>6000)out=out.slice(0,6000)+' [Truncated; read evidence file.]';console.log('Browser observations (passive responses; not conclusions): '+out+'\nEvidence: '+file);
  }catch(e){console.error('Browser evidence write failed:',e.message)}}
  if(browser)await browser.close();
 }
}
module.exports={withPage,snapshot};
