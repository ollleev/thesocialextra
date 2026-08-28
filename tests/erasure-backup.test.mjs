import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, chown, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackup } from '../backup.mjs';
import { ErasureJournal, initializeErasureJournal, ERASURE_JOURNAL_MAX_BYTES } from '../erasure-journal.mjs';
import { decryptBackup } from '../ops/backup-crypto.mjs';
import { ERASURE_BACKUP_LIMITS, runErasureBackup } from '../ops/erasure-backup.mjs';

const START = Date.UTC(2026, 7, 28, 12), sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'social-erasure-backup-')));
  const file = name => path.join(root, name), database = file('journal.sqlite'), directory = file('points'), keyFile = file('key');
  await mkdir(directory, { mode: 0o700 }); await writeFile(keyFile, randomBytes(32), { mode: 0o600 });
  // Only the bootstrap prerequisites: no accounts, PII, network or application
  // fixtures are needed to exercise real cumulative erasure journal snapshots.
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE app_meta(id INTEGER PRIMARY KEY,epoch TEXT); CREATE TABLE auth_users(id TEXT);');
  db.prepare('INSERT INTO app_meta VALUES(1,?)').run(randomUUID());
  const tip = initializeErasureJournal({ db, filename: database }); db.close();
  const journal = new ErasureJournal(database);
  t.after(async () => { journal.close(); await rm(root, { recursive: true, force: true }); });
  const run = (options = {}) => runErasureBackup({ database, directory, keyFile, now: START, ...options });
  const status = async () => JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8'));
  const archives = async () => (await readdir(directory)).filter(name => name.startsWith('snapshot-')).sort();
  return { root, file, database, directory, keyFile, tip, journal, run, status, archives };
}
async function clean(f, { locked = false } = {}) {
  const entries = await readdir(f.directory);
  assert.equal(entries.some(name => name.startsWith('.working-') || name.endsWith('.tmp') || name.endsWith('.partial')), false);
  assert.equal(entries.includes('.erasure-backup.lock'), locked);
}
async function unchanged(f, status) {
  assert.deepEqual(await f.status(), status); await clean(f);
}
async function corrupt(filename) {
  const handle = await open(filename, 'r+');
  try { const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, 25); byte[0] ^= 1; await handle.write(byte, 0, 1, 25); }
  finally { await handle.close(); }
}

test('producer verifies a native private snapshot and AES roundtrip before publishing archive then durable status', async t => {
  const f = await fixture(t), sourceBefore = sha(await readFile(f.database)), phases = [];
  const result = await f.run({ testOptions: { hook: async (phase, data) => {
    phases.push(phase);
    if (phase === 'beforeEncryption') {
      assert.equal((await lstat(data.snapshot)).mode & 0o777, 0o600);
      assert.equal((await lstat(path.dirname(data.snapshot))).mode & 0o777, 0o700);
    }
    if (phase === 'beforeStatus') {
      assert.equal((await f.archives()).length, 1);
      await assert.rejects(f.status(), { code: 'ENOENT' });
    }
    if (phase === 'afterStatus') assert.deepEqual(await f.status(), data.status);
  } } });
  assert.deepEqual(phases, ['beforeEncryption', 'afterEncryption', 'beforeStatus', 'afterStatus']);
  assert.deepEqual(result.tip, f.tip); assert.equal(result.previous, null); assert.equal(result.removed, 0);
  assert.equal(result.lastSuccessAt, START); assert.equal(sha(await readFile(f.database)), sourceBefore);
  const stored = await f.status(); assert.deepEqual(Object.keys(stored).sort(), ['filename', 'lastSuccessAt', 'previous', 'sha256', 'tip', 'version']);
  const archive = path.join(f.directory, result.filename);
  assert.equal((await lstat(archive)).mode & 0o777, 0o600); assert.equal((await lstat(archive)).nlink, 1);
  assert.equal((await lstat(path.join(f.directory, 'status.json'))).mode & 0o777, 0o600);
  assert.equal(sha(await readFile(archive)), result.sha256);
  const restored = f.file('independent.sqlite'); await decryptBackup(archive, restored, await readFile(f.keyFile));
  const reader = new ErasureJournal(restored, { readOnly: true });
  try { assert.deepEqual(reader.verify(), f.tip); } finally { reader.close(); }
  await clean(f);
});

