import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm, rmdir, statfs, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup } from '../backup.mjs';
import { ErasureJournal, ERASURE_JOURNAL_MAX_BYTES } from '../erasure-journal.mjs';
import { backupKey, decryptBackup, encryptBackup } from './backup-crypto.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const ID = new RegExp(`^${UUID}$`), HASH = /^[a-f0-9]{64}$/;
const NAME = new RegExp(`^snapshot-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)-${UUID}\\.tseb$`);
const MAX_ARCHIVE = ERASURE_JOURNAL_MAX_BYTES + 36, MAX_STATUS = 4096;
export const ERASURE_BACKUP_LIMITS = Object.freeze({ maxStoredBytes: 128 * 1024 ** 2, minFreeBytes: 1024 ** 3 });
export const ERASURE_BACKUP_STATUS = 'status.json';
const LOCK = '.erasure-backup.lock';
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const sameTip = (a, b) => a.epoch === b.epoch && a.journalId === b.journalId && a.seq === b.seq && a.hash === b.hash;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999;
function absolute(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 4096 || /[\x00-\x1f\x7f]/.test(filename) ||
    filename.split(path.sep).includes('..')) throw fail('erasure_backup_path_invalid');
  const resolved = path.resolve(filename);
  if (resolved === ROOT || resolved.startsWith(ROOT + path.sep)) throw fail('erasure_backup_path_invalid');
  return resolved;
}
async function privateDirectory(directory, requireOwner = true) {
  if (await realpath(directory) !== directory) throw fail('erasure_backup_permissions');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (requireOwner && info.uid !== process.getuid())) throw fail('erasure_backup_permissions');
  return info;
}
function privateFile(info, maxBytes = MAX_ARCHIVE, requireOwner = true) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
    (requireOwner && info.uid !== process.getuid()) || info.size > maxBytes) throw fail('erasure_backup_permissions');
  return info;
}
async function checkedFile(filename, maxBytes, requireOwner = true) {
  await privateDirectory(path.dirname(filename), requireOwner);
  return privateFile(await lstat(filename), maxBytes, requireOwner);
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function snapshotTime(filename) {
  const match = typeof filename === 'string' && NAME.exec(filename);
  if (!match) return NaN;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'), value = Date.parse(iso);
  return validTime(value) && new Date(value).toISOString().replace('.000Z', 'Z') === iso ? value : NaN;
}
function validateTip(tip) {
  if (!exact(tip, 'epoch,hash,journalId,seq') || !ID.test(tip.epoch) || !ID.test(tip.journalId) || !HASH.test(tip.hash) ||
    !Number.isSafeInteger(tip.seq) || tip.seq < 0 || tip.seq > 100000) throw fail('erasure_backup_status_invalid');
}
function validatePoint(point) {
  if (!exact(point, 'filename,sha256,tip') || !Number.isFinite(snapshotTime(point.filename)) || !HASH.test(point.sha256)) throw fail('erasure_backup_status_invalid');
  validateTip(point.tip);
}
function validateStatus(status) {
  if (!exact(status, 'filename,lastSuccessAt,previous,sha256,tip,version') || status.version !== 1 || !validTime(status.lastSuccessAt)) throw fail('erasure_backup_status_invalid');
  validatePoint({ filename: status.filename, tip: status.tip, sha256: status.sha256 });
  if (snapshotTime(status.filename) > status.lastSuccessAt) throw fail('erasure_backup_status_invalid');
  if (status.previous !== null) {
    validatePoint(status.previous);
    if (status.previous.filename === status.filename || status.previous.tip.epoch !== status.tip.epoch ||
      status.previous.tip.journalId !== status.tip.journalId || status.previous.tip.seq > status.tip.seq ||
      (status.previous.tip.seq === status.tip.seq && status.previous.tip.hash !== status.tip.hash) ||
      snapshotTime(status.previous.filename) >= snapshotTime(status.filename)) throw fail('erasure_backup_status_invalid');
  }
  return status;
}
async function readStatus(filename) {
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw fail('erasure_backup_status_invalid'); }
  try {
    const info = privateFile(await handle.stat(), MAX_STATUS), bytes = Buffer.alloc(MAX_STATUS + 1);
    let offset = 0;
    while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    if (offset > MAX_STATUS) throw fail('erasure_backup_status_invalid');
    let status;
    try {
      const text = bytes.subarray(0, offset).toString('utf8').trim(); status = JSON.parse(text);
      // Accept only our compact representation: duplicate keys are not accepted.
      if (JSON.stringify(status) !== text) throw Error();
    } catch { throw fail('erasure_backup_status_invalid'); }
    return { status: validateStatus(status), info };
  } finally { await handle.close(); }
}
async function writeStatus(filename, status, previous, checkDirectory) {
  validateStatus(status); await checkDirectory();
  const temporary = path.join(path.dirname(filename), `.status-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(status) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await checkDirectory();
    if (previous) {
      const current = privateFile(await lstat(filename), MAX_STATUS);
      if (!sameFile(current, previous.info)) throw fail('erasure_backup_status_changed');
      await rename(temporary, filename);
    } else { await link(temporary, filename); await unlink(temporary); }
    await syncDirectory(path.dirname(filename));
    const saved = await readStatus(filename);
    if (JSON.stringify(saved.status) !== JSON.stringify(status)) throw fail('erasure_backup_status_changed');
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function digest(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = privateFile(await handle.stat()), hash = createHash('sha256'), bytes = Buffer.alloc(65536);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length);
      if (!bytesRead) break;
      total += bytesRead; if (total > MAX_ARCHIVE) throw fail('erasure_backup_archive_invalid');
      hash.update(bytes.subarray(0, bytesRead));
    }
    if (total !== before.size || !sameFile(before, await handle.stat())) throw fail('erasure_backup_archive_invalid');
    return { sha256: hash.digest('hex'), info: before };
  } finally { await handle.close(); }
}
async function verifyArchive(directory, point, work, key) {
  const filename = path.join(directory, point.filename), before = await digest(filename);
  if (before.sha256 !== point.sha256 || before.info.size < 36) throw fail('erasure_backup_archive_invalid');
  const restored = path.join(work, `verify-${randomUUID()}.sqlite`);
  try {
    await decryptBackup(filename, restored, key);
    const journal = new ErasureJournal(restored, { readOnly: true });
    try { if (!sameTip(journal.verify(), point.tip)) throw fail('erasure_backup_archive_invalid'); }
    finally { journal.close(); }
    if (!sameFile(before.info, await lstat(filename))) throw fail('erasure_backup_archive_invalid');
    return before.info;
  } finally { await unlink(restored).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
async function inventory(directory) {
  let bytes = 0, archives = 0, count = 0;
  for await (const item of await opendir(directory)) {
    if (++count > 4096) throw fail('erasure_backup_capacity');
    const name = item.name;
    if (name === LOCK || name === ERASURE_BACKUP_STATUS) continue;
    if (Number.isFinite(snapshotTime(name))) archives++;
    const entry = await lstat(path.join(directory, name));
    // Unknown files and symlinks are never deleted. An abandoned staging
    // directory requires inspection, not an automatic recursive purge.
    if (entry.isDirectory()) throw fail('erasure_backup_directory_entries');
    if (entry.isFile()) bytes += entry.size;
  }
  if (!Number.isSafeInteger(bytes)) throw fail('erasure_backup_capacity');
  return { bytes, archives };
}

/** Local, cumulative journal attestation only; not proof of off-host freshness.
 * Only named, verified points from the preceding status may be rotated. A crash
 * after publication can leave an orphan and a lock for operator inspection.
 */
export async function runErasureBackup({ database, directory, keyFile, now = Date.now(), testOptions } = {}) {
  let key, work, ownsLock = false, uncertain = false, checkDirectory, lock;
  try {
    database = absolute(database); directory = absolute(directory); keyFile = absolute(keyFile);
    if (!validTime(now) || database === keyFile || [database, keyFile].some(file => file === directory || file.startsWith(directory + path.sep))) throw fail('erasure_backup_path_invalid');
    const options = { ...ERASURE_BACKUP_LIMITS };
    if (testOptions !== undefined) {
      if (!process.env.NODE_TEST_CONTEXT || !testOptions || typeof testOptions !== 'object' ||
        Object.keys(testOptions).some(name => !['maxStoredBytes', 'minFreeBytes', 'freeBytes', 'hook'].includes(name))) throw fail('erasure_backup_options_invalid');
      Object.assign(options, testOptions);
    }
    if (!Number.isSafeInteger(options.maxStoredBytes) || options.maxStoredBytes < 1 || options.maxStoredBytes > ERASURE_BACKUP_LIMITS.maxStoredBytes ||
      !Number.isSafeInteger(options.minFreeBytes) || options.minFreeBytes < 0 || options.minFreeBytes > ERASURE_BACKUP_LIMITS.minFreeBytes ||
      (options.freeBytes !== undefined && typeof options.freeBytes !== 'function') || (options.hook !== undefined && typeof options.hook !== 'function')) throw fail('erasure_backup_options_invalid');
    // The read-only source may belong to the application account while this
    // job runs as a separate backup operator. Key/output ownership stays strict.
    await checkedFile(database, ERASURE_JOURNAL_MAX_BYTES, false);
    const keyInfo = await checkedFile(keyFile, 32); if (keyInfo.size !== 32) throw fail('erasure_backup_key_invalid');
    // The directory must be provisioned explicitly; never change permissions or
    // silently create a new location when an operator path is misspelled.
    const identity = await privateDirectory(directory);
    checkDirectory = async () => {
      const current = await privateDirectory(directory);
      if (identity.dev !== current.dev || identity.ino !== current.ino) throw fail('erasure_backup_directory_changed');
    };
    lock = path.join(directory, LOCK);
    try { await mkdir(lock, { mode: 0o700 }); ownsLock = true; await syncDirectory(directory); }
    catch { throw fail('erasure_backup_locked'); }
    const statusFile = path.join(directory, ERASURE_BACKUP_STATUS), stored = await readStatus(statusFile), files = await inventory(directory);
    if (!stored && files.archives) throw fail('erasure_backup_status_missing');
    if (stored && now < stored.status.lastSuccessAt) throw fail('erasure_backup_clock_invalid');
    if (stored && Math.floor(now / 1000) * 1000 <= snapshotTime(stored.status.filename)) throw fail('erasure_backup_clock_not_advanced');
    key = await backupKey(keyFile); // Existing key only. Never generate/rotate it.
    if (!sameFile(keyInfo, await lstat(keyFile))) throw fail('erasure_backup_key_invalid');
    work = await mkdtemp(path.join(directory, '.working-'));
    const snapshot = path.join(work, 'journal.sqlite');
    const space = async required => {
      const fs = options.freeBytes ? null : await statfs(directory);
      const available = options.freeBytes ? await options.freeBytes() : fs.bavail * fs.bsize;
      if (!Number.isFinite(available) || available < options.minFreeBytes + required) throw fail('erasure_backup_space');
    };
    const { bytes } = await createBackup(database, snapshot, { beforeCopy: async ({ bytes: logical }) => {
      if (logical > ERASURE_JOURNAL_MAX_BYTES) throw fail('erasure_backup_source_size');
      if (files.bytes + logical + 36 > options.maxStoredBytes) throw fail('erasure_backup_capacity');
      // Source, encrypted candidate, restored candidate, and old verification
      // are bounded separately; the reserve is never spent on a new point.
      await space(4 * ERASURE_JOURNAL_MAX_BYTES + 1024 ** 2);
    } });
    const journal = new ErasureJournal(snapshot, { readOnly: true });
    let tip;
    try {
      tip = journal.verify();
      for (const point of stored ? [stored.status, stored.status.previous].filter(Boolean) : []) {
        if (point.tip.epoch !== tip.epoch || point.tip.journalId !== tip.journalId || point.tip.seq > tip.seq ||
          journal.hashAt(point.tip.seq) !== point.tip.hash) throw fail('erasure_backup_journal_regression');
      }
    } finally { journal.close(); }
    let obsoleteInfo;
    if (stored) {
      await verifyArchive(directory, stored.status, work, key);
      if (stored.status.previous) obsoleteInfo = await verifyArchive(directory, stored.status.previous, work, key);
    }
    if (files.bytes + bytes + 36 > options.maxStoredBytes) throw fail('erasure_backup_capacity');
    await space(3 * bytes + 1024 ** 2);
    const encrypted = path.join(work, 'candidate.tseb');
    await options.hook?.('beforeEncryption', { snapshot });
    await encryptBackup(snapshot, encrypted, key);
    await options.hook?.('afterEncryption', { encrypted });
    const sha256 = (await digest(encrypted)).sha256;
    await verifyArchive(work, { filename: 'candidate.tseb', tip, sha256 }, work, key);
    const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
    const filename = `snapshot-${stamp}-${randomUUID()}.tseb`;
    const previous = stored ? { filename: stored.status.filename, tip: stored.status.tip, sha256: stored.status.sha256 } : null;
    const status = { version: 1, filename, tip, sha256, lastSuccessAt: now, previous };
    await checkDirectory(); uncertain = true;
    await link(encrypted, path.join(directory, filename)); // Exclusive immutable point.
    await unlink(encrypted); await syncDirectory(directory);
    await options.hook?.('beforeStatus', { status });
    await writeStatus(statusFile, status, stored, checkDirectory);
    uncertain = false;
    await options.hook?.('afterStatus', { status });
    let removed = 0;
    if (stored?.status.previous) {
      const obsolete = path.join(directory, stored.status.previous.filename);
      await checkDirectory();
      // Recheck after all awaits. Never delete an unknown/replaced entry.
      if (!sameFile(obsoleteInfo, privateFile(await lstat(obsolete)))) throw fail('erasure_backup_archive_invalid');
      await unlink(obsolete); await syncDirectory(directory); removed++;
    }
    return { ...status, removed };
  } catch (error) {
    // No path, secret, SQLite contents or arbitrary library diagnostics in CLI.
    throw fail(typeof error?.code === 'string' && /^erasure_backup_[a-z_]+$/.test(error.code) ? error.code : 'erasure_backup_failed');
  } finally {
    key?.fill(0);
    try { if (work) await rm(work, { recursive: true, force: true }); }
    catch { uncertain = true; throw fail('erasure_backup_cleanup_failed'); }
    finally {
      if (ownsLock && !uncertain) {
        try { await checkDirectory(); await rmdir(lock); await syncDirectory(directory); }
        catch { throw fail('erasure_backup_cleanup_failed'); }
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [database, directory, keyFile] = process.argv.slice(2);
  try {
    if (process.argv.length !== 5) throw fail('erasure_backup_usage');
    console.log(JSON.stringify({ ok: true, ...await runErasureBackup({ database, directory, keyFile }) }));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.code })); process.exitCode = 1; }
}
