import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../../apps/web/src/features/chat/message-format.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {messageBlocks,safeMessageLink}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
test('chat presentation separates prose, headings, lists and code without interpreting code contents',()=>{
  const blocks=messageBlocks('## Result\n\nA **small** change.\n\n- One\n- Two\n\n1. Check\n2. Review\n\n```ts\nconst html = "<script>";\n# not a heading\n```');
  assert.deepEqual(blocks.map(b=>b.kind),['heading','paragraph','list','list','code']);
  assert.equal(blocks[2].ordered,false);assert.equal(blocks[3].ordered,true);
  assert.equal(blocks[4].language,'ts');assert.equal(blocks[4].text,'const html = "<script>";\n# not a heading');
});
test('partial fences retain all streamed code; blank and CRLF messages are handled',()=>{
  assert.deepEqual(messageBlocks(''),[]);
  assert.deepEqual(messageBlocks('```js\r\nconst x ='),[{kind:'code',language:'js',text:'const x ='}]);
  assert.equal(messageBlocks('first\r\nsecond')[0].text,'first\nsecond');
});
test('model-provided links cannot execute scripts or navigate to local files',()=>{
  for(const link of ['javascript:alert(1)','data:text/html,bad','file:///etc/passwd','//example.com','/api/runtime'])assert.equal(safeMessageLink(link),null);
  assert.equal(safeMessageLink('https://example.com/docs'),'https://example.com/docs');
});
