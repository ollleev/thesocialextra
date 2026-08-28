import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from './database.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, stat } from 'node:fs/promises';

export async function createBackup(source,destination,{beforeCopy}={}) {
  if(!path.isAbsolute(source)||!path.isAbsolute(destination)||source===destination)throw new Error('Distinct absolute paths required');
  const sourceStat=await lstat(source);
  if(!sourceStat.isFile()||sourceStat.isSymbolicLink())throw new Error('Source must be a regular database');
  const db=new DatabaseSync(source,{readOnly:true,allowExtension:false,defensive:true,timeout:5000});
  try {
    // Pin one read snapshot before estimating size. The main file alone can be
    // tiny while committed pages live in the WAL; later writers must not grow
    // the recovery point after its capacity check.
    db.exec('BEGIN');
    const pages=db.prepare('PRAGMA page_count').get().page_count;
    const pageSize=db.prepare('PRAGMA page_size').get().page_size;
    const bytes=Math.max(1,pages)*pageSize;
    if(!Number.isSafeInteger(bytes)||bytes<=0)throw new Error('Invalid logical database size');
    await beforeCopy?.({bytes});
    await backupDatabase(db,destination);
    if((await stat(destination)).size>bytes)throw new Error('Backup grew beyond its pinned capacity estimate');
  }
  finally{db.close();}
  return {bytes:(await stat(destination)).size};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==4)throw new Error('Usage: node backup.mjs ABSOLUTE_DATABASE ABSOLUTE_NEW_BACKUP');
  console.log(JSON.stringify(await createBackup(process.argv[2],process.argv[3])));
}
