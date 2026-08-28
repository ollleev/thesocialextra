import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, lstatSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

export function openDatabase(filename) {
  if (filename !== ':memory:') {
    if (!path.isAbsolute(filename)) throw new Error('Database path must be absolute');
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    if (existsSync(filename) && (!lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink())) throw new Error('Database must be a regular file');
  }
  const db = new DatabaseSync(filename, { timeout: 5000, defensive: true, allowExtension: false });
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
  return db;
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