test('unchanged tips still produce fresh independent points; rotation retains exactly the two committed points', async t => {
  const f = await fixture(t), first = await f.run();
  const second = await f.run({ now: START + 1000 });
  assert.notEqual(first.filename, second.filename); assert.deepEqual(second.tip, first.tip);
  assert.equal(second.previous.filename, first.filename); assert.equal((await f.archives()).length, 2);
  const third = await f.run({ now: START + 2000 });
  assert.equal(third.previous.filename, second.filename); assert.equal(third.removed, 1);
  assert.deepEqual(await f.archives(), [second.filename, third.filename].sort());
  await clean(f);
});

test('same-second retries and backward clocks never create a randomly ordered duplicate', async t => {
  const f = await fixture(t); await f.run(); const status = await f.status();
  await assert.rejects(f.run({ now: START + 999 }), { code: 'erasure_backup_clock_not_advanced' });
  await unchanged(f, status);
  await assert.rejects(f.run({ now: START - 1 }), { code: 'erasure_backup_clock_invalid' });
  await unchanged(f, status); assert.equal((await f.archives()).length, 1);
});

test('cumulative progression binds the previous hash and refuses an older valid journal', async t => {
  const f = await fixture(t), older = f.file('older.sqlite');
  f.journal.append(randomUUID(), START); await createBackup(f.database, older);
  await f.run(); f.journal.append(randomUUID(), START + 1);
  const second = await f.run({ now: START + 1000 }); assert.equal(second.tip.seq, 2);
  const status = await f.status();
  await assert.rejects(f.run({ database: older, now: START + 2000 }), { code: 'erasure_backup_journal_regression' });
  await unchanged(f, status); assert.equal((await f.archives()).length, 2);
});

test('same-length fork with a different receipt and another resource are rejected without replacing a point', async t => {
  const f = await fixture(t), forkFile = f.file('fork.sqlite'); await createBackup(f.database, forkFile);
  f.journal.append(randomUUID(), START); await f.run(); const status = await f.status();
  const fork = new ErasureJournal(forkFile);
  try { fork.append(randomUUID(), START); } finally { fork.close(); }
  await assert.rejects(f.run({ database: forkFile, now: START + 1000 }), { code: 'erasure_backup_journal_regression' });
  await unchanged(f, status);
  const other = await fixture(t);
  await assert.rejects(f.run({ database: other.database, now: START + 1000 }), { code: 'erasure_backup_journal_regression' });
  await unchanged(f, status);
});

test('wrong existing key cannot silently rotate a resource; old ciphertext and status remain unchanged', async t => {
  const f = await fixture(t); const first = await f.run(), status = await f.status();
  const ciphertext = await readFile(path.join(f.directory, first.filename));
  await writeFile(f.keyFile, randomBytes(32));
  await assert.rejects(f.run({ now: START + 1000 }), { code: 'erasure_backup_failed' });
  assert.deepEqual(await readFile(path.join(f.directory, first.filename)), ciphertext); await unchanged(f, status);
});

test('corruption in a referenced archive refuses publication, preserving the other recovery point', async t => {
  const f = await fixture(t), first = await f.run(); await f.run({ now: START + 1000 }); const status = await f.status();
  const previous = await readFile(path.join(f.directory, first.filename));
  await corrupt(path.join(f.directory, status.filename));
  await assert.rejects(f.run({ now: START + 2000 }), { code: 'erasure_backup_archive_invalid' });
  assert.deepEqual(await readFile(path.join(f.directory, first.filename)), previous); await unchanged(f, status);
});

test('corrupted candidate fails authentication before publication and leaves no plaintext or partial file', async t => {
  const f = await fixture(t); await f.run(); const status = await f.status();
  await assert.rejects(f.run({ now: START + 1000, testOptions: { hook: async (phase, data) => {
    if (phase === 'afterEncryption') await corrupt(data.encrypted);
  } } }), { code: 'erasure_backup_failed' });
  await unchanged(f, status); assert.equal((await f.archives()).length, 1);
});

