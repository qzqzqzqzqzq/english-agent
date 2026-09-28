import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'english-agent-http-'));
process.env.DATA_DIR=dir;process.env.NODE_ENV='test';process.env.COMPACT_THRESHOLD_TOKENS='100';
const upstream:{path:string;input:any[];instructions?:string}[]=[];
const native=[{type:'compaction',encrypted_content:'opaque-native-state'},{role:'user',content:'retained'}];
const originalFetch=globalThis.fetch;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const payload=JSON.parse(String(init?.body));const path=new URL(String(input)).pathname;
  upstream.push({path,input:payload.input,instructions:payload.instructions});
  if(path.endsWith('/compact'))return new Response(JSON.stringify({output:native}),{status:200});
  const text=payload.instructions?.includes('conversation partner')
    ?JSON.stringify({reply:'Hello! What would you like to talk about?',corrections:[{original:'I goed',improved:'I went',explanation:'过去式'}]})
    :payload.instructions?.includes('grammar tutor')?'This is a question pattern.':'它表示你想要什么。';
  return new Response(JSON.stringify({output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}],usage:{input_tokens_details:{cached_tokens:2}}}),{status:200});
}) as typeof fetch;
const {createApp,store}=await import('./index.js');
const server=createApp().listen(0,'127.0.0.1');
await new Promise<void>(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${(server.address() as any).port}`;
async function request<T>(path:string,method='GET',body?:unknown):Promise<T>{const r=await originalFetch(base+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw new Error(`${r.status}: ${await r.text()}`);return r.json() as Promise<T>;}
after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();globalThis.fetch=originalFetch;rmSync(dir,{recursive:true,force:true});});
test('end-to-end conversation settings, correction card, selection, grammar isolation, compact continuation',async()=>{
  const cfg={baseUrl:'https://mock.invalid/v1',model:'mock',apiKey:'fixture-only'};
  await request('/api/settings/main','PUT',cfg);await request('/api/settings/aux','PUT',cfg);
  const settings=await request<any>('/api/settings');assert.equal(settings.main.hasKey,true);assert.equal(settings.main.apiKey,undefined);
  const a=await request<any>('/api/conversations','POST',{correction:'off'}),b=await request<any>('/api/conversations','POST',{correction:'strict'});
  const off=await request<any>(`/api/conversations/${a.id}/send`,'POST',{text:'I goed'});assert.deepEqual(off.corrections,[]);
  const on=await request<any>(`/api/conversations/${b.id}/send`,'POST',{text:'I goed'});assert.equal(on.corrections.length,1);
  const msg=on.message;
  const explanation=await request<any>('/api/selection','POST',{messageId:msg.id,selection:'Hello',sentence:msg.content.split('!')[0]+'!',fullSentence:false});assert.match(explanation.explanation,/表示/);
  const question={messageId:msg.id,selection:msg.content,sentence:msg.content,question:'Why this form?'};
  const thread=await request<any>('/api/grammar','POST',question);assert.equal(thread.thread.messages.length,2);
  const repeat=await request<any>('/api/grammar','POST',{...question,question:'More detail?'});assert.equal(repeat.thread.id,thread.thread.id);assert.equal(repeat.thread.messages.length,4);
  const aMsg=off.message;assert.deepEqual(await request(`/api/messages/${aMsg.id}/threads`),[]);
  await request(`/api/conversations/${b.id}`,'PATCH',{difficulty:'challenge',correction:'light'});
  await request(`/api/conversations/${b.id}/send`,'POST',{text:'A'.repeat(600)});
  await request(`/api/conversations/${b.id}/send`,'POST',{text:'Continue'});
  const call=[...upstream].reverse().find(x=>x.path==='/v1/responses'&&x.input.some(i=>i.content==='Continue'))!;
  assert.deepEqual(call.input.slice(0,native.length),native);
  assert.equal(store.messages(b.id).length,6);assert.equal(store.messages(a.id).length,2);
  assert.ok(upstream.some(x=>x.path==='/v1/responses/compact'));
});
