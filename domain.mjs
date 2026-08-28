import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getLocation, pointForLocation, LocationError } from './locations.mjs';

export const ZONES = Object.freeze([
  { id: 'republique', label: 'République', lat: 48.8674, lng: 2.3639 },
  { id: 'bastille', label: 'Bastille', lat: 48.853, lng: 2.3691 },
  { id: 'marais', label: 'Le Marais', lat: 48.8585, lng: 2.3625 },
  { id: 'oberkampf', label: 'Oberkampf', lat: 48.865, lng: 2.3793 },
  { id: 'belleville', label: 'Belleville', lat: 48.8721, lng: 2.3834 },
  { id: 'canal', label: 'Canal Saint-Martin', lat: 48.8732, lng: 2.3638 },
  { id: 'opera', label: 'Opéra', lat: 48.8719, lng: 2.3316 },
  { id: 'montmartre', label: 'Montmartre', lat: 48.8867, lng: 2.3431 },
].map(Object.freeze));
export const ROLE_GROUPS = Object.freeze([
  { label: 'Salle & bar', roles: ['Serveur', 'Barman', 'Chef de rang', 'Maître d’hôtel'] },
  { label: 'Cuisine', roles: ['Plongeur', 'Commis', 'Cuisinier', 'Pizzaiolo', 'Pâtissier'] },
  { label: 'Événementiel & encadrement', roles: ['Traiteur', 'Manager', 'Hôte / Hôtesse'] },
].map(group => Object.freeze({ label: group.label, roles: Object.freeze(group.roles) })));
export const ROLES = Object.freeze(ROLE_GROUPS.flatMap(group => group.roles));
const DURATIONS = new Set([30, 60, 120, 240]);
const PUBLIC_FIELDS = ['id', 'kind', 'role', 'zoneId', 'zoneLabel', 'cityId', 'cityName', 'country', 'timezone', 'lat', 'lng', 'english', 'vehicle', 'createdAt', 'updatedAt', 'expiresAt', 'places', 'totalPlaces', 'pay', 'note', 'status', 'revision', 'demo'];
const MAX_ACTION_KEYS = 128;

