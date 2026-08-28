// A timeout does not prove that a write was rejected by the server.
// Never retry automatically; callers retain the same intent for message retries.
export async function requestJSON(path, { method = 'GET', body, owner, chat, idempotencyKey } = {}, { fetcher = fetch, timeoutMs = 12000 } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (owner) headers['X-Owner-Token'] = owner;
  if (chat) headers['X-Chat-Token'] = chat;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: controller.signal });
    const data = response.status === 204 ? {} : await response.json();
    if (!response.ok) {
      const error = new Error(data.error || 'request_failed');
      error.code = data.error; error.status = response.status; throw error;
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) { const timeout = new Error('request_timeout'); timeout.code = 'request_timeout'; throw timeout; }
    throw error;
  } finally { clearTimeout(timer); }
}

// Drafts are confined to this page, never a URL or public snapshot.
export class MessageOutbox {
  constructor(makeKey = () => crypto.randomUUID()) { this.entries = new Map(); this.makeKey = makeKey; }
  get(id) {
    if (!this.entries.has(id)) this.entries.set(id, { draft: '', version: 0, intent: null, busy: false, error: null });
    return this.entries.get(id);
  }
  edit(id, draft) {
    const entry = this.get(id);
    if (draft !== entry.draft) { entry.draft = draft; entry.version++; }
  }
  begin(id) {
    const entry = this.get(id), text = entry.draft.trim();
    if (entry.busy || !text) return null;
    const key = entry.intent?.text === text ? entry.intent.key : this.makeKey();
    entry.intent = { text, key, version: entry.version };
    entry.busy = true; entry.error = null;
    return entry.intent;
  }
  finish(id, intent, error = null) {
    const entry = this.entries.get(id);
    if (!entry || entry.intent !== intent || !entry.busy) return false;
    entry.busy = false; entry.error = error;
    if (!error) {
      if (entry.version === intent.version) entry.draft = '';
      entry.intent = null;
    }
    return true;
  }
  retain(ids) { for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id); }
}