test('chain corruption is rejected even when SQLite integrity remains valid', async t => {
  const f = await fixture(t); f.journal.append(randomUUID(), START); await f.run(); const status = await f.status();
  const changed = f.file('changed.sqlite'); await createBackup(f.database, changed);
  const db = new DatabaseSync(changed); db.exec("UPDATE erasure_requests SET hash='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"); db.close();
  await assert.rejects(f.run({ database: changed, now: START + 1000 }), { code: 'erasure_backup_failed' });
  await unchanged(f, status);
});

test('missing or malformed status with archives does not silently initialize a new resource', async t => {
  const f = await fixture(t); await f.run(); const statusFile = path.join(f.directory, 'status.json'), bytes = await readFile(statusFile);
  await unlink(statusFile);
  await assert.rejects(f.run({ now: START + 1000 }), { code: 'erasure_backup_status_missing' });
  await writeFile(statusFile, bytes, { mode: 0o600 }); const status = await f.status();
  await writeFile(statusFile, JSON.stringify({ ...status, extra: 'not allowed' }));
  await assert.rejects(f.run({ now: START + 1000 }), { code: 'erasure_backup_status_invalid' });
  await writeFile(statusFile, '{"version":1,"version":1}');
  await assert.rejects(f.run({ now: START + 1000 }), { code: 'erasure_backup_status_invalid' });
  assert.equal((await f.archives()).length, 1); await clean(f);
});

test('budget and disk reserve refuse a new point before pruning any existing point', async t => {
  const f = await fixture(t); await f.run(); await f.run({ now: START + 1000 }); const status = await f.status();
  const archives = await f.archives(); let storedBytes = 0;
  for (const name of archives) storedBytes += (await lstat(path.join(f.directory, name))).size;
  await assert.rejects(f.run({ now: START + 2000, testOptions: { maxStoredBytes: storedBytes } }), { code: 'erasure_backup_capacity' });
  await unchanged(f, status); assert.deepEqual(await f.archives(), archives);
  await assert.rejects(f.run({ now: START + 2000, testOptions: { freeBytes: async () => ERASURE_BACKUP_LIMITS.minFreeBytes } }), { code: 'erasure_backup_space' });
  await unchanged(f, status);
});

test('unknown archives, symlinks and files are never rotated and count against capacity', async t => {
  const f = await fixture(t); await f.run();
  const foreign = `snapshot-2026-08-28T11-00-00Z-${randomUUID()}.tseb`, foreignFile = path.join(f.directory, foreign);
  await writeFile(foreignFile, Buffer.from('unrelated resource'), { mode: 0o600 });
  const foreignLink = `snapshot-2026-08-28T10-00-00Z-${randomUUID()}.tseb`;
  await symlink(f.keyFile, path.join(f.directory, foreignLink));
  const other = path.join(f.directory, 'operator-note'); await writeFile(other, 'synthetic unrelated file', { mode: 0o600 });
  await f.run({ now: START + 1000 }); await f.run({ now: START + 2000 });
  assert.equal(await readFile(foreignFile, 'utf8'), 'unrelated resource'); assert.equal((await lstat(path.join(f.directory, foreignLink))).isSymbolicLink(), true);
  assert.equal(await readFile(other, 'utf8'), 'synthetic unrelated file');
  await truncate(other, ERASURE_BACKUP_LIMITS.maxStoredBytes);
  const status = await f.status(); await assert.rejects(f.run({ now: START + 3000 }), { code: 'erasure_backup_capacity' });
  await unchanged(f, status);
});

