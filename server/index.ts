import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { extname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.js';
import { providerPost, compact, mainInstructions, parseReply, outputText, cachedTokens, messagesToItems, nextInput, needsCompact, ProviderError, apiUrl, type Item } from './model.js';

export const store = new Store();
const ROOT = resolve(fileURLToPath(new URL('..',import.meta.url)));
const DIST = join(ROOT,'dist');
const threshold = Math.max(100,Number(process.env.COMPACT_THRESHOLD_TOKENS)||12000);
const busy = new Set<string>();
const choices = {difficulty:['easy','normal','challenge'],correction:['off','light','standard','strict']};
const send = (res:ServerResponse,status:number,data:unknown) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
function assert(condition:unknown,message:string):asserts condition {if(!condition)throw new ProviderError(message,'validation');}
async function body(req:IncomingMessage):Promise<any> {let text=''; for await(const chunk of req){text+=chunk;assert(text.length<1000000,'请求内容过长。');} try {return JSON.parse(text||'{}');}catch{throw new ProviderError('JSON 请求格式不正确。','validation');}}
const publicConfig = (role:'main'|'aux') => {const {apiKey,...rest}=store.config(role);return rest;};
const validString = (x:unknown,max=2000):x is string => typeof x==='string' && x.length<=max;
function validateSelection(messageId:string, selection:string, sentence:string) {
  const m=store.message(messageId);
  assert(m?.role==='assistant','只能选择 AI 回复内容。');
  assert(validString(selection,500)&&!!selection.trim()&&validString(sentence,2000),'划词内容无效。');
  assert(m.content.includes(sentence)&&sentence.includes(selection),'所选内容不属于这条 AI 回复。');
  return m;
}
function nearby(conversationId:string,seq:number) {return store.messages(conversationId).filter(m=>m.seq>=seq-2&&m.seq<=seq).map(m=>({role:m.role,content:m.content.slice(0,1200)}));}
async function mainTurn(id:string,text?:string) {
  assert(!busy.has(id),'该对话正在生成回复，请稍后。'); busy.add(id);
  try {
    const c=store.get(id);assert(c,'对话不存在。');
    if(text!==undefined)assert(validString(text,20000)&&!!text.trim(),'请输入消息（最多 20000 字）。');
    const cfg=store.config('main');
    // Save the learner's input even if the provider fails; a retry can resume from it.
    if(text!==undefined)store.addMessage(id,'user',text.trim());
    else assert(store.messages(id).at(-1)?.role==='user','没有待重试的用户消息。');
    let state=store.context(id);
    if(!state || state.version!==cfg.version) {
      const history=store.messages(id);
      const lastAssistant=[...history].reverse().find(m=>m.role==='assistant');
      const throughSeq=lastAssistant?.seq||0;
      state={items:messagesToItems(history.filter(m=>m.seq<=throughSeq)),throughSeq,version:cfg.version};
    }
    let base=state.items;
    if(needsCompact(base,threshold)) {
      base=await compact(cfg,base);
      store.saveContext(id,base,state.throughSeq,cfg.version);
    }
    const pending=store.messages(id).filter(m=>m.seq>state!.throughSeq).map(m=>({role:m.role,content:m.content}));
    assert(pending.length>0,'没有待重试的消息。');
    const input=nextInput(base,pending);
    const response=await providerPost(cfg,'responses',input,mainInstructions(c.scenario,c.difficulty,c.correction));
    const parsed=parseReply(outputText(response),c.correction);
    assert(Array.isArray(response.output),'Responses 端点未返回有效 output。');
    const userSeq=store.messages(id).at(-1)!.seq;
    const saved=store.addMessage(id,'assistant',parsed.reply,JSON.stringify(parsed.corrections),cachedTokens(response));
    store.saveContext(id,[...input,...response.output],saved.seq,cfg.version);
    return {message:saved,corrections:parsed.corrections,priorUserSeq:userSeq};
  } finally {busy.delete(id);}
}
async function route(req:IncomingMessage,res:ServerResponse,url:URL) {
  const method=req.method||'GET', path=url.pathname;
  if(method!=='GET') {const origin=req.headers.origin;assert(!origin || new URL(origin).host===req.headers.host,'跨来源请求已拒绝。');}
  if(path==='/api/conversations'&&method==='GET')return send(res,200,store.list());
  if(path==='/api/conversations'&&method==='POST') {
    const b=await body(req);assert(!b.title||validString(b.title,100),'标题过长。');assert(!b.scenario||validString(b.scenario,500),'情景过长。');
    assert(!b.difficulty||choices.difficulty.includes(b.difficulty),'无效难度。');assert(!b.correction||choices.correction.includes(b.correction),'无效纠错挡位。');
    return send(res,201,store.create(b));
  }
  const c=path.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|send|retry))?$/);
  if(c) {
    const id=c[1], sub=c[2];assert(store.get(id),'对话不存在。');
    if(!sub&&method==='GET')return send(res,200,store.get(id));
    if(!sub&&method==='PATCH') {const b=await body(req);for(const key of ['title','scenario'] as const)if(b[key]!==undefined)assert(validString(b[key],key==='title'?100:500),`${key} 无效。`);for(const key of ['difficulty','correction'] as const)if(b[key]!==undefined)assert(choices[key].includes(b[key]),`${key} 无效。`);return send(res,200,store.update(id,b));}
    if(!sub&&method==='DELETE'){store.remove(id);return send(res,200,{ok:true});}
    if(sub==='messages'&&method==='GET')return send(res,200,store.messages(id));
    if(sub==='send'&&method==='POST')return send(res,200,await mainTurn(id,(await body(req)).text));
    if(sub==='retry'&&method==='POST')return send(res,200,await mainTurn(id));
  }
  if(path==='/api/settings'&&method==='GET')return send(res,200,{main:publicConfig('main'),aux:publicConfig('aux')});
  const config=path.match(/^\/api\/settings\/(main|aux)(?:\/(test))?$/);
  if(config){const role=config[1] as 'main'|'aux';if(method==='PUT'&&!config[2]) {
      const b=await body(req);assert(validString(b.baseUrl,500)&&validString(b.model,200),'配置字段无效。');assert(b.apiKey===undefined||validString(b.apiKey,1000),'API Key 无效。');
      if(b.baseUrl) {try{apiUrl(b.baseUrl,'responses');}catch{throw new ProviderError('Base URL 无效；远程地址须为 HTTPS，且不能包含认证信息。','validation');}}store.saveConfig(role,b);return send(res,200,publicConfig(role));
    }
    if(method==='POST'&&config[2]==='test') {
      const cfg=store.config(role), input:Item[]=[{role:'user',content:'Reply with the word hello.'}];
      const r=await providerPost(cfg,'responses',input,'Reply briefly.');
      assert(!!outputText(r),'Responses 测试没有返回文本。');
      if(role==='main') {await compact(cfg,[...input,...(Array.isArray(r.output)?r.output:[])]);return send(res,200,{responses:'可用',compact:'可用'});}
      return send(res,200,{responses:'可用'});
    }
  }
  if(path==='/api/selection'&&method==='POST') {
    const b=await body(req),m=validateSelection(b.messageId,b.selection,b.sentence),cfg=store.config('aux');
    const selected=b.selection.trim(),sentence=b.sentence.trim();
    const r=await providerPost(cfg,'responses',[{role:'user',content:JSON.stringify({selected,sentence,nearby:nearby(m.conversation_id,m.seq)})}],`Explain the selected English ${b.fullSentence?'sentence':'word or phrase'} in concise readable Chinese. ${b.fullSentence?'Translate the full sentence.':'Give its meaning in this sentence.'} Do not discuss unrelated context.`);
    return send(res,200,{explanation:outputText(r),fullSentence:!!b.fullSentence});
  }
  const threads=path.match(/^\/api\/messages\/([^/]+)\/threads$/);
  if(threads&&method==='GET') {const m=store.message(threads[1]);assert(m?.role==='assistant','消息不存在。');return send(res,200,store.threads(m.id).map(t=>({...t,messages:store.auxMessages(t.id)})));}
  if(path==='/api/grammar'&&method==='POST') {
    const b=await body(req),m=validateSelection(b.messageId,b.selection,b.sentence);
    assert(validString(b.question,2000)&&!!b.question.trim(),'请输入语法问题。');
    const existing=store.threads(m.id).find(t=>t.sentence===b.sentence);
    const history=existing?store.auxMessages(existing.id):[];
    const c=store.get(m.conversation_id)!;
    const input:Item[]=[{role:'user',content:JSON.stringify({selection:b.selection,sentence:b.sentence,nearby:nearby(m.conversation_id,m.seq)})},...history.map(x=>({role:x.role,content:x.content})),{role:'user',content:b.question.trim()}];
    const r=await providerPost(store.config('aux'),'responses',input,`You are a patient grammar tutor. Answer in readable Chinese with English examples. Difficulty: ${c.difficulty}. Discuss the selected sentence, not the full conversation.`);
    const answer=outputText(r);assert(!!answer,'辅助模型未返回文本。');
    const thread=store.thread(m.id,b.sentence,b.selection);store.addAux(thread.id,'user',b.question.trim());store.addAux(thread.id,'assistant',answer);
    return send(res,200,{thread:{...thread,messages:store.auxMessages(thread.id)}});
  }
  return send(res,404,{error:'页面或 API 不存在。',code:'not_found'});
}
function accessPassword():string|undefined {
  const file=process.env.ACCESS_PASSWORD_FILE;
  if(!file)return undefined;
  const password=readFileSync(file,'utf8').trim();
  if(password.length<16)throw new Error('Access password must contain at least 16 characters.');
  return password;
}
export function isAuthorized(header:string|undefined,password:string|undefined):boolean {
  if(!password)return true;
  if(!header?.startsWith('Basic '))return false;
  const raw=Buffer.from(header.slice(6),'base64').toString('utf8');
  const separator=raw.indexOf(':');
  if(separator<0||raw.slice(0,separator)!=='english')return false;
  const digest=(value:string)=>createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(raw.slice(separator+1)),digest(password));
}
export function createApp() {const password=accessPassword();return createServer(async(req,res)=>{
  try {
    if(!isAuthorized(req.headers.authorization,password)) {res.writeHead(401,{'WWW-Authenticate':'Basic realm="English Agent", charset="UTF-8"','Cache-Control':'no-store'});res.end('Authentication required');return;}
    const url=new URL(req.url||'/',`http://${req.headers.host||'127.0.0.1'}`);
    if(url.pathname.startsWith('/api/'))return await route(req,res,url);
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const file=resolve(DIST,name);
    if(!file.startsWith(DIST+'/') && file!==join(DIST,'index.html'))return send(res,404,{error:'Not found'});
    const target=existsSync(file)?file:join(DIST,'index.html');
    if(!existsSync(target))return send(res,404,{error:'前端尚未构建。开发时请运行 npm run dev。'});
    const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':`${mime[extname(target)]||'application/octet-stream'}; charset=utf-8`,'X-Content-Type-Options':'nosniff'});res.end(readFileSync(target));
  } catch(e){const x=e instanceof ProviderError?e:new ProviderError('请求处理失败。','internal');send(res,x.code==='validation'?400:x.code==='internal'?500:502,{error:x.message,code:x.code});}
});}
if(process.env.NODE_ENV!=='test')createApp().listen(Number(process.env.PORT)||3001,'127.0.0.1',()=>console.log(`English Agent backend: http://127.0.0.1:${Number(process.env.PORT)||3001}`));
