import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBackup} from '../backup.mjs';
import {openDatabase} from '../database.mjs';
import {AuthService} from '../auth.mjs';
import {ProductionStore} from '../production-store.mjs';
import {ErasureJournal,initializeErasureJournal,reconcileErasures} from '../erasure-journal.mjs';

/** Only creates a NEW isolated output. Never promotes a restore or rewrites the
 * input. The operator must obtain expectedTip independently of the old snapshot.
 * Matching a supplied stale tip cannot establish that no newer erasure exists.
 */
export async function prepareErasureReconciledCopy({source,journalFile,destination,expectedTip}) {
  if(!expectedTip||Object.keys(expectedTip).sort().join(',')!=='epoch,hash,journalId,seq'||
    typeof expectedTip.epoch!=='string'||typeof expectedTip.journalId!=='string'||
    !Number.isSafeInteger(expectedTip.seq)||expectedTip.seq<0||!/^[a-f0-9]{64}$/.test(expectedTip.hash??''))throw Error('independent_expected_tip_required');
  for(const file of [source,journalFile,destination])if(typeof file!=='string'||!path.isAbsolute(file))throw Error('absolute_paths_required');
  if(new Set([source,journalFile,destination]).size!==3)throw Error('distinct_paths_required');
  const info=await lstat(source);
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))throw Error('private_source_required');
  // A wrong/uncertain tip is rejected BEFORE creating even an isolated output.
  const journal=new ErasureJournal(journalFile,{readOnly:true});let db;
  try {
    const tip=journal.verify();
    if(Object.keys(tip).some(key=>tip[key]!==expectedTip[key]))throw Error('erasure_tip_mismatch');
    await createBackup(source,destination);
    db=openDatabase(destination);
    const auth=new AuthService({db}),store=new ProductionStore({db});
    const result=reconcileErasures({db,auth,store,journal});
    if(result.seq!==tip.seq||result.hash!==tip.hash)throw Error('erasure_journal_changed_during_restore');
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('restored_integrity_failed');
    return {...result,restoredIntegrity:'ok',publicationAuthorized:false};
  }finally{db?.close();journal.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [action,...args]=process.argv.slice(2);
  // Paths/tips stay in operator configuration or terminal input, never a repo.
  // Errors omit filesystem paths and data; partial private outputs are retained
  // for inspection, never advertised as usable after a nonzero exit.
  try {
    let result;
    if(action==='init'&&args.length===2) {
      const [database,filename]=args,info=await lstat(database);
      if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))throw Error('private_existing_database_required');
      const db=openDatabase(database);
      try{result=initializeErasureJournal({db,filename});}finally{db.close();}
    }else if(action==='inspect'&&args.length===1) {
      const journal=new ErasureJournal(args[0],{readOnly:true});try{result=journal.verify();}finally{journal.close();}
    }else if(action==='prepare'&&args.length===4) {
      const [source,journalFile,destination,tip]=args;
      result=await prepareErasureReconciledCopy({source,journalFile,destination,expectedTip:JSON.parse(tip)});
    }else throw Error('usage');
    console.log(JSON.stringify(result));
  }catch {console.error('Erasure operation refused; no publication authorized. Inspect private inputs and any partial output.');process.exitCode=1;}
}