test('permissions, hardlinks, symlinks and unsafe private locations are refused without changing them', async t => {
  const f = await fixture(t);
  await chmod(f.directory, 0o755); await assert.rejects(f.run(), { code: 'erasure_backup_permissions' }); await chmod(f.directory, 0o700);
  await chmod(f.keyFile, 0o644); await assert.rejects(f.run(), { code: 'erasure_backup_permissions' }); await chmod(f.keyFile, 0o600);
  await chmod(f.database, 0o644); await assert.rejects(f.run(), { code: 'erasure_backup_permissions' }); await chmod(f.database, 0o600);
  const keyLink = f.file('key-link'); await symlink(f.keyFile, keyLink); await assert.rejects(f.run({ keyFile: keyLink }), { code: 'erasure_backup_permissions' });
  const dbLink = f.file('db-link'); await symlink(f.database, dbLink); await assert.rejects(f.run({ database: dbLink }), { code: 'erasure_backup_permissions' });
  const dirLink = f.file('dir-link'); await symlink(f.directory, dirLink); await assert.rejects(f.run({ directory: dirLink }), { code: 'erasure_backup_permissions' });
  const hard = f.file('hard-link'); await link(f.database, hard); await assert.rejects(f.run(), { code: 'erasure_backup_permissions' }); await unlink(hard);
  await assert.rejects(f.run({ database: 'relative.sqlite' }), { code: 'erasure_backup_path_invalid' });
  await assert.rejects(f.run({ directory: `${f.root}/../${path.basename(f.root)}/points` }), { code: 'erasure_backup_path_invalid' });
  await assert.rejects(f.run({ keyFile: path.join(f.directory, 'key') }), { code: 'erasure_backup_path_invalid' });
  await f.run(); const statusFile = path.join(f.directory, 'status.json'); await chmod(statusFile, 0o644);
  await assert.rejects(f.run({ now: START + 1000 }), { code: 'erasure_backup_permissions' }); await chmod(statusFile, 0o600);
  await rename(statusFile, f.file('saved-status')); await symlink(f.file('saved-status'), statusFile);
  await assert.rejects(f.run({ now: START + 1000 }), { code: 'erasure_backup_status_invalid' }); await clean(f);
});

test('exclusive lock prevents concurrent runs and an abandoned lock is never reclaimed', async t => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const running = f.run({ testOptions: { hook: async phase => { if (phase === 'beforeEncryption') { entered(); await gate; } } } });
  await started;
  try { await assert.rejects(f.run({ now: START + 1000 }), { code: 'erasure_backup_locked' }); }
  finally { release(); }
  await running; await clean(f);
  await mkdir(path.join(f.directory, '.erasure-backup.lock'), { mode: 0o700 });
  await assert.rejects(f.run({ now: START + 1000 }), { code: 'erasure_backup_locked' }); await clean(f, { locked: true });
});

test('publication before status failure preserves the old point and leaves an inspection lock, never rotating it', async t => {
  const f = await fixture(t); await f.run(); await f.run({ now: START + 1000 }); const status = await f.status();
  const previous = await f.archives();
  await assert.rejects(f.run({ now: START + 2000, testOptions: { hook: async phase => {
    if (phase === 'beforeStatus') throw Error('synthetic arbitrary diagnostic must not escape');
  } } }), { code: 'erasure_backup_failed', message: 'erasure_backup_failed' });
  assert.deepEqual(await f.status(), status); assert.equal((await f.archives()).length, 3);
  for (const name of previous) await lstat(path.join(f.directory, name));
  await clean(f, { locked: true });
  await assert.rejects(f.run({ now: START + 3000 }), { code: 'erasure_backup_locked' });
});

test('a failure after status publication cannot delete either committed point; later rotation leaves unknown orphans', async t => {
  const f = await fixture(t), first = await f.run(); await f.run({ now: START + 1000 });
  await assert.rejects(f.run({ now: START + 2000, testOptions: { hook: async phase => {
    if (phase === 'afterStatus') throw Error('synthetic cleanup failure');
  } } }), { code: 'erasure_backup_failed' });
  const status = await f.status(); assert.equal((await f.archives()).length, 3);
  await lstat(path.join(f.directory, status.filename)); await lstat(path.join(f.directory, status.previous.filename)); await clean(f);
  const fourth = await f.run({ now: START + 3000 }); assert.equal(fourth.removed, 1);
  await lstat(path.join(f.directory, first.filename)); // No longer in status: not safe to prune automatically.
});

