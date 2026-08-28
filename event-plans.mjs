import { createHash } from 'node:crypto';
import { ApiError, ROLES, fields, text } from './domain.mjs';
import { getLocation, LocationError } from './locations.mjs';

const DAY = 86400000, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LANGUAGES = new Set(['none', 'preferred', 'required']);
export const EVENT_PLAN_LIMITS = Object.freeze({ activePerUser: 20, recordsPerUser: 1000, totalRecords: 100000,
  needs: 12, quantity: 50, futureDays: 180, durationHours: 36, textBytes: 32768 });
const fail = (status, code) => { throw new ApiError(status, code); };
function exact(value, names) {
  fields(value, names);
  if (names.some(name => !Object.hasOwn(value, name))) fail(400, 'event_plan_incomplete');
}
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'invalid_event_plan_id'); return value; }
function privateText(value, max, required = false) {
  const result = text(value, max, required);
  // Detectable contact/payment details only, not a claim to recognize people's
  // names or every possible personal datum. No person/contact field is stored.
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/iu.test(result) || /(?:mailto|tel):/iu.test(result) ||
    /(?:^|[^\d])\+?\d(?:[\s().-]*\d){7,}(?:$|[^\d])/u.test(result) ||
    /\b[a-z]{2}\d{2}(?:[ -]?[a-z\d]){11,30}\b/iu.test(result)) fail(400, 'event_plan_personal_data');
  return result;
}
function instructions(value, overrides = false) {
  exact(value, ['attire', 'equipment', 'arrival']);
  return Object.fromEntries(['attire', 'equipment', 'arrival'].map(name => [name,
    overrides && value[name] === null ? null : privateText(value[name], 120)]));
}
function localParts(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) fail(400, 'invalid_event_local_time');
  const [year, month, day, hour, minute] = value.split(/[-T:]/).map(Number);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) fail(400, 'invalid_event_local_time');
  const at = Date.UTC(year, month - 1, day, hour, minute), date = new Date(at);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) fail(400, 'invalid_event_local_time');
  return { at, year, month, day, hour, minute };
}
function formatter(timezone) {
  try { return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', { timeZone: timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { fail(400, 'invalid_event_timezone'); }
}
function wallAt(format, at) {
  const parts = Object.fromEntries(format.formatToParts(at).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}
function resolveLocal(value, format) {
  const { at } = localParts(value), offsets = new Set();
  // Future civil zones in the city catalogue have stable offsets on either
  // side of a transition. Sample a three-day window, then verify each candidate
  // against the exact wall clock; neither gaps nor folds are silently selected.
  for (let hours = -36; hours <= 36; hours += 3) {
    const instant = at + hours * 3600000;
    offsets.add(wallAt(format, instant) - instant);
  }
  const candidates = [...offsets].map(offset => at - offset).filter(instant => wallAt(format, instant) === at);
  if (!candidates.length) fail(400, 'event_time_nonexistent');
  if (candidates.length !== 1) fail(400, 'event_time_ambiguous');
  return candidates[0];
}
function validate(input) {
  exact(input, ['title', 'cityId', 'timezone', 'venue', 'startLocal', 'endLocal', 'common', 'needs']);
  let city;
  try { city = getLocation(input.cityId); }
  catch (error) { if (error instanceof LocationError) fail(error.status, error.code); throw error; }
  if (input.timezone !== city.timezone) fail(400, 'event_timezone_mismatch');
  const format = formatter(city.timezone), startsAt = resolveLocal(input.startLocal, format), endsAt = resolveLocal(input.endLocal, format);
  if (endsAt <= startsAt || endsAt - startsAt > EVENT_PLAN_LIMITS.durationHours * 3600000) fail(400, 'invalid_event_duration');
  if (!Array.isArray(input.needs) || input.needs.length < 1 || input.needs.length > EVENT_PLAN_LIMITS.needs) fail(400, 'invalid_event_needs');
  const seen = new Set(), needs = input.needs.map(need => {
    exact(need, ['id', 'role', 'quantity', 'confirmed', 'languages', 'skills', 'overrides']);
    id(need.id); if (seen.has(need.id)) fail(400, 'duplicate_event_need'); seen.add(need.id);
    if (!ROLES.includes(need.role)) fail(400, 'invalid_role');
    if (!Number.isSafeInteger(need.quantity) || need.quantity < 1 || need.quantity > EVENT_PLAN_LIMITS.quantity ||
      !Number.isSafeInteger(need.confirmed) || need.confirmed < 0 || need.confirmed > need.quantity) fail(400, 'invalid_event_quantity');
    exact(need.languages, ['fr', 'en']);
    if (!LANGUAGES.has(need.languages.fr) || !LANGUAGES.has(need.languages.en)) fail(400, 'invalid_event_languages');
    return { id: need.id, role: need.role, quantity: need.quantity, confirmed: need.confirmed,
      languages: { fr: need.languages.fr, en: need.languages.en }, skills: privateText(need.skills, 180), overrides: instructions(need.overrides, true) };
  });
  const data = { title: privateText(input.title, 80, true), cityId: city.id, timezone: city.timezone, venue: privateText(input.venue, 120, true),
    startLocal: input.startLocal, endLocal: input.endLocal, common: instructions(input.common), needs };
  if (Buffer.byteLength(JSON.stringify(data)) > EVENT_PLAN_LIMITS.textBytes) fail(400, 'event_plan_too_large');
  return { data, startsAt, endsAt };
}
const fingerprint = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

/** Private preparation only. No publication, candidate identities, invitations,
 * agreements, notifications or writes to the public feed. The authenticated
 * boundary supplies userId and enforces rules consent for create/update.
 * All instances for one database must use the same capacity limits.
 */
export class EventPlanStore {
  #db; #clock; #beforeMutation; #limits;
  constructor({ db, clock = Date.now, beforeMutation = () => {}, maxPlansPerUser = EVENT_PLAN_LIMITS.activePerUser,
    maxRecordsPerUser = EVENT_PLAN_LIMITS.recordsPerUser, maxTotalRecords = EVENT_PLAN_LIMITS.totalRecords } = {}) {
    if (!db || typeof db.prepare !== 'function' || typeof clock !== 'function' || typeof beforeMutation !== 'function') throw new TypeError('Database, clock and mutation guard required');
    for (const [value, ceiling] of [[maxPlansPerUser, 20], [maxRecordsPerUser, 1000], [maxTotalRecords, 100000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new TypeError('Invalid event plan capacity');
    }
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1 ||
      !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auth_users'").get()) throw new TypeError('Existing accounts and foreign keys required');
    this.#db = db; this.#clock = clock; this.#beforeMutation = beforeMutation; this.#limits = { maxPlansPerUser, maxRecordsPerUser, maxTotalRecords };
    db.exec(`CREATE TABLE IF NOT EXISTS app_event_plans (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision>=1), create_fingerprint TEXT NOT NULL,
      data TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)),
      CHECK((deleted=0 AND data IS NOT NULL) OR (deleted=1 AND data IS NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS app_event_plans_owner ON app_event_plans(owner_id,deleted,starts_at,id);`);
  }
  #now() { const now = this.#clock(); if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999) throw new TypeError('Invalid clock'); return now; }
  #owner(userId) { if (typeof userId !== 'string' || !UUID.test(userId) || !this.#db.prepare('SELECT 1 FROM auth_users WHERE id=?').get(userId)) fail(401, 'login_required'); }
  #transaction(operation) {
    this.#beforeMutation();
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#db.exec('COMMIT'); return result; }
    catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
  }
  #row(userId, planId, includeDeleted = false) {
    const row = this.#db.prepare('SELECT * FROM app_event_plans WHERE id=? AND owner_id=?').get(id(planId), userId);
    if (!row || (row.deleted && !includeDeleted)) fail(404, 'event_plan_not_found');
    return row;
  }
  #view(row) {
    const data = JSON.parse(row.data), quantity = data.needs.reduce((total, need) => total + need.quantity, 0),
      confirmed = data.needs.reduce((total, need) => total + need.confirmed, 0);
    return { id: row.id, revision: row.revision, ...data, startsAt: row.starts_at, endsAt: row.ends_at,
      createdAt: row.created_at, updatedAt: row.updated_at, visibility: 'private', confirmedMode: 'manual',
      totals: { quantity, confirmed, remaining: quantity - confirmed } };
  }
  #expected(row, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail(400, 'invalid_event_plan_revision');
    if (expectedRevision !== row.revision) fail(409, 'event_plan_changed');
    if (row.revision === Number.MAX_SAFE_INTEGER) fail(409, 'event_plan_revision_exhausted');
  }
  #future(startsAt, now) { if (startsAt <= now || startsAt > now + EVENT_PLAN_LIMITS.futureDays * DAY) fail(400, 'event_start_out_of_range'); }
  get(userId, planId) { this.#owner(userId); return { plan: this.#view(this.#row(userId, planId)) }; }
  list(userId) {
    this.#owner(userId);
    return { plans: this.#db.prepare('SELECT * FROM app_event_plans WHERE owner_id=? AND deleted=0 ORDER BY starts_at,id').all(userId).map(row => this.#view(row)) };
  }
  create(userId, input) {
    this.#owner(userId); fields(input, ['id', 'title', 'cityId', 'timezone', 'venue', 'startLocal', 'endLocal', 'common', 'needs']);
    const planId = id(input.id), { id: ignored, ...payload } = input, valid = validate(payload), hash = fingerprint(valid.data);
    return this.#transaction(() => {
      this.#owner(userId);
      const prior = this.#db.prepare('SELECT * FROM app_event_plans WHERE id=?').get(planId);
      if (prior) {
        if (prior.owner_id !== userId) fail(404, 'event_plan_not_found');
        if (prior.create_fingerprint !== hash) fail(409, 'event_plan_idempotency_conflict');
        if (prior.deleted) fail(410, 'event_plan_deleted');
        return { plan: this.#view(prior), replayed: true };
      }
      const now = this.#now(); this.#future(valid.startsAt, now);
      if (this.#db.prepare('SELECT COUNT(*) n FROM app_event_plans WHERE owner_id=? AND deleted=0').get(userId).n >= this.#limits.maxPlansPerUser) fail(429, 'event_plan_capacity_reached');
      if (this.#db.prepare('SELECT COUNT(*) n FROM app_event_plans WHERE owner_id=?').get(userId).n >= this.#limits.maxRecordsPerUser ||
        this.#db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n >= this.#limits.maxTotalRecords) fail(429, 'event_plan_idempotency_capacity_reached');
      this.#db.prepare('INSERT INTO app_event_plans(id,owner_id,revision,create_fingerprint,data,starts_at,ends_at,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?,?)')
        .run(planId, userId, hash, JSON.stringify(valid.data), valid.startsAt, valid.endsAt, now, now);
      return { plan: this.#view(this.#row(userId, planId)), replayed: false };
    });
  }
  update(userId, planId, input) {
    this.#owner(userId); id(planId);
    fields(input, ['expectedRevision', 'title', 'cityId', 'timezone', 'venue', 'startLocal', 'endLocal', 'common', 'needs']);
    const { expectedRevision, ...payload } = input, valid = validate(payload);
    return this.#transaction(() => {
      this.#owner(userId); const row = this.#row(userId, planId); this.#expected(row, expectedRevision);
      const now = this.#now(); this.#future(valid.startsAt, now);
      this.#db.prepare('UPDATE app_event_plans SET revision=revision+1,data=?,starts_at=?,ends_at=?,updated_at=? WHERE id=? AND owner_id=?')
        .run(JSON.stringify(valid.data), valid.startsAt, valid.endsAt, now, planId, userId);
      return { plan: this.#view(this.#row(userId, planId)) };
    });
  }
  delete(userId, planId, input) {
    this.#owner(userId); id(planId); exact(input, ['expectedRevision']);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail(400, 'invalid_event_plan_revision');
    return this.#transaction(() => {
      this.#owner(userId); const row = this.#row(userId, planId, true);
      if (row.deleted) return { deleted: true, id: planId, revision: row.revision };
      this.#expected(row, input.expectedRevision);
      // The bounded tombstone holds no event text, attendee or contact data.
      this.#db.prepare('UPDATE app_event_plans SET data=NULL,starts_at=0,ends_at=0,deleted=1,revision=revision+1,updated_at=? WHERE id=? AND owner_id=?')
        .run(this.#now(), planId, userId);
      return { deleted: true, id: planId, revision: row.revision + 1 };
    });
  }
}
