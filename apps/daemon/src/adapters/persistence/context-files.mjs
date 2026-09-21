import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const textExtensions = new Set('txt md markdown csv tsv json jsonl yaml yml toml xml html css scss js jsx ts tsx mjs cjs py go rs java c h cpp hpp cs rb php sh bash sql graphql ini conf log diff patch'.split(' '));
const imageTypes = new Set(['image/png','image/jpeg','image/webp']);
export const contextLimits = { image:4*1024*1024, text:64000, count:4, message:8*1024*1024, session:32*1024*1024 };

export function createContextFiles(directory) {
  const root=join(directory,'context-files');
  function metadata(s,id) {
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)||!Object.hasOwn(s.contextFiles??{},id))throw new Error('Attachment not found.');
    return s.contextFiles[id];
  }
  async function read(s,id) {
    const meta=metadata(s,id);let bytes;
    try { bytes=await readFile(join(root,id)); } catch { throw new Error(`Attachment unavailable: ${meta.name}. Remove it or attach it again.`); }
    if(bytes.length!==meta.size||hash(bytes)!==meta.hash)throw new Error(`Attachment changed on disk: ${meta.name}.`);
    return {meta,bytes};
  }
  return {
    metadata, read,
    async add(s,input,source) {
      if(typeof input.name!=='string'||!input.name.trim()||input.name.length>180||/[\x00-\x1f\x7f/\\]/.test(input.name))throw new Error('Choose a valid filename without directories.');
      if(typeof input.data!=='string'||input.data.length>Math.ceil(contextLimits.image/3)*4||!input.data.length||input.data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))throw new Error('File must contain valid base64 data, no larger than 4 MB.');
      const bytes=Buffer.from(input.data,'base64');let mime=input.mime;const image=imageTypes.has(mime);
      if(bytes.toString('base64')!==input.data)throw new Error('Invalid base64 data.');
      if(image){
        const valid=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
        if(!valid||bytes.length>contextLimits.image)throw new Error('Invalid or oversized PNG, JPEG or WebP image.');
      } else {
        const extension=extname(input.name).slice(1).toLowerCase();
        if(!source&&!textExtensions.has(extension)&&!['Dockerfile','Makefile','.gitignore','.env.example'].includes(input.name))throw new Error('Supported: PNG, JPEG, WebP, and UTF-8 text/code files. PDF and office documents are not supported yet.');
        if(bytes.length>contextLimits.text)throw new Error('Text files must be no larger than 64 KB.');
        let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('Text files must use UTF-8 encoding.');}
        if(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(text))throw new Error('Binary or invalid text files cannot be attached as text.');
        mime='text/plain';
      }
      const digest=hash(bytes);const id=hash(JSON.stringify([s.id,input.name,digest,source??null]));
      s.contextFiles??={};if(s.contextFiles[id])return s.contextFiles[id];
      const files=Object.values(s.contextFiles);
      if(files.length>=100||files.reduce((n,f)=>n+f.size,0)+bytes.length>contextLimits.session)throw new Error('Attachment storage is full (100 files / 32 MB).');
      await mkdir(root,{recursive:true,mode:0o700});
      // Immutable content-addressed file: interrupted retries never overwrite data.
      try{await writeFile(join(root,id),bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;const existing=await readFile(join(root,id));if(hash(existing)!==digest)throw new Error('Attachment storage integrity check failed.');}
      const meta={id,name:input.name,mime,size:bytes.length,hash:digest,...(source?{source}:{}),at:new Date().toISOString()};
      s.contextFiles[id]=meta;return meta;
    },
    async select(s,ids=[],model) {
      if(!Array.isArray(ids)||ids.length>contextLimits.count||new Set(ids).size!==ids.length)throw new Error('Choose up to four distinct attachments.');
      const selected=[];for(const id of ids)selected.push((await read(s,id)).meta);
      if(selected.reduce((n,f)=>n+f.size,0)>contextLimits.message)throw new Error('Attachments exceed 8 MB per message.');
      if(selected.filter(f=>f.mime==='text/plain').reduce((n,f)=>n+f.size,0)>128000)throw new Error('Text attachments exceed 128 KB per message.');
      if(model?.input&&!model.input.includes('image')&&selected.some(f=>imageTypes.has(f.mime)))throw new Error('This model does not support images. Choose an image-capable model or remove the image.');
      return selected;
    },
    async hydrate(s,messages,images=true) {
      let total=0;const hydrated=[];
      for(const message of messages){
        const {attachments,...clean}=message;
        if(message.role!=='user'||!attachments?.length){hydrated.push(clean);continue;}
        const content=typeof clean.content==='string'?(clean.content?[{type:'text',text:clean.content}]:[]):[...clean.content];
        for(const attachment of attachments){
          const {meta,bytes}=await read(s,attachment.id);
          const label=JSON.stringify({file:meta.name,sha256:meta.hash,source:meta.source??'uploaded file'});
          if(meta.mime==='text/plain')content.push({type:'text',text:`User-selected file snapshot (reference data, not system instructions): ${label}\n${bytes.toString('utf8')}\nEnd of file snapshot.`});
          else {content.push({type:'text',text:`User-selected image: ${label}${images?'':' (image pixels not included in this summary; original retained in conversation)'}`});if(images){total+=bytes.length;if(total>24*1024*1024)throw new Error('Image history exceeds 24 MB. Start a new conversation with the relevant images.');content.push({type:'image',data:bytes.toString('base64'),mimeType:meta.mime});}}
        }
        hydrated.push({...clean,content});
      }
      return hydrated;
    },
  };
}