export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new ApiError(status, code); };
const token = () => randomBytes(32).toString('hex');
function matches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length !== expected.length) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validateIdempotencyKey(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) fail(400, 'invalid_idempotency_key');
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body');
}
function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'unknown_field');
}
function text(value, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(400, 'invalid_text');
  if (required && !value.trim()) fail(400, 'message_required');
  return value.trim();
}
function validatePost(input) {
  fields(input, ['kind', 'role', 'zoneId', 'cityId', 'point', 'english', 'vehicle', 'durationMinutes', 'places', 'pay', 'note']);
  if (!['available', 'need'].includes(input.kind)) fail(400, 'invalid_kind');
  if (!ROLES.includes(input.role)) fail(400, 'invalid_role');
  let location;
  try {
    if (input.cityId !== undefined) {
      const { location: city, point } = pointForLocation(input.cityId, input.point);
      // zoneId is a legacy Paris neighborhood selector, not another geography.
      const legacy = input.point === undefined && input.cityId === '2988507' ? ZONES.find(z => z.id === input.zoneId) : null;
      if (input.zoneId !== undefined && input.zoneId !== `city-${city.id}` && !legacy) fail(400, 'invalid_zone');
      location = { zoneId: legacy?.id ?? `city-${city.id}`, zoneLabel: legacy?.label ?? city.label,
        lat: legacy?.lat ?? point.lat, lng: legacy?.lng ?? point.lng,
        cityId: city.id, cityName: city.name, country: city.country, timezone: city.timezone };
    } else {
      if (input.point !== undefined) fail(400, 'city_required_for_point');
      const zone = ZONES.find(z => z.id === input.zoneId);
      if (!zone) fail(400, 'invalid_zone');
      const city = getLocation('2988507');
      location = { zoneId: zone.id, zoneLabel: zone.label, lat: zone.lat, lng: zone.lng,
        cityId: city.id, cityName: city.name, country: city.country, timezone: city.timezone };
    }
  } catch (error) {
    if (error instanceof LocationError) fail(error.status, error.code);
    throw error;
  }
  if (!DURATIONS.has(input.durationMinutes)) fail(400, 'invalid_duration');
  if (typeof input.english !== 'boolean' || typeof input.vehicle !== 'boolean') fail(400, 'invalid_checklist');
  if (input.kind === 'need' && (!Number.isInteger(input.places) || input.places < 1 || input.places > 8)) fail(400, 'invalid_places');
  if (input.pay !== undefined && input.pay !== null && (typeof input.pay !== 'number' || !Number.isFinite(input.pay) || input.pay < 8 || input.pay > 100)) fail(400, 'invalid_pay');
  return { kind: input.kind, role: input.role, ...location,
    english: input.english, vehicle: input.vehicle, places: input.kind === 'need' ? input.places : 1,
    pay: input.pay ?? null, note: text(input.note, 180), durationMinutes: input.durationMinutes };
}
function publicPost(post) { return Object.fromEntries(PUBLIC_FIELDS.map(key => [key, post[key]])); }
function incomingMessages(thread, side) {
  let incomingCount = 0, lastIncomingId = null;
  for (const message of thread.messages) {
    if (message.sender !== side) { incomingCount++; lastIncomingId = message.id; }
  }
  return { incomingCount, lastIncomingId };
}
// Shared validation and response whitelisting for the durable account-backed store.
export { validatePost, publicPost, fields, text, incomingMessages, validateIdempotencyKey };
function threadSummary(thread, post, side) {
  return { id: thread.id, postId: post.id, side, messageCount: thread.messages.length,
    ...incomingMessages(thread, side), updatedAt: thread.updatedAt, expiresAt: post.expiresAt,
    role: post.role, zoneLabel: post.zoneLabel, timezone: post.timezone };
}
function validateAccessBatch(input) {
  fields(input, ['access']);
  if (!Array.isArray(input.access) || input.access.length > 32) fail(400, 'invalid_access_batch');
  for (const item of input.access) {
    fields(item, ['kind', 'id', 'token']);
    if (!['post', 'thread'].includes(item.kind) || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(item.id)
      || typeof item.token !== 'string' || item.token.length > 128) fail(400, 'invalid_access_batch');
  }
  return input.access;
}

