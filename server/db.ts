import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config, Item } from './model.js';

export type Conversation = {id:string; title:string; scenario:string; difficulty:string; correction:string; created_at:string; updated_at:string};
export type Message = {id:string; conversation_id:string; seq:number; role:'user'|'assistant'; content:string; corrections:string|null; cached_tokens:number|null; created_at:string};
export class Store {
  db: DatabaseSync;
  constructor(path = join(resolve(process.env.DATA_DIR || './data'),'english-agent.db')) {
    mkdirSync(resolve(path,'..'),{recursive:true,mode:0o700});
    this.db = new DatabaseSync(path); chmodSync(path,0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY,title TEXT NOT NULL,scenario TEXT NOT NULL DEFAULT '',difficulty TEXT NOT NULL DEFAULT 'normal',correction TEXT NOT NULL DEFAULT 'off',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,corrections TEXT,cached_tokens INTEGER,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(conversation_id,seq));
      CREATE TABLE IF NOT EXISTS contexts (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,items TEXT NOT NULL,through_seq INTEGER NOT NULL,config_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS configs (role TEXT PRIMARY KEY,base_url TEXT NOT NULL DEFAULT '',api_key TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS aux_threads (id TEXT PRIMARY KEY,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,sentence TEXT NOT NULL,selection TEXT NOT NULL,UNIQUE(message_id,sentence));
      CREATE TABLE IF NOT EXISTS aux_messages (id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES aux_threads(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT OR IGNORE INTO configs(role) VALUES ('main'),('aux');`);
  }
  list(): Conversation[] { return this.db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC').all() as Conversation[]; }
  get(id:string): Conversation|undefined { return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as Conversation|undefined; }
  create(v:Partial<Conversation> = {}): Conversation { const id=randomUUID(); this.db.prepare('INSERT INTO conversations(id,title,scenario,difficulty,correction) VALUES(?,?,?,?,?)').run(id,v.title||'新对话',v.scenario||'',v.difficulty||'normal',v.correction||'off'); return this.get(id)!; }
  update(id:string,v:Partial<Conversation>):Conversation|undefined { const current=this.get(id); if(!current)return; this.db.prepare('UPDATE conversations SET title=?,scenario=?,difficulty=?,correction=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(v.title??current.title,v.scenario??current.scenario,v.difficulty??current.difficulty,v.correction??current.correction,id); return this.get(id); }
  remove(id:string):void { this.db.prepare('DELETE FROM conversations WHERE id=?').run(id); }
  messages(id:string):Message[] { return this.db.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY seq').all(id) as Message[]; }
  message(id:string):Message|undefined { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as Message|undefined; }
  addMessage(conversationId:string,role:'user'|'assistant',content:string,corrections:string|null=null,cached:number|null=null):Message {
    const id=randomUUID(); this.db.prepare('INSERT INTO messages(id,conversation_id,seq,role,content,corrections,cached_tokens) VALUES(?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE conversation_id=?),?,?,?,?)').run(id,conversationId,conversationId,role,content,corrections,cached);
    this.db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(conversationId); return this.message(id)!;
  }
  config(role:'main'|'aux'):Config & {version:number;hasKey:boolean} { const c=this.db.prepare('SELECT * FROM configs WHERE role=?').get(role) as any; return {baseUrl:c.base_url,apiKey:c.api_key,model:c.model,version:c.version,hasKey:!!c.api_key}; }
  saveConfig(role:'main'|'aux',v:{baseUrl:string;model:string;apiKey?:string;clearKey?:boolean}):void {
    const key=v.clearKey?'':(v.apiKey||this.config(role).apiKey);
    this.db.prepare('UPDATE configs SET base_url=?,model=?,api_key=?,version=version+1 WHERE role=?').run(v.baseUrl,v.model,key,role);
  }
  context(id:string):{items:Item[];throughSeq:number;version:number}|undefined { const c=this.db.prepare('SELECT * FROM contexts WHERE conversation_id=?').get(id) as any; return c ? {items:JSON.parse(c.items),throughSeq:c.through_seq,version:c.config_version}:undefined; }
  saveContext(id:string,items:Item[],throughSeq:number,version:number):void { this.db.prepare('INSERT INTO contexts VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET items=excluded.items,through_seq=excluded.through_seq,config_version=excluded.config_version').run(id,JSON.stringify(items),throughSeq,version); }
  thread(messageId:string,sentence:string,selection:string):{id:string;message_id:string;sentence:string;selection:string} {
    const id=randomUUID(); this.db.prepare('INSERT OR IGNORE INTO aux_threads(id,message_id,sentence,selection) VALUES(?,?,?,?)').run(id,messageId,sentence,selection);
    return this.db.prepare('SELECT * FROM aux_threads WHERE message_id=? AND sentence=?').get(messageId,sentence) as any;
  }
  threads(messageId:string):any[] { return this.db.prepare('SELECT * FROM aux_threads WHERE message_id=?').all(messageId); }
  auxMessages(threadId:string):any[] {return this.db.prepare('SELECT * FROM aux_messages WHERE thread_id=? ORDER BY rowid').all(threadId);}
  addAux(threadId:string,role:string,content:string):void {this.db.prepare('INSERT INTO aux_messages(id,thread_id,role,content) VALUES(?,?,?,?)').run(randomUUID(),threadId,role,content);}
  close():void {this.db.close();}
}
