import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync } from 'node:fs';
import path from 'node:path';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
export const ERASURE_JOURNAL_MAX_BYTES=16*1024**2;
const MAX_RECORDS=100000;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const genesis=(epoch,id)=>digest(['thesocialextra-erasure-v1',epoch,id]);
const fail=()=>{throw new Error('erasure_journal_invalid_or_unavailable');};
function privatePath(filename,{existing=true}={}) {
  if(typeof filename!=='string'||!path.isAbsolute(filename)||/[\0\r\n]/.test(filename))fail();
  const dir=lstatSync(path.dirname(filename));
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077))fail();
  if(existing) {
    const info=lstatSync(filename);
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||(info.mode&0o077)||info.size>ERASURE_JOURNAL_MAX_BYTES)fail();
    return info;
  }
}
function connect(filename,{readOnly=false}={}) {
  privatePath(filename);
  const db=new DatabaseSync(filename,{readOnly,timeout:5000,defensive:true,allowExtension:false});
  try {
    if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete')fail();
    // EXTRA also synchronizes the directory after unlinking the DELETE-mode
    // rollback journal. A successful intent precedes any application erasure.
    if(!readOnly) {
      db.exec('PRAGMA synchronous=EXTRA; PRAGMA secure_delete=ON;');
      if(db.prepare('PRAGMA synchronous').get().synchronous!==3)fail();
      const pages=Math.floor(ERASURE_JOURNAL_MAX_BYTES/db.prepare('PRAGMA page_size').get().page_size);
      if(db.prepare(`PRAGMA max_page_count=${pages}`).get().max_page_count>pages)fail();
    }
    return db;
  } catch(error) {db.close();throw error;}
}
function transaction(db,fn) {
  db.exec('BEGIN IMMEDIATE');
  try {const result=fn();db.exec('COMMIT');return result;}
  catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}

/** Separate from application snapshots. Intents never expire or roll back with
 * the application transaction. One application writer is supported. A SHA chain
 * detects accidental inconsistency, NOT a malicious operator or a stale pair of
 * restored databases. An independently current tip remains required for restore.
 */
