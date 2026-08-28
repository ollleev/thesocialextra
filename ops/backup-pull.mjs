import { spawn, fork } from 'node:child_process';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, opendir, realpath, rm, rmdir, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupKey, decryptBackup } from './backup-crypto.mjs';

const DAY = 86400000, MAX_BYTES = 2 * 1024 ** 3 + 36, MAX_ENTRIES = 4096;
const NAME = /^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tseb$/;
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fail = code => Object.assign(new Error(code), { code });
function stamp(name) {
  const match = typeof name === 'string' && NAME.exec(name);
  if (!match) return NaN;
  const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z'), value = Date.parse(iso);
  return Number.isFinite(value) && new Date(value).toISOString().replace('.000Z', 'Z') === iso ? value : NaN;
}
function absolute(value) { return typeof value === 'string' && path.isAbsolute(value) && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value); }
function outsideSource(value) { if (value === ROOT || value.startsWith(ROOT + path.sep)) throw fail('private_path_inside_source'); }
async function privateFile(filename, read = false) {
  if (!absolute(filename)) throw fail('invalid_private_path');
  const canonical = path.join(await realpath(path.dirname(filename)), path.basename(filename));
  outsideSource(canonical);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()) throw fail('private_file_permissions');
    if (read && info.size > 16384) throw fail('config_too_large');
    if (!read) return { filename: canonical };
    const bytes = Buffer.alloc(16385), result = await handle.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 16384) throw fail('config_too_large');
    return { filename: canonical, bytes: bytes.subarray(0, result.bytesRead) };
  } finally { await handle.close(); }
}
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
    Object.keys(config).sort().join(',') !== 'host,identityFile,keyFile,localDirectory,remoteDirectory' ||
    typeof config.host !== 'string' || config.host.length > 255 || !/^(?:[A-Za-z0-9_][A-Za-z0-9_-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(config.host) ||
    !['identityFile', 'keyFile', 'localDirectory', 'remoteDirectory'].every(key => absolute(config[key])) ||
    config.remoteDirectory === '/' || config.remoteDirectory.split('/').includes('..')) throw fail('invalid_pull_config');
  return { ...config };
}
export async function readPullConfig(filename) {
  try { return validateConfig(JSON.parse((await privateFile(filename, true)).bytes.toString('utf8'))); }
  catch (error) { throw fail(error.code === 'private_path_inside_source' ? error.code : 'invalid_pull_config'); }
}

