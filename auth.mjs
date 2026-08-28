import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { ApiError } from './domain.mjs';

// OWASP's scrypt fallback when Argon2id is unavailable. Production callers must
// not override this work factor. The KDF runs asynchronously in native workers.
export const SCRYPT_CONFIG = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024, keyLength: 64 });
const KDF_ID = 'scrypt-N131072-r8-p1-key64-v1';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const DUMMY_SALT = randomBytes(16);
const DUMMY_VERIFIER = randomBytes(64);
let activeKdfs = 0, savepointSequence = 0;

const fail = (status, code) => { throw new ApiError(status, code); };
const publicUser = user => ({ id: user.id, username: user.username });
const secret = () => randomBytes(32).toString('hex');
const secretHash = value => createHash('sha256').update(Buffer.from(value, 'hex')).digest('hex');
const validToken = value => typeof value === 'string' && value.length === 64 && TOKEN_PATTERN.test(value);
function nativeKdf(password, salt, config) {
  return new Promise((resolve, reject) => scrypt(password, salt, config.keyLength,
    { N: config.N, r: config.r, p: config.p, maxmem: config.maxmem }, (error, key) => error ? reject(error) : resolve(key)));
}
function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'invalid_auth_input');
}
function username(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 32 || /[^a-zA-Z0-9_-]/.test(value)) fail(400, 'invalid_username');
  return value.toLowerCase();
}
function password(value) {
  if (typeof value !== 'string' || value.length > 256 || Buffer.byteLength(value, 'utf8') > 512) fail(400, 'invalid_password');
  const length = [...value].length;
  if (length < 15 || length > 128 || !value.isWellFormed()) fail(400, 'invalid_password');
  return value; // Spaces and Unicode are significant; no trimming/normalization.
}

