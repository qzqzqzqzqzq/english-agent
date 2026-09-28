import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from './db.js';
import {compact,correctionInstruction,parseReply,needsCompact,providerPost} from './model.js';

const tmp=mkdtempSync(join(tmpdir(),'english-agent-test-'));
const db=new Store(join(tmp,'unit.db'));
after(()=>{db.close();rmSync(tmp,{recursive:true,force:true});});
test('conversations and settings remain isolated and persist after reopen',()=>{
  const a=db.create(),b=db.create();db.update(a.id,{difficulty:'challenge',correction:'strict'});
  db.addMessage(a.id,'user','First');db.addMessage(b.id,'user','Second');
  assert.equal(db.get(b.id)?.correction,'off');assert.equal(db.get(b.id)?.difficulty,'normal');
  assert.deepEqual(db.messages(a.id).map(m=>m.content),['First']);
  const another=new Store(join(tmp,'unit.db'));
  assert.equal(another.get(a.id)?.difficulty,'challenge');assert.equal(another.messages(b.id)[0].content,'Second');another.close();
});
test('aux threads are separate by assistant message and shared for same sentence',()=>{
  const c=db.create();const one=db.addMessage(c.id,'assistant','What would you like?');const two=db.addMessage(c.id,'assistant','What would you like?');
  const t1=db.thread(one.id,one.content,'What would you like?');const t2=db.thread(two.id,two.content,'What would you like?');
  db.addAux(t1.id,'user','Why would?');assert.notEqual(t1.id,t2.id);
  assert.equal(db.thread(one.id,one.content,'What').id,t1.id);
  assert.equal(db.auxMessages(t2.id).length,0);
});
test('correction levels and Chinese-only handling contract',()=>{
  assert.match(correctionInstruction('light'),/obstruct/);
  assert.match(correctionInstruction('strict'),/all clear/);
  const json=JSON.stringify({reply:'Sure!',corrections:[{original:'你好',improved:'Hello',explanation:'自然说法'}]});
  assert.deepEqual(parseReply(json,'off').corrections,[]);
  assert.equal(parseReply(json,'standard').corrections.length,1);
});
test('native compact returns canonical window unchanged for next Responses call',async()=>{
  const original=[{role:'user',content:'old'}],window=[{type:'compaction',encrypted_content:'opaque'},{role:'user',content:'kept'}];
  const seen:{url:string;body:any}[]=[];
  const fake=async(input:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));seen.push({url:String(input),body});return new Response(JSON.stringify(seen.length===1?{output:window}:{output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}),{status:200,headers:{'Content-Type':'application/json'}});};
  const cfg={baseUrl:'https://mock.invalid/v1',apiKey:'fixture-only',model:'mock-model'};
  const result=await compact(cfg,original,fake as typeof fetch);
  assert.deepEqual(result,window);assert.equal(needsCompact(original,1),true);
  await providerPost(cfg,'responses',[...result,{role:'user',content:'new'}],undefined,fake as typeof fetch);
  assert.match(seen[0].url,/\/v1\/responses\/compact$/);
  assert.deepEqual(seen[1].body.input.slice(0,2),window);
});
test('unsupported compact never becomes a text summary and does not expose provider response',async()=>{
  const fake=async()=>new Response('secret-like provider message',{status:404});
  await assert.rejects(()=>compact({baseUrl:'https://mock.invalid',apiKey:'fixture-only',model:'mock'},[{role:'user',content:'x'}],fake as typeof fetch),/原生 Compaction.*端点不可用/);
});