// Sent on stdin, never assembled from user-provided Python or shell fragments.
// A directory descriptor and O_NOFOLLOW keep both listing and reads confined.
const SOURCE = String.raw`import os, sys, stat, json, base64, re, datetime
try:
 p = json.loads(base64.b64decode(sys.argv[1], validate=True))
 pattern = re.compile(r'^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tseb$')
 def canonical(name):
  m = pattern.fullmatch(name)
  if not m: return False
  try: return datetime.datetime.strptime(m[1], '%Y-%m-%dT%H-%M-%SZ').strftime('%Y-%m-%dT%H-%M-%SZ') == m[1]
  except ValueError: return False
 directory = p['directory']
 if not directory.startswith('/') or '..' in directory.split('/'): raise ValueError()
 root = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
 for part in filter(None, directory.split('/')):
  child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
  os.close(root); root = child
 info = os.fstat(root)
 if stat.S_IMODE(info.st_mode) != 0o700: raise ValueError()
 if p['operation'] == 'list':
  entries = []
  with os.scandir(root) as scan:
   for count, entry in enumerate(scan):
    if count >= 4096: raise ValueError()
    if not canonical(entry.name): continue
    info = entry.stat(follow_symlinks=False)
    if stat.S_ISREG(info.st_mode) and not stat.S_IMODE(info.st_mode) & 0o077 and 36 <= info.st_size <= 2147483684:
     entries.append({'name': entry.name, 'bytes': info.st_size})
  result = json.dumps(entries, separators=(',', ':')).encode()
  if len(result) > 524288: raise ValueError()
  sys.stdout.buffer.write(result)
 elif p['operation'] == 'read' and canonical(p['name']):
  fd = os.open(p['name'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
  with os.fdopen(fd, 'rb') as source:
   info = os.fstat(source.fileno())
   if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077 or info.st_size != p['bytes'] or not 36 <= info.st_size <= 2147483684: raise ValueError()
   remaining = info.st_size
   while remaining:
    chunk = source.read(min(65536, remaining))
    if not chunk: raise ValueError()
    sys.stdout.buffer.write(chunk); remaining -= len(chunk)
   if source.read(1) or os.fstat(source.fileno()).st_size != info.st_size: raise ValueError()
 else: raise ValueError()
 os.close(root)
except Exception:
 sys.exit(1)
`;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function abortCheck(signal) { if (signal.aborted) throw fail('pull_interrupted'); }
function untilAbort(promise, signal) {
  if (signal.aborted) { void promise.catch(() => {}); throw fail('pull_interrupted'); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('pull_interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function createSSHTransport(config, { spawnProcess = spawn } = {}) {
  validateConfig(config);
  async function* bytes(operation, entry, signal, maxBytes) {
    const parameters = Buffer.from(JSON.stringify({ directory: config.remoteDirectory, operation, ...entry })).toString('base64');
    const args = ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-o', 'ClearAllForwardings=yes',
      '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'LogLevel=ERROR', '-i', config.identityFile, '--', config.host,
      'python3 -I - ' + quote(parameters)];
    abortCheck(signal);
    const child = spawnProcess('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let exited = false, excessive = false, stderrBytes = 0, received = 0;
    const done = new Promise(resolve => {
      child.once('error', () => resolve(false));
      child.once('close', code => { exited = true; resolve(code === 0); });
    });
    const abort = () => { if (!exited) child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) { excessive = true; abort(); } });
    child.stdin.on('error', () => {});
    child.stdin.end(SOURCE);
    try {
      for await (const chunk of child.stdout) {
        abortCheck(signal); received += chunk.length;
        if (received > maxBytes) { excessive = true; throw fail('transport_limit'); }
        yield chunk;
      }
      if (!(await done) || excessive) throw fail('transport_failed');
      abortCheck(signal);
    } catch { throw fail(signal.aborted ? 'pull_interrupted' : 'transport_failed'); }
    finally { abort(); await done; signal.removeEventListener('abort', abort); }
  }
  return {
    async list({ signal }) {
      const chunks = [];
      for await (const chunk of bytes('list', {}, signal, 524288)) chunks.push(chunk);
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('invalid_source_list'); }
    },
    read(entry, { signal }) { return bytes('read', entry, signal, entry.bytes); },
  };
}