test('oversized source, non-SQLite input and invalid options cannot create an archive or status', async t => {
  const f = await fixture(t), large = f.file('large.sqlite'); await writeFile(large, '', { mode: 0o600 }); await truncate(large, ERASURE_JOURNAL_MAX_BYTES + 1);
  await assert.rejects(f.run({ database: large }), { code: 'erasure_backup_permissions' });
  const invalid = f.file('invalid.sqlite'); await writeFile(invalid, 'not SQLite', { mode: 0o600 });
  await assert.rejects(f.run({ database: invalid }), { code: 'erasure_backup_failed' });
  await assert.rejects(f.run({ testOptions: { maxStoredBytes: ERASURE_BACKUP_LIMITS.maxStoredBytes + 1 } }), { code: 'erasure_backup_options_invalid' });
  await assert.rejects(f.run({ now: NaN }), { code: 'erasure_backup_path_invalid' });
  assert.deepEqual(await f.archives(), []); await assert.rejects(f.status(), { code: 'ENOENT' }); await clean(f);
});

test('a point replaced by a symlink after verification is never unlinked during rotation', async t => {
  const f = await fixture(t), first = await f.run(); await f.run({ now: START + 1000 });
  const obsolete = path.join(f.directory, first.filename), originalKey = await readFile(f.keyFile);
  await assert.rejects(f.run({ now: START + 2000, testOptions: { hook: async phase => {
    if (phase === 'afterStatus') { await rename(obsolete, f.file('kept-ciphertext')); await symlink(f.keyFile, obsolete); }
  } } }), { code: 'erasure_backup_permissions' });
  assert.equal((await lstat(obsolete)).isSymbolicLink(), true); assert.deepEqual(await readFile(f.keyFile), originalKey);
  const status = await f.status(); await lstat(path.join(f.directory, status.filename)); await lstat(path.join(f.directory, status.previous.filename));
  await clean(f);
});

test('a receipt arriving after the pinned copy remains for the next point, never a mixed snapshot', async t => {
  const f = await fixture(t); f.journal.append(randomUUID(), START);
  const first = await f.run({ testOptions: { hook: async phase => {
    if (phase === 'beforeEncryption') f.journal.append(randomUUID(), START + 1);
  } } });
  assert.equal(first.tip.seq, 1); assert.equal(f.journal.verify().seq, 2);
  const next = await f.run({ now: START + 1000 }); assert.equal(next.tip.seq, 2); assert.equal(next.previous.tip.seq, 1);
  await clean(f);
});

test('missing key is never generated and first publication refuses an existing canonical symlink', async t => {
  const f = await fixture(t), missing = f.file('absent-key');
  await assert.rejects(f.run({ keyFile: missing }), { code: 'erasure_backup_failed' });
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  const foreign = path.join(f.directory, `snapshot-2026-08-28T11-00-00Z-${randomUUID()}.tseb`);
  await symlink(f.keyFile, foreign);
  await assert.rejects(f.run(), { code: 'erasure_backup_status_missing' });
  assert.equal((await lstat(foreign)).isSymbolicLink(), true); await clean(f);
});

test('root may read an application-owned private source without changing its owner or bytes', { skip: process.getuid() !== 0 ? 'requires root only for synthetic fixture chown; no escalation' : false }, async t => {
  const f = await fixture(t), sourceDirectory = f.file('application-owned');
  await mkdir(sourceDirectory, { mode: 0o700 }); const source = path.join(sourceDirectory, 'journal.sqlite');
  await createBackup(f.database, source); await chown(source, 65534, 65534); await chown(sourceDirectory, 65534, 65534);
  const before = sha(await readFile(source)); const point = await f.run({ database: source });
  assert.deepEqual(point.tip, f.tip); assert.equal(sha(await readFile(source)), before);
  assert.equal((await lstat(source)).uid, 65534); assert.equal((await lstat(sourceDirectory)).uid, 65534);
  assert.equal((await lstat(path.join(f.directory, point.filename))).uid, process.getuid()); await clean(f);
});
