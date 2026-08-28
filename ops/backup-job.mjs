import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readdir, rm, rmdir, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup } from '../backup.mjs';
import { backupKey, encryptBackup, decryptBackup } from './backup-crypto.mjs';

const DAY = 86400000;
const SNAPSHOT = /^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-[a-f0-9-]{36}\.tseb$/;
function timestamp(name) {
  const match = SNAPSHOT.exec(name);
  if (!match) return NaN;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
  const value = Date.parse(iso);
  return Number.isFinite(value) && new Date(value).toISOString().replace('.000Z', 'Z') === iso ? value : NaN;
}
async function directorySync(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function waitForLiveWal(database, { timeoutMs = 15000 } = {}) {
  if (!path.isAbsolute(database) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw new Error('Invalid live database readiness check');
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const entries = await Promise.all([lstat(`${database}-wal`), lstat(`${database}-shm`)]);
      if (entries.every(entry => entry.isFile() && !entry.isSymbolicLink())) return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() >= deadline) throw new Error('Live database is not ready for a read-only WAL backup');
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
}

// The caller owns this dedicated directory. Unrecognized names, symlinks and
// recovery points inside the retention window are never pruned to make space.
export async function runBackup({ database, directory, keyFile, now = Date.now(), retentionDays = 7,
  maxStoredBytes = 4 * 1024 ** 3, minFreeBytes = 1024 ** 3 }) {
  if (![database, directory, keyFile].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Absolute backup paths required');
  if (!Number.isSafeInteger(now) || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 30 ||
    !Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 1 || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) throw new Error('Invalid backup policy');
  const key = await backupKey(keyFile); // Never silently generate or rotate an operational key.
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error('Backup directory must be private and not a symlink');
  const lock = path.join(directory, '.backup.lock');
  await mkdir(lock, { mode: 0o700 }); // Exclusive; an abandoned lock requires operator inspection.
  let work;
  try {
    const source = await lstat(database);
    if (!source.isFile() || source.isSymbolicLink()) throw new Error('Database must be a regular file');
    const snapshots = [];
    for (const name of await readdir(directory)) {
      const createdAt = timestamp(name);
      if (!Number.isFinite(createdAt)) continue;
      const file = path.join(directory, name), entry = await lstat(file);
      if (entry.isFile() && !entry.isSymbolicLink()) snapshots.push({ file, createdAt, bytes: entry.size });
    }
    const cutoff = now - retentionDays * DAY;
    const retained = snapshots.filter(snapshot => snapshot.createdAt >= cutoff);
    const retainedBytes = retained.reduce((total, snapshot) => total + snapshot.bytes, 0);
    work = await mkdtemp(path.join(directory, '.working-'));
    const snapshot = path.join(work, 'snapshot.sqlite');
    const { bytes } = await createBackup(database, snapshot, { beforeCopy: async ({ bytes: logicalBytes }) => {
      if (logicalBytes > 2 * 1024 ** 3 - 36) throw new Error('Backup exceeds the configured file size limit');
      if (retainedBytes + logicalBytes + 36 > maxStoredBytes) throw new Error('Backup retention budget exceeded; existing recovery points preserved');
      const capacity = await statfs(directory);
      if (capacity.bavail * capacity.bsize < minFreeBytes + 4 * logicalBytes + 1024 ** 2) throw new Error('Insufficient free space for verified backup');
    } });
    const remaining = await statfs(directory);
    if (remaining.bavail * remaining.bsize < minFreeBytes + 3 * bytes + 1024 ** 2) throw new Error('Insufficient free space for encrypted backup verification');
    const encrypted = path.join(work, 'verified.tseb'), restored = path.join(work, 'restored.sqlite');
    await encryptBackup(snapshot, encrypted, key);
    await decryptBackup(encrypted, restored, key);
    const check = new DatabaseSync(restored, { readOnly: true, allowExtension: false, defensive: true });
    try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Restored backup integrity check failed'); }
    finally { check.close(); }
    const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
    const filename = `snapshot-${stamp}-${randomUUID()}.tseb`;
    await link(encrypted, path.join(directory, filename)); // Exclusive publication, after verification.
    await directorySync(directory);
    let removed = 0;
    for (const old of snapshots.filter(item => item.createdAt < cutoff)) { await unlink(old.file); removed++; }
    await directorySync(directory);
    return { filename, bytes: bytes + 36, restoredIntegrity: 'ok', removed, retentionDays };
  } finally {
    try { if (work) await rm(work, { recursive: true, force: true }); }
    finally { await rmdir(lock); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [database, directory, keyFile] = process.argv.slice(2);
  if (process.argv.length !== 5) throw new Error('Usage: node ops/backup-job.mjs ABSOLUTE_DATABASE ABSOLUTE_DIRECTORY ABSOLUTE_EXISTING_KEY');
  if (process.env.BACKUP_REQUIRE_LIVE_WAL === 'true') await waitForLiveWal(database);
  console.log(JSON.stringify(await runBackup({ database, directory, keyFile })));
}
