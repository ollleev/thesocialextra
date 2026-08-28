import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pullBackup, readPullConfig } from './backup-pull.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOUR = 3600000, FUTURE = 300000, MAX_STATUS = 8192;
const NAME = /^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tseb$/;
const ERRORS = new Set(['invalid_pull_config', 'private_path_inside_source', 'private_file_permissions',
  'local_directory_permissions', 'pull_locked', 'local_entry_limit', 'invalid_source_list', 'no_recent_snapshot',
  'destination_conflict', 'retention_budget', 'insufficient_space', 'source_size_changed', 'invalid_source_bytes',
  'transport_failed', 'verification_failed', 'pull_interrupted', 'pull_timeout', 'backup_pull_failed',
  'pull_failed', 'snapshot_stale', 'clock_invalid', 'invalid_pull_result']);
const fail = code => Object.assign(new Error(code), { code });
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields;
const cleanError = error => ERRORS.has(error?.code) ? error.code : 'pull_failed';
function clock(now) { const value = now(); if (!time(value)) throw fail('clock_invalid'); return value; }
function absolute(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(filename) || filename.split(path.sep).includes('..')) throw fail('invalid_job_path');
  const resolved = path.resolve(filename);
  if (resolved === ROOT || resolved.startsWith(ROOT + path.sep)) throw fail('private_path_inside_source');
  return resolved;
}
function snapshotTime(name) {
  const match = typeof name === 'string' && NAME.exec(name); if (!match) return NaN;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'), value = Date.parse(iso);
  return Number.isFinite(value) && new Date(value).toISOString().replace('.000Z', 'Z') === iso ? value : NaN;
}
function validate(status) {
  if (!exact(status, 'attemptedAt,error,finishedAt,outcome,point,version') || status.version !== 1 || !time(status.attemptedAt) ||
    !['running', 'ok', 'stale', 'error'].includes(status.outcome)) throw fail('status_invalid');
  if (status.outcome === 'running') {
    if (status.finishedAt !== null || status.error !== null) throw fail('status_invalid');
  } else if (!time(status.finishedAt) || status.finishedAt < status.attemptedAt) throw fail('status_invalid');
  if ((status.outcome === 'ok' && status.error !== null) ||
    (status.outcome === 'stale' && status.error !== 'snapshot_stale') ||
    (status.outcome === 'error' && !ERRORS.has(status.error))) throw fail('status_invalid');
  if (status.point !== null) {
    const point = status.point;
    if (!exact(point, 'bytes,filename,snapshotAt,verifiedAt') || !time(point.verifiedAt) ||
      !Number.isFinite(snapshotTime(point.filename)) || point.snapshotAt !== snapshotTime(point.filename) ||
      !Number.isSafeInteger(point.bytes) || point.bytes < 36 || point.bytes > 2 * 1024 ** 3 + 36 ||
      point.verifiedAt > (status.finishedAt ?? status.attemptedAt)) throw fail('status_invalid');
  }
  if (['ok', 'stale'].includes(status.outcome) && (!status.point || status.point.verifiedAt !== status.finishedAt)) throw fail('status_invalid');
  return status;
}
async function location(filename) {
  const file = absolute(filename), directory = path.dirname(file);
  if (await realpath(directory) !== directory) throw fail('status_directory_permissions');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) throw fail('status_directory_permissions');
  return { file, directory, dev: info.dev, ino: info.ino };
}
async function unchangedParent(target) {
  const current = await location(target.file);
  if (current.dev !== target.dev || current.ino !== target.ino) throw fail('status_directory_changed');
}
function privateStatus(info) {
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid() || info.nlink !== 1) throw fail('status_file_permissions');
}
async function readStatus(target) {
  let handle;
  try { handle = await open(target.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw fail('status_unreadable'); }
  try {
    const info = await handle.stat(); privateStatus(info);
    if (info.size > MAX_STATUS) throw fail('status_invalid');
    const bytes = Buffer.alloc(MAX_STATUS + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    if (offset > MAX_STATUS) throw fail('status_invalid');
    let status;
    try {
      const text = bytes.subarray(0, offset).toString('utf8').trim(); status = JSON.parse(text);
      // Only the generated compact JSON is accepted, including no duplicate keys.
      if (JSON.stringify(status) !== text) throw new Error();
    } catch { throw fail('status_invalid'); }
    return { status: validate(status), dev: info.dev, ino: info.ino };
  } finally { await handle.close(); }
}
async function directorySync(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeStatus(target, status, previous) {
  validate(status); await unchangedParent(target);
  const temporary = path.join(target.directory, `.${path.basename(target.file)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600); let present = true;
  try {
    try { await handle.writeFile(JSON.stringify(status) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await unchangedParent(target);
    if (previous) {
      const current = await lstat(target.file); privateStatus(current);
      if (current.dev !== previous.dev || current.ino !== previous.ino) throw fail('status_changed');
      await rename(temporary, target.file); present = false;
    } else {
      await link(temporary, target.file); // First publication must not overwrite an arrival.
      await unlink(temporary); present = false;
    }
    await directorySync(target.directory);
    return await readStatus(target);
  } finally { if (present) await unlink(temporary); }
}
function assessment(status, now) {
  const point = status.point;
  let error = status.outcome === 'running' ? 'attempt_in_progress' : status.error;
  if ([status.attemptedAt, status.finishedAt, point?.verifiedAt, point?.snapshotAt].some(value => value != null && value > now + FUTURE)) error = 'clock_invalid';
  else if (!error && now - status.attemptedAt > 3 * HOUR) error = 'attempt_stale';
  else if (!error && (!point || now - point.snapshotAt > 36 * HOUR)) error = 'snapshot_stale';
  return { ok: !error, error, status };
}
const SAFE_FAILURES = new Set(['invalid_job_path', 'private_path_inside_source', 'status_directory_permissions', 'status_directory_changed',
  'status_file_permissions', 'status_unreadable', 'status_invalid', 'status_changed', 'status_missing', 'job_locked', 'clock_invalid']);
const failed = error => ({ ok: false, error: SAFE_FAILURES.has(error?.code) ? error.code : 'job_failed', status: null });
async function isLocked(target) {
  try { await lstat(target.file + '.lock'); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// This reads an attestation only: no config, SSH, key, archive or crypto check.
export async function checkPullJob(statusFile, { now = Date.now } = {}) {
  try {
    const at = clock(now), target = await location(statusFile);
    if (await isLocked(target)) throw fail('job_locked');
    const stored = await readStatus(target);
    await unchangedParent(target);
    if (await isLocked(target)) throw fail('job_locked');
    if (!stored) throw fail('status_missing');
    return assessment(stored.status, at);
  } catch (error) { return failed(error); }
}

// Injection is a library test seam, never loaded from config or status.
export async function runPullJob(configFile, statusFile, { pull = pullBackup, now = Date.now, signal } = {}) {
  let target, ownsLock = false, release = true;
  try {
    absolute(configFile); target = await location(statusFile);
    try { await mkdir(target.file + '.lock', { mode: 0o700 }); ownsLock = true; }
    catch { throw fail('job_locked'); }
    let stored = await readStatus(target);
    const observedAt = clock(now), previousAt = stored ? (stored.status.finishedAt ?? stored.status.attemptedAt) : 0;
    // On a backward clock jump, record failure at the last known timestamp;
    // do not leave an earlier green attestation as the latest attempt.
    const attemptedAt = Math.max(observedAt, previousAt);
    const running = { version: 1, attemptedAt, finishedAt: null, outcome: 'running', error: null, point: stored?.status.point ?? null };
    release = false; // Failed publication/cleanup leaves a lock, never an old green status alone.
    stored = await writeStatus(target, running, stored);
    let finishedAt = attemptedAt, outcome = 'error', error, point = running.point;
    try {
      if (observedAt < previousAt) throw fail('clock_invalid');
      const config = await readPullConfig(configFile);
      const result = await pull(config, { now: attemptedAt, signal });
      finishedAt = clock(now); if (finishedAt < attemptedAt) throw fail('clock_invalid');
      const snapshotAt = snapshotTime(result?.filename);
      if (!result || result.restoredIntegrity !== 'ok' || !Number.isFinite(snapshotAt) ||
        !Number.isSafeInteger(result.bytes) || result.bytes < 36 || result.bytes > 2 * 1024 ** 3 + 36) throw fail('invalid_pull_result');
      if (snapshotAt > finishedAt + FUTURE) throw fail('clock_invalid');
      point = { filename: result.filename, bytes: result.bytes, snapshotAt, verifiedAt: finishedAt };
      error = finishedAt - snapshotAt > 36 * HOUR ? 'snapshot_stale' : null;
      outcome = error ? 'stale' : 'ok';
    } catch (problem) {
      error = cleanError(problem);
      try { finishedAt = Math.max(attemptedAt, clock(now)); } catch { finishedAt = attemptedAt; error = 'clock_invalid'; }
    }
    const status = { ...running, finishedAt, outcome, error, point };
    await writeStatus(target, status, stored); release = true;
    return assessment(status, clock(now));
  } catch (error) { return failed(error); }
  finally {
    if (ownsLock && release) {
      try { await unchangedParent(target); await rmdir(target.file + '.lock'); }
      catch { return failed(fail('job_failed')); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  let result;
  if (args.length === 2 && args[0] === '--check') result = await checkPullJob(args[1]);
  else if (args.length === 2 && args[0] !== '--check') result = await runPullJob(args[0], args[1], { signal: controller.signal });
  else result = { ok: false, error: 'usage_config_status_or_check_status', status: null };
  console.log(JSON.stringify(result)); process.exitCode = result.ok ? 0 : 1;
}