async function verify(encrypted, restored, key, signal) {
  abortCheck(signal);
  // A separate process can be killed even while SQLite is in synchronous native
  // code. The key travels over IPC, never through arguments or the environment.
  const child=fork(fileURLToPath(import.meta.url),['--verify-pull'],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',
    execArgv:['--max-old-space-size=32'],env:{}});
  let closed=false;
  const done=new Promise(resolve=>child.once('close',()=>{closed=true;resolve();}));
  const abort = () => { if(!closed)child.kill('SIGKILL'); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      child.once('message', result => result === true ? resolve() : reject(fail('verification_failed')));
      child.once('error', () => reject(fail('verification_failed')));
      child.once('exit', () => reject(fail(signal.aborted ? 'pull_interrupted' : 'verification_failed')));
      child.send({encrypted,restored,key});
    });
    abortCheck(signal);
  } finally { abort(); await done; signal.removeEventListener('abort', abort); }
}
async function syncDirectory(directory) { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function inventory(directory) {
  const snapshots = []; let count = 0;
  for await (const entry of await opendir(directory)) {
    if (++count > MAX_ENTRIES) throw fail('local_entry_limit');
    const createdAt = stamp(entry.name); if (!Number.isFinite(createdAt)) continue;
    const filename = path.join(directory, entry.name), info = await lstat(filename);
    if (info.isFile() && !info.isSymbolicLink()) snapshots.push({ name: entry.name, filename, createdAt, bytes: info.size, dev: info.dev, ino: info.ino });
  }
  return snapshots;
}

// Library injection is for local tests/operators, never accepted from JSON or HTTP.
export async function pullBackup(input, { transport, now = Date.now(), timeoutMs = 120000, signal: externalSignal,
  maxStoredBytes = 4 * 1024 ** 3, minFreeBytes = 1024 ** 3, freeSpace = statfs, pruneExpired = true } = {}) {
  let lock, work, key, timedOut = false;
  const controller = new AbortController(), signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  if (!Number.isSafeInteger(now) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000 ||
    !Number.isSafeInteger(maxStoredBytes) || maxStoredBytes < 1 || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0 || typeof pruneExpired !== 'boolean') throw fail('invalid_pull_policy');
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const config = validateConfig(input);
    config.identityFile = (await privateFile(config.identityFile)).filename;
    config.keyFile = (await privateFile(config.keyFile)).filename;
    key = await backupKey(config.keyFile);
    // Resolve the existing parent before any write, including paths with '..'
    // or an ancestor symlink. Never create a directory inside the source tree.
    const directory = path.join(await realpath(path.dirname(config.localDirectory)), path.basename(config.localDirectory));
    outsideSource(directory);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) throw fail('local_directory_permissions');
    const lockPath = path.join(directory, '.pull.lock');
    try { await mkdir(lockPath, { mode: 0o700 }); } catch { throw fail('pull_locked'); }
    lock = lockPath;
    const snapshots = await inventory(directory), cutoff = now - 7 * DAY;
    const source = transport || createSSHTransport(config);
    const entries = await untilAbort(source.list({ signal }), signal);
    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw fail('invalid_source_list');
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || Object.keys(entry).sort().join(',') !== 'bytes,name' || !Number.isFinite(stamp(entry.name)) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 36 || entry.bytes > MAX_BYTES || seen.has(entry.name)) throw fail('invalid_source_list');
      seen.add(entry.name);
    }
    const latest = entries.filter(entry => stamp(entry.name) >= cutoff && stamp(entry.name) <= now + 300000)
      .sort((a, b) => stamp(b.name) - stamp(a.name) || b.name.localeCompare(a.name))[0];
    if (!latest) throw fail('no_recent_snapshot');
    const destination = path.join(directory, latest.name), existing = snapshots.find(item => item.name === latest.name);
    try {
      const target = await lstat(destination);
      if (!existing || !target.isFile() || target.isSymbolicLink() || (target.mode & 0o777) !== 0o600 || target.size !== latest.bytes) throw fail('destination_conflict');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const retainedBytes = snapshots.filter(item => !pruneExpired || item.createdAt >= cutoff).reduce((sum, item) => sum + item.bytes, 0);
    if (!Number.isSafeInteger(retainedBytes) || retainedBytes + (existing ? 0 : latest.bytes) > maxStoredBytes) throw fail('retention_budget');
    const capacity = await untilAbort(freeSpace(directory), signal);
    if (capacity.bavail * capacity.bsize < minFreeBytes + 3 * latest.bytes + 1024 ** 2) throw fail('insufficient_space');
    abortCheck(signal);
    work = await mkdtemp(path.join(directory, '.pull-working-'));
    const encrypted = existing ? destination : path.join(work, 'received.tseb');
    if (!existing) {
      const handle = await open(encrypted, 'wx', 0o600); let received = 0;
      const iterator = source.read(latest, { signal })[Symbol.asyncIterator]();
      try {
        while (true) {
          const item = await untilAbort(iterator.next(), signal); if (item.done) break;
          if (!Buffer.isBuffer(item.value) && !(item.value instanceof Uint8Array)) throw fail('invalid_source_bytes');
          received += item.value.byteLength;
          if (received > latest.bytes || received > MAX_BYTES) throw fail('source_size_changed');
          let offset = 0;
          while (offset < item.value.byteLength) { const { bytesWritten } = await handle.write(item.value, offset); if (!bytesWritten) throw fail('receive_failed'); offset += bytesWritten; }
        }
        if (received !== latest.bytes) throw fail('source_size_changed');
        await handle.sync();
      } finally { await handle.close(); void iterator.return?.().catch(() => {}); }
    }
    await verify(encrypted, path.join(work, 'restored.sqlite'), key, signal);
    abortCheck(signal);
    if (existing) return { filename: latest.name, bytes: latest.bytes, restoredIntegrity: 'ok', alreadyPresent: true, removed: 0 };
    await link(encrypted, destination); await syncDirectory(directory);
    let removed = 0;
    for (const old of snapshots.filter(item => pruneExpired && item.createdAt < cutoff)) {
      abortCheck(signal);
      const current = await lstat(old.filename);
      if (current.isFile() && !current.isSymbolicLink() && current.dev === old.dev && current.ino === old.ino) { await unlink(old.filename); removed++; }
    }
    await syncDirectory(directory); abortCheck(signal);
    return { filename: latest.name, bytes: latest.bytes, restoredIntegrity: 'ok', alreadyPresent: false, removed };
  } catch (error) {
    const codes = new Set(['invalid_pull_config', 'private_path_inside_source', 'private_file_permissions', 'local_directory_permissions', 'pull_locked',
      'local_entry_limit', 'invalid_source_list', 'no_recent_snapshot', 'destination_conflict', 'retention_budget', 'insufficient_space',
      'source_size_changed', 'invalid_source_bytes', 'transport_failed', 'verification_failed', 'pull_interrupted']);
    throw fail(timedOut ? 'pull_timeout' : codes.has(error.code) ? error.code : 'backup_pull_failed');
  } finally {
    clearTimeout(timer); controller.abort(); key?.fill(0);
    // A cleanup failure deliberately leaves the lock for operator inspection.
    if (work) await rm(work, { recursive: true, force: true });
    if (lock) await rmdir(lock);
  }
}