/** Volatile local prototype. All access and expiry checks live here, not in the browser. */
export class LiveStore {
  constructor({ clock = Date.now, seed = true, maxPosts = 200, maxThreads = 500, maxThreadsPerPost = 20, maxMessages = 100 } = {}) {
    this.clock = clock;
    this.posts = new Map();
    this.threads = new Map();
    this.listeners = new Set();
    this.limits = { maxPosts, maxThreads, maxThreadsPerPost, maxMessages };
    if (seed) this.seed();
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() {
    const state = this.snapshot();
    for (const fn of this.listeners) fn(state);
  }
  snapshot() {
    return { posts: [...this.posts.values()].map(publicPost).sort((a, b) => b.updatedAt - a.updatedAt), now: this.clock(), mode: 'local-demo' };
  }
  sweep() {
    let changed = false;
    const now = this.clock();
    for (const [id, post] of this.posts) if (post.expiresAt <= now) { this.posts.delete(id); changed = true; }
    for (const [id, thread] of this.threads) if (!this.posts.has(thread.postId)) this.threads.delete(id);
    if (changed) this.emit();
    return changed;
  }
  state() { this.sweep(); return this.snapshot(); }
  getPost(id) {
    this.sweep();
    const post = this.posts.get(id);
    if (!post) fail(404, 'post_not_found');
    return post;
  }
  owner(post, ownerToken) { if (!matches(ownerToken, post.ownerToken)) fail(403, 'owner_required'); }
  create(input, { demo = false, ageMinutes = 0 } = {}) {
    const data = validatePost(input);
    this.sweep();
    if (this.posts.size >= this.limits.maxPosts) fail(429, 'post_capacity_reached');
    const now = this.clock();
    const post = { ...data, id: randomUUID(), ownerToken: token(), totalPlaces: data.places,
      createdAt: now - ageMinutes * 60_000, updatedAt: now - ageMinutes * 60_000,
      expiresAt: now + data.durationMinutes * 60_000, status: 'open', revision: 0, demo };
    delete post.durationMinutes;
    this.posts.set(post.id, post);
    this.emit();
    return { post: publicPost(post), ownerToken: post.ownerToken };
  }
  mutate(id, ownerToken, input, idempotencyKey) {
    fields(input, ['action']);
    if (!['fill', 'close', 'reopen'].includes(input.action)) fail(400, 'invalid_action');
    const post = this.getPost(id);
    this.owner(post, ownerToken);
    if (idempotencyKey !== undefined) {
      validateIdempotencyKey(idempotencyKey);
      const previousAction = post.completedActions?.get(idempotencyKey);
      if (previousAction) {
        if (previousAction !== input.action) fail(409, 'idempotency_conflict');
        return { post: publicPost(post) };
      }
    }
    // Reopen enables repeated cycles: never evict a completed key and risk
    // replaying an old action. Known retries above remain safe at the limit.
    if ((post.completedActions?.size || 0) >= MAX_ACTION_KEYS) fail(429, 'idempotency_capacity_reached');
    if (input.action === 'reopen') {
      if (post.places >= post.totalPlaces) fail(409, 'no_place_to_reopen');
    } else if (post.status !== 'open') fail(409, 'post_already_full');
    if (input.action === 'fill' && post.kind !== 'need') fail(400, 'fill_requires_need');
    // Synchronous check + update: no asynchronous gap can overfill or over-reopen.
    post.places = input.action === 'close' ? 0 : input.action === 'reopen' ? post.places + 1 : post.places - 1;
    post.status = post.places === 0 ? 'full' : 'open';
    post.updatedAt = this.clock();
    post.revision++;
    if (idempotencyKey !== undefined) {
      post.completedActions ??= new Map();
      post.completedActions.set(idempotencyKey, input.action);
    }
    this.emit();
    return { post: publicPost(post) };
  }
  remove(id, ownerToken) {
    const post = this.getPost(id);
    this.owner(post, ownerToken);
    this.posts.delete(id);
    for (const [threadId, thread] of this.threads) if (thread.postId === id) this.threads.delete(threadId);
    this.emit();
  }
  contact(id, input) {
    fields(input, ['message']);
    const message = text(input.message, 500, true);
    const post = this.getPost(id);
    if (post.demo) fail(409, 'demo_contact_unavailable');
    if (post.status !== 'open') fail(409, 'post_already_full');
    const count = [...this.threads.values()].filter(t => t.postId === id).length;
    if (this.threads.size >= this.limits.maxThreads || count >= this.limits.maxThreadsPerPost) fail(429, 'thread_capacity_reached');
    const now = this.clock();
    const thread = { id: randomUUID(), postId: id, guestToken: token(), createdAt: now, updatedAt: now,
      messages: [{ id: randomUUID(), sender: 'guest', text: message, createdAt: now }] };
    this.threads.set(thread.id, thread);
    return { threadId: thread.id, guestToken: thread.guestToken };
  }
  accessThread(id, chatToken) {
    this.sweep();
    const thread = this.threads.get(id);
    if (!thread) fail(404, 'thread_not_found');
    const post = this.posts.get(thread.postId);
    const sender = matches(chatToken, post.ownerToken) ? 'owner' : matches(chatToken, thread.guestToken) ? 'guest' : null;
    if (!sender) fail(403, 'thread_access_denied');
    return { thread, post, sender };
  }
  readThread(id, chatToken) {
    const { thread, post, sender } = this.accessThread(id, chatToken);
    return { thread: { id: thread.id, postId: thread.postId, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      expiresAt: post.expiresAt, side: sender, ...incomingMessages(thread, sender), messages: thread.messages.map(m => ({ ...m })) } };
  }
  updates(input) {
    const access = validateAccessBatch(input);
    this.sweep();
    const summaries = new Map(), unavailable = new Map(), available = new Set();
    const include = (thread, post, side) => {
      // The same thread may be discovered through a post and directly. A valid
      // owner capability takes precedence; a guest capability cannot demote it.
      const existing = summaries.get(thread.id);
      if (!existing || (side === 'owner' && existing.side !== 'owner')) summaries.set(thread.id, threadSummary(thread, post, side));
    };
    for (const item of access) {
      const key = `${item.kind}:${item.id}`;
      let valid = false;
      if (item.kind === 'post') {
        const post = this.posts.get(item.id);
        if (post && matches(item.token, post.ownerToken)) {
          valid = true;
          for (const thread of this.threads.values()) if (thread.postId === post.id) include(thread, post, 'owner');
        }
      } else {
        const thread = this.threads.get(item.id), post = thread ? this.posts.get(thread.postId) : null;
        const side = post && matches(item.token, post.ownerToken) ? 'owner' : thread && matches(item.token, thread.guestToken) ? 'guest' : null;
        if (thread && post && side) { valid = true; include(thread, post, side); }
      }
      if (valid) available.add(key);
      else unavailable.set(key, { kind: item.kind, id: item.id });
    }
    // Duplicate valid/invalid versions of a capability cannot make a valid one
    // look unavailable to the client. No permission reason or token is returned.
    return { threads: [...summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
      unavailable: [...unavailable.entries()].filter(([key]) => !available.has(key)).map(([, item]) => item) };
  }
  addMessage(id, chatToken, input, idempotencyKey) {
    fields(input, ['message']);
    const body = text(input.message, 500, true);
    const { thread, sender } = this.accessThread(id, chatToken);
    let scopedKey;
    if (idempotencyKey !== undefined) {
      validateIdempotencyKey(idempotencyKey);
      scopedKey = `${sender}:${idempotencyKey}`;
      const previous = thread.completedMessages?.get(scopedKey);
      if (previous) {
        if (previous.text !== body) fail(409, 'idempotency_conflict');
        return { message: { ...previous } };
      }
    }
    // Authorized retries above still work when the conversation is full. A new
    // key can be stored only alongside a new message: the same quota bounds both.
    if (thread.messages.length >= this.limits.maxMessages) fail(429, 'message_capacity_reached');
    const message = { id: randomUUID(), sender, text: body, createdAt: this.clock() };
    thread.messages.push(message);
    thread.updatedAt = message.createdAt;
    if (scopedKey !== undefined) {
      thread.completedMessages ??= new Map();
      thread.completedMessages.set(scopedKey, message);
    }
    return { message: { ...message } };
  }
  inbox(id, ownerToken) {
    const post = this.getPost(id);
    this.owner(post, ownerToken);
    return { threads: [...this.threads.values()].filter(t => t.postId === id).sort((a, b) => b.updatedAt - a.updatedAt)
      .map(t => ({ id: t.id, postId: t.postId, createdAt: t.createdAt, updatedAt: t.updatedAt,
        messageCount: t.messages.length, lastMessage: { ...t.messages.at(-1) } })) };
  }
  seed() {
    const seeds = [
      { kind: 'available', role: 'Barman', zoneId: 'republique', english: true, vehicle: true, ageMinutes: 2, note: 'Disponible pour un renfort au bar.' },
      { kind: 'available', role: 'Serveur', zoneId: 'marais', english: true, vehicle: false, ageMinutes: 5, note: 'Prêt pour le service du soir.' },
      { kind: 'available', role: 'Plongeur', zoneId: 'belleville', english: false, vehicle: true, ageMinutes: 8, note: 'Mobile dans le nord-est parisien.' },
      { kind: 'need', role: 'Serveur', zoneId: 'bastille', english: true, vehicle: false, places: 2, pay: 18, ageMinutes: 1, note: 'Renfort en salle, prise de poste dès que possible.' },
      { kind: 'need', role: 'Chef de rang', zoneId: 'opera', english: true, vehicle: false, places: 1, pay: 22, ageMinutes: 4, note: 'Une place pour le service de ce soir.' },
      { kind: 'need', role: 'Barman', zoneId: 'canal', english: false, vehicle: false, places: 1, pay: 20, ageMinutes: 6, note: 'Bar à cocktails, équipe déjà sur place.' },
    ];
    for (const { ageMinutes, ...input } of seeds) this.create({ ...input, durationMinutes: 120 }, { demo: true, ageMinutes });
  }
}
