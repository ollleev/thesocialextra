import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, lstatSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

// Eight full daily points (the exact seven-day boundary can retain eight) fit
// within the 4 GiB backup budget with about 1 GiB left for overhead/manual points.
// This bounds logical SQLite pages, not WAL/temp files or the whole host disk.
export const DATABASE_MAX_BYTES=384*1024**2;
export function isDatabaseFull(error) {return error?.code==='ERR_SQLITE_ERROR'&&Number.isInteger(error.errcode)&&(error.errcode&255)===13;}

export function openDatabase(filename,{maxBytes=DATABASE_MAX_BYTES}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<8192)throw new TypeError('Database capacity must be a positive byte budget of at least 8192');
  if (filename !== ':memory:') {
    if (!path.isAbsolute(filename)) throw new Error('Database path must be absolute');
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (existsSync(filename) && (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())) throw new Error('Database must be a regular file');
  }
  const db = new DatabaseSync(filename, { timeout: 5000, defensive: true, allowExtension: false });
  try {
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    const pageSize=db.prepare('PRAGMA page_size').get().page_size,maxPages=Math.floor(maxBytes/pageSize);
    if(maxPages<2)throw new Error('database_capacity_below_minimum_pages');
    const result=db.prepare(`PRAGMA max_page_count=${maxPages}`).get().max_page_count;
    // Existing data is never shrunk or discarded to meet a new lower budget.
    if(result>maxPages)throw new Error('database_exceeds_configured_capacity');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
    return db;
  }catch(error){db.close();throw error;}
}

export async function backupDatabase(db, destination) {
  if (!path.isAbsolute(destination) || existsSync(destination)) throw new Error('Backup requires a new absolute destination');
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  // Reserve the new destination atomically and privately before SQLite writes
  // any plaintext, rather than correcting its mode only after the copy.
  closeSync(openSync(destination, 'wx', 0o600));
  await backup(db, destination);
  chmodSync(destination, 0o600);
  const check = new DatabaseSync(destination, { readOnly: true });
  try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed'); }
  finally { check.close(); }
}