const isCLI=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if (isCLI&&process.argv[2]==='--verify-pull'&&typeof process.send==='function') {
 process.once('message',async job=>{
  const key = Buffer.from(job.key);let verified=false;
  try {
    await decryptBackup(job.encrypted, job.restored, key);
    const header = await open(job.restored, 'r');
    try {
      const bytes = Buffer.alloc(16), result = await header.read(bytes, 0, 16, 0);
      if (result.bytesRead !== 16 || !bytes.equals(Buffer.from('SQLite format 3\0'))) throw fail('verification_failed');
    } finally { await header.close(); }
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(job.restored, { readOnly: true, defensive: true, allowExtension: false });
    try {
      db.exec('PRAGMA mmap_size=0; PRAGMA cache_size=-8192; PRAGMA trusted_schema=OFF;');
      if (db.prepare('PRAGMA integrity_check(1)').get().integrity_check !== 'ok') throw fail('verification_failed');
    } finally { db.close(); }
    verified=true;
  } catch { /* Only a boolean verdict leaves this private verifier. */ }
  finally { key.fill(0); }
  process.send(verified,()=>process.disconnect());
 });
} else if (isCLI) {
  const interrupted = new AbortController();
  process.once('SIGINT', () => interrupted.abort()); process.once('SIGTERM', () => interrupted.abort());
  try {
    if (process.argv.length !== 3) throw fail('usage_private_config_path_required');
    const config = await readPullConfig(process.argv[2]);
    console.log(JSON.stringify(await pullBackup(config, { signal: interrupted.signal })));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.code || 'backup_pull_failed' })); process.exitCode = 1; }
}