export class ErasureJournal {
  #db; #filename; #identity; #readOnly;
  constructor(filename,{readOnly=false}={}) {
    if(typeof readOnly!=='boolean')fail();
    this.#readOnly=readOnly;this.#filename=filename;this.#db=connect(filename,{readOnly});this.#identity=privatePath(filename);
    try {this.verify();}catch(error){this.#db.close();throw error;}
  }
  get readOnly(){return this.#readOnly;}
  verify() {
    this.#checkPath();
    const db=this.#db;
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')fail();
    const metadata=db.prepare('SELECT id,epoch,journal_id FROM erasure_meta').all();
    if(metadata.length!==1||metadata[0].id!==1||!UUID.test(metadata[0].epoch)||!UUID.test(metadata[0].journal_id))fail();
    this.epoch=metadata[0].epoch;this.id=metadata[0].journal_id;
    let seq=0,hash=genesis(this.epoch,this.id);
    for(const row of db.prepare('SELECT seq,user_id,requested_at,previous_hash,hash FROM erasure_requests ORDER BY seq').iterate()) {
      if(++seq>MAX_RECORDS||row.seq!==seq||!UUID.test(row.user_id)||!Number.isSafeInteger(row.requested_at)||row.requested_at<0||
        row.previous_hash!==hash||!HASH.test(row.hash)||row.hash!==digest([seq,row.user_id,row.requested_at,hash]))fail();
      hash=row.hash;
    }
    return {epoch:this.epoch,journalId:this.id,seq,hash};
  }
  tip() {
    const row=this.#db.prepare('SELECT seq,hash FROM erasure_requests ORDER BY seq DESC LIMIT 1').get();
    return {epoch:this.epoch,journalId:this.id,seq:row?.seq??0,hash:row?.hash??genesis(this.epoch,this.id)};
  }
  #checkPath(){const current=privatePath(this.#filename);if(current.dev!==this.#identity.dev||current.ino!==this.#identity.ino)fail();}
  hashAt(seq) {return seq===0?genesis(this.epoch,this.id):this.#db.prepare('SELECT hash FROM erasure_requests WHERE seq=?').get(seq)?.hash;}
  after(seq) {return this.#db.prepare('SELECT seq,user_id,requested_at,hash FROM erasure_requests WHERE seq>? ORDER BY seq').all(seq);}
  append(userId,now=Date.now()) {
    if(this.#readOnly||!UUID.test(userId)||!Number.isSafeInteger(now)||now<0)fail();
    this.#checkPath();
    return transaction(this.#db,()=>{
      const prior=this.#db.prepare('SELECT seq,user_id,requested_at,hash FROM erasure_requests WHERE user_id=?').get(userId);
      if(prior)return {...prior};
      const tip=this.tip(),seq=tip.seq+1;
      if(seq>MAX_RECORDS)throw new Error('erasure_journal_capacity_reached');
      const hash=digest([seq,userId,now,tip.hash]);
      this.#db.prepare('INSERT INTO erasure_requests(seq,user_id,requested_at,previous_hash,hash) VALUES(?,?,?,?,?)').run(seq,userId,now,tip.hash,hash);
      return {seq,user_id:userId,requested_at:now,hash};
    });
  }
  close(){if(this.#db.isOpen)this.#db.close();}
}

/** Explicit empty-service bootstrap only. Never recreate a missing journal on
 * application startup. A partial bootstrap is retained for operator inspection.
 */
export function initializeErasureJournal({db,filename}) {
  privatePath(filename,{existing:false});
  return transaction(db,()=>{
    const epoch=db.prepare('SELECT epoch FROM app_meta WHERE id=1').get()?.epoch;
    if(!UUID.test(epoch)||db.prepare('SELECT COUNT(*) n FROM auth_users').get().n!==0||
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_erasure_checkpoint'").get())fail();
    const fd=openSync(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);
    let journal;
    try {
      journal=connect(filename);
      journal.exec(`CREATE TABLE erasure_meta(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,journal_id TEXT NOT NULL) STRICT;
        CREATE TABLE erasure_requests(seq INTEGER PRIMARY KEY CHECK(seq>0),user_id TEXT NOT NULL UNIQUE,requested_at INTEGER NOT NULL,
          previous_hash TEXT NOT NULL,hash TEXT NOT NULL) STRICT;`);
      const id=randomUUID(),hash=genesis(epoch,id);
      journal.prepare('INSERT INTO erasure_meta VALUES(1,?,?)').run(epoch,id);
      journal.close();journal=null;
      const directory=openSync(path.dirname(filename),constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
      db.exec(`CREATE TABLE app_erasure_checkpoint(id INTEGER PRIMARY KEY CHECK(id=1),epoch TEXT NOT NULL,journal_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK(seq>=0),hash TEXT NOT NULL) STRICT;`);
      db.prepare('INSERT INTO app_erasure_checkpoint VALUES(1,?,?,0,?)').run(epoch,id,hash);
      return {epoch,journalId:id,seq:0,hash};
    }finally{journal?.close();}
  });
}

function checkpoint(db,journal) {
  const row=db.prepare('SELECT epoch,journal_id,seq,hash FROM app_erasure_checkpoint WHERE id=1').get();
  if(!row||row.epoch!==journal.epoch||row.journal_id!==journal.id||
    db.prepare('SELECT epoch FROM app_meta WHERE id=1').get()?.epoch!==journal.epoch||
    !Number.isSafeInteger(row.seq)||row.seq<0||row.hash!==journal.hashAt(row.seq))fail();
  return row;
}

/** Caller must hold the synchronous app transaction that erases business+auth. */
export function acknowledgeErasure(db,journal,receipt) {
  if(!db.isTransaction||receipt.hash!==journal.hashAt(receipt.seq))fail();
  const before=checkpoint(db,journal);
  if(receipt.seq!==before.seq+1)fail();
  db.prepare('UPDATE app_erasure_checkpoint SET seq=?,hash=? WHERE id=1').run(receipt.seq,receipt.hash);
}

/** Run before listening, or against an isolated restored database only. This
 * proves reconciliation with THIS journal, never that this journal is current.
 */
export function reconcileErasures({db,store,auth,journal}) {
  const tip=journal.verify(),before=checkpoint(db,journal);
  let applied=0;
  for(const receipt of journal.after(before.seq)) {
    store.transaction(()=>{
      store.eraseAccountData(receipt.user_id);
      auth.deleteAccount(receipt.user_id);
      acknowledgeErasure(db,journal,receipt);
    });
    applied++;
  }
  const after=checkpoint(db,journal);
  if(after.seq!==tip.seq||after.hash!==tip.hash)fail();
  return {...tip,applied};
}