/** Auth only. The caller owns database files, HTTP protections, and business cleanup. */
export class AuthService {
  #db;
  #clock;
  #kdf;
  #maxUsers;
  constructor({ db, clock = Date.now, testKdf, maxUsers = 10000 } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') throw new TypeError('DatabaseSync required');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (!Number.isSafeInteger(maxUsers) || maxUsers < 1) throw new TypeError('maxUsers must be a positive safe integer');
    if (testKdf !== undefined && (!process.env.NODE_TEST_CONTEXT || typeof testKdf !== 'function')) throw new TypeError('KDF injection is only available to the native test runner');
    this.#db = db; this.#clock = clock; this.#kdf = testKdf ?? nativeKdf; this.#maxUsers = maxUsers;
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_kdf TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        recovery_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id, created_at);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
    `);
  }
  #transaction(operation) {
    // Savepoints also compose with a caller's synchronous business transaction.
    const name = `auth_${++savepointSequence}`;
    this.#db.exec(`SAVEPOINT ${name}`);
    try {
      const result = operation();
      this.#db.exec(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      this.#db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      this.#db.exec(`RELEASE SAVEPOINT ${name}`);
      throw error;
    }
  }
  async #derive(cleartext, salt) {
    // Process-wide, including separate AuthService instances. No waiting queue
    // lets an attacker accumulate an unbounded backlog of expensive work.
    if (activeKdfs >= 2) fail(429, 'auth_busy');
    activeKdfs++;
    try {
      const key = await this.#kdf(cleartext, salt, SCRYPT_CONFIG);
      if (!Buffer.isBuffer(key) || key.length !== SCRYPT_CONFIG.keyLength) throw new Error('Invalid KDF result');
      return key;
    } finally { activeKdfs--; }
  }
  #newSession(userId) {
    const sessionToken = secret(), now = this.#clock();
    this.#db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    this.#db.prepare('INSERT INTO auth_sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(secretHash(sessionToken), userId, now, now + SESSION_MS);
    // rowid breaks ties when several successful logins share one millisecond.
    this.#db.prepare(`DELETE FROM auth_sessions WHERE user_id = ? AND token_hash NOT IN (
      SELECT token_hash FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5
    )`).run(userId, userId);
    return sessionToken;
  }
  async register(input) {
    fields(input, ['username', 'password']);
    const name = username(input.username), cleartext = password(input.password);
    if (this.#db.prepare('SELECT id FROM auth_users WHERE username = ?').get(name)) fail(409, 'username_unavailable');
    // Accounts do not expire. This pilot guardrail neither removes users nor
    // prevents existing users from logging in or recovering their account.
    if (this.#db.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n >= this.#maxUsers) fail(429, 'user_capacity_reached');
    const salt = randomBytes(16), key = await this.#derive(cleartext, salt);
    const user = { id: randomUUID(), username: name }, recoveryCode = secret();
    return this.#transaction(() => {
      // Recheck after the asynchronous KDF to handle competing registrations.
      if (this.#db.prepare('SELECT id FROM auth_users WHERE username = ?').get(name)) fail(409, 'username_unavailable');
      if (this.#db.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n >= this.#maxUsers) fail(429, 'user_capacity_reached');
      this.#db.prepare(`INSERT INTO auth_users(id, username, password_kdf, password_salt, password_hash, recovery_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(user.id, name, KDF_ID, salt.toString('hex'), key.toString('hex'), secretHash(recoveryCode), this.#clock());
      return { user, sessionToken: this.#newSession(user.id), recoveryCode };
    });
  }
  async login(input) {
    fields(input, ['username', 'password']);
    const name = username(input.username), cleartext = password(input.password);
    const user = this.#db.prepare('SELECT * FROM auth_users WHERE username = ?').get(name);
    const usable = user && user.password_kdf === KDF_ID && user.password_salt.length === 32 && user.password_hash.length === 128
      && /^[a-f0-9]{32}$/.test(user.password_salt) && /^[a-f0-9]{128}$/.test(user.password_hash);
    const salt = usable ? Buffer.from(user.password_salt, 'hex') : DUMMY_SALT;
    const expected = usable ? Buffer.from(user.password_hash, 'hex') : DUMMY_VERIFIER;
    // Unknown usernames incur the same KDF and constant-time comparison. The
    // random dummy verifier cannot authenticate anyone, even in an exact match.
    const actual = await this.#derive(cleartext, salt);
    const matched = timingSafeEqual(actual, expected);
    if (!usable || !matched) fail(401, 'invalid_credentials');
    return this.#transaction(() => {
      // A recovery/deletion during await must not let the old password create a
      // fresh session after the recovery revoked its existing sessions.
      const current = this.#db.prepare('SELECT id, username FROM auth_users WHERE id = ? AND password_hash = ? AND password_salt = ?')
        .get(user.id, user.password_hash, user.password_salt);
      if (!current) fail(401, 'invalid_credentials');
      return { user: publicUser(current), sessionToken: this.#newSession(current.id) };
    });
  }
  session(sessionToken) {
    if (!validToken(sessionToken)) return null;
    const user = this.#db.prepare(`SELECT u.id, u.username FROM auth_sessions s
      JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
      .get(secretHash(sessionToken), this.#clock());
    return user ? publicUser(user) : null;
  }
  logout(sessionToken) {
    if (validToken(sessionToken)) this.#db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(secretHash(sessionToken));
  }
  async recover(input) {
    fields(input, ['recoveryCode', 'password']);
    const cleartext = password(input.password);
    if (!validToken(input.recoveryCode)) fail(401, 'invalid_credentials');
    const oldRecoveryHash = secretHash(input.recoveryCode);
    const user = this.#db.prepare('SELECT id, username FROM auth_users WHERE recovery_hash = ?').get(oldRecoveryHash);
    if (!user) fail(401, 'invalid_credentials');
    const salt = randomBytes(16), key = await this.#derive(cleartext, salt);
    const recoveryCode = secret();
    return this.#transaction(() => {
      const changed = this.#db.prepare(`UPDATE auth_users SET password_salt = ?, password_hash = ?, password_kdf = ?, recovery_hash = ?
        WHERE id = ? AND recovery_hash = ?`)
        .run(salt.toString('hex'), key.toString('hex'), KDF_ID, secretHash(recoveryCode), user.id, oldRecoveryHash);
      if (Number(changed.changes) !== 1) fail(401, 'invalid_credentials');
      this.#db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(user.id);
      return { user: publicUser(user), sessionToken: this.#newSession(user.id), recoveryCode };
    });
  }
  deleteAccount(userId) {
    if (typeof userId !== 'string' || !userId || userId.length > 128) fail(400, 'invalid_user');
    this.#transaction(() => {
      this.#db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
      this.#db.prepare('DELETE FROM auth_users WHERE id = ?').run(userId);
    });
  }
}
