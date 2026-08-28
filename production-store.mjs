import { createHash, randomUUID } from 'node:crypto';
import { ApiError, validatePost, publicPost, fields, text, incomingMessages, validateIdempotencyKey } from './domain.mjs';
import { pointForLocation, distanceKm } from './locations.mjs';

export const PRIVATE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_REPORT_MESSAGES = 20;
const VOICE_CONTENT_TYPE = 'audio/ogg; codecs=opus';
const MAX_VOICE_BYTES = 512 * 1024;
const fail = (status, code) => { throw new ApiError(status, code); };
const parse = row => row ? JSON.parse(row.data) : null;
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, JSON.parse(canonical(value[key]))]))
  : value);

/** Account IDs are supplied only by the authenticated HTTP boundary, never from a request body. */
export class ProductionStore {
  constructor({ db, clock = Date.now, moderators = [], maxPosts = 10000, maxMessages = 200, maxIntents = 2000,
    maxThreads = 10000, maxTotalMessages = 200000, maxTotalIntents = 250000, maxThreadsPerUser = 500,
    maxReports = 5000, maxReportEvidenceBytes = 16 * 1024, maxVoicesPerThread = 20,
    maxVoiceBytesPerUser = 20 * 1024 * 1024, maxTotalVoiceBytes = 200 * 1024 * 1024,
    maxReportVoiceBytes = 50 * 1024 * 1024 } = {}) {
    // Pilot safety limits, not measured commercial capacity. All instances using
    // one database must be configured with the same limits.
    // Reports consume at most ~78 MiB of new evidence at these defaults, plus
    // row/index overhead. This is a pilot budget, not a measured service capacity.
    // Existing evidence is never shortened or evicted to satisfy a lower limit.
    const limits = { maxPosts, maxMessages, maxIntents, maxThreads, maxTotalMessages, maxTotalIntents, maxThreadsPerUser,
      maxReports, maxReportEvidenceBytes, maxVoicesPerThread, maxVoiceBytesPerUser, maxTotalVoiceBytes, maxReportVoiceBytes };
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
    }
    this.db = db; this.clock = clock; this.moderators = new Set(moderators);
    Object.assign(this, limits);
    this.listeners = new Set(); this.transactionDepth = 0; this.publicChanged = false;
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL, version INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS app_posts (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, data TEXT NOT NULL,
        lat REAL NOT NULL, lng REAL NOT NULL, expires_at INTEGER NOT NULL, retain_until INTEGER NOT NULL, expired INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE INDEX IF NOT EXISTS app_posts_local ON app_posts(expired,lat,lng,expires_at);
      CREATE INDEX IF NOT EXISTS app_posts_owner ON app_posts(owner_id,expires_at);
      CREATE TABLE IF NOT EXISTS app_threads (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES app_posts(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, guest_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        UNIQUE(post_id,guest_id)) STRICT;
      CREATE INDEX IF NOT EXISTS app_threads_owner ON app_threads(owner_id,expires_at);
      CREATE INDEX IF NOT EXISTS app_threads_guest ON app_threads(guest_id,expires_at);
      CREATE TABLE IF NOT EXISTS app_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        thread_id TEXT NOT NULL REFERENCES app_threads(id) ON DELETE CASCADE, sender TEXT NOT NULL CHECK(sender IN ('owner','guest')),
        text TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS app_messages_thread ON app_messages(thread_id,seq);
      CREATE TABLE IF NOT EXISTS app_voices (message_id TEXT PRIMARY KEY REFERENCES app_messages(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL, duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 1 AND 60000),
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 27 AND 524288)) STRICT;
      CREATE INDEX IF NOT EXISTS app_voices_sender ON app_voices(sender_id);
      CREATE TABLE IF NOT EXISTS app_intents (actor_id TEXT NOT NULL, scope TEXT NOT NULL, key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, response TEXT NOT NULL, expires_at INTEGER NOT NULL,
        reference_type TEXT, reference_id TEXT, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(actor_id,scope,key)) STRICT;
      CREATE INDEX IF NOT EXISTS app_intents_reference ON app_intents(reference_type,reference_id);
      CREATE INDEX IF NOT EXISTS app_intents_expiry ON app_intents(expires_at);
      CREATE TABLE IF NOT EXISTS app_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(blocker_id,blocked_id)) STRICT;
      CREATE TABLE IF NOT EXISTS app_reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, target_type TEXT NOT NULL,
        target_id TEXT NOT NULL, reason TEXT NOT NULL, details TEXT NOT NULL, evidence TEXT NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolved_at INTEGER, moderator_id TEXT) STRICT;
      CREATE INDEX IF NOT EXISTS app_reports_expiry ON app_reports(created_at);
      CREATE INDEX IF NOT EXISTS app_reports_reporter ON app_reports(reporter_id,created_at);
      CREATE TABLE IF NOT EXISTS app_report_subjects (report_id TEXT NOT NULL REFERENCES app_reports(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, PRIMARY KEY(report_id,user_id)) STRICT;
      CREATE INDEX IF NOT EXISTS app_report_subjects_user ON app_report_subjects(user_id,report_id);
      CREATE TABLE IF NOT EXISTS app_report_voices (report_id TEXT NOT NULL REFERENCES app_reports(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, duration_ms INTEGER NOT NULL CHECK(duration_ms BETWEEN 1 AND 60000),
        bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 27 AND 524288), PRIMARY KEY(report_id,message_id)) STRICT;
      CREATE TABLE IF NOT EXISTS app_suspended_users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;
    `);
    // Attribution must survive moderation or normal expiry of the target. An
    // older report can be backfilled only while its post/thread still exists.
    // Never guess ownership from message text, or silently delete old evidence.
    db.exec(`INSERT OR IGNORE INTO app_report_subjects(report_id,user_id)
      SELECT r.id,p.owner_id FROM app_reports r JOIN app_posts p ON r.target_type='post' AND r.target_id=p.id
      UNION SELECT r.id,t.owner_id FROM app_reports r JOIN app_threads t ON r.target_type='thread' AND r.target_id=t.id
      UNION SELECT r.id,t.guest_id FROM app_reports r JOIN app_threads t ON r.target_type='thread' AND r.target_id=t.id;`);
    if (db.prepare('SELECT 1 FROM app_reports r WHERE NOT EXISTS(SELECT 1 FROM app_report_subjects s WHERE s.report_id=r.id) LIMIT 1').get()) {
      throw new Error('legacy_report_attribution_required');
    }
    db.prepare('INSERT OR IGNORE INTO app_meta VALUES(1,?,0)').run(randomUUID());
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  transaction(operation) {
    if (this.transactionDepth) return operation();
    this.db.exec('BEGIN IMMEDIATE'); this.transactionDepth = 1; this.publicChanged = false;
    let result, changed;
    try {
      result = operation();
      if (result && typeof result.then === 'function') throw new Error('Transactions must be synchronous');
      changed = this.publicChanged;
      if (changed) this.db.exec('UPDATE app_meta SET version=version+1 WHERE id=1');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth = 0; this.publicChanged = false; }
    if (changed) for (const fn of this.listeners) { try { fn(); } catch { /* A dead subscriber cannot roll back a committed write. */ } }
    return result;
  }
  sweep() {
    return this.transaction(() => {
      const now = this.clock();
      const expired = this.db.prepare('UPDATE app_posts SET expired=1 WHERE expires_at<=? AND expired=0').run(now).changes;
      this.db.prepare('DELETE FROM app_posts WHERE retain_until<=?').run(now);
      this.db.prepare('DELETE FROM app_threads WHERE expires_at<=?').run(now);
      this.db.prepare('DELETE FROM app_intents WHERE expires_at<=?').run(now);
      // The existing, disclosed 30-day retention applies regardless of status.
      // Capacity pressure never advances this deadline or evicts an open report.
      this.db.prepare('DELETE FROM app_reports WHERE created_at<=?').run(now - REPORT_RETENTION_MS);
      this.publicChanged ||= expired > 0;
      return expired > 0;
    });
  }
  actor(userId) { if (typeof userId !== 'string' || !userId) fail(401, 'login_required'); }
  writer(userId) { this.actor(userId); if (this.db.prepare('SELECT id FROM app_suspended_users WHERE id=?').get(userId)) fail(403, 'account_suspended'); }
  blocked(a, b) { return Boolean(this.db.prepare('SELECT 1 FROM app_blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(a,b,b,a)); }
  cachedIntent(userId, scope, key, payload) {
    validateIdempotencyKey(key);
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
    const previous = this.db.prepare('SELECT fingerprint,response,revoked FROM app_intents WHERE actor_id=? AND scope=? AND key=? AND expires_at>?').get(userId,scope,key,this.clock());
    if (previous) {
      if (previous.revoked) fail(410,'intent_unavailable');
      if (previous.fingerprint !== fingerprint) fail(409,'idempotency_conflict');
      return JSON.parse(previous.response);
    }
    return null;
  }
  checkIntentCapacity(userId) {
    // Never evict an unexpired key: doing so could turn a retry into a duplicate.
    this.db.prepare('DELETE FROM app_intents WHERE expires_at<=?').run(this.clock());
    if (this.db.prepare('SELECT COUNT(*) AS n FROM app_intents').get().n >= this.maxTotalIntents) fail(429,'total_idempotency_capacity_reached');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM app_intents WHERE actor_id=? AND expires_at>?').get(userId,this.clock()).n;
    if (count >= this.maxIntents) fail(429,'idempotency_capacity_reached');
  }
  intent(userId, scope, key, payload, operation, retention = {}) {
    const previous = this.cachedIntent(userId,scope,key,payload);
    if (previous !== null) return previous;
    this.checkIntentCapacity(userId);
    const fingerprint = createHash('sha256').update(canonical(payload)).digest('hex');
    const response = operation();
    const metadata = typeof retention === 'function' ? retention(response) : retention;
    this.db.prepare('INSERT INTO app_intents(actor_id,scope,key,fingerprint,response,expires_at,reference_type,reference_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(userId,scope,key,fingerprint,JSON.stringify(response),metadata.expiresAt ?? this.clock()+PRIVATE_RETENTION_MS,metadata.type ?? null,metadata.id ?? null);
    return response;
  }
  postRow(id) { const row = this.db.prepare('SELECT * FROM app_posts WHERE id=? AND retain_until>?').get(id,this.clock()); if (!row) fail(404,'post_not_found'); return row; }
  livePost(id) { const row = this.postRow(id); if (row.expires_at <= this.clock()) fail(410,'post_expired'); return row; }
  state({ cityId='2988507', point, mine=false }={}, userId=null) {
    this.sweep();
    const { point: origin } = pointForLocation(cityId,point);
    if (mine) this.actor(userId);
    const rows = mine ? this.db.prepare('SELECT data FROM app_posts WHERE owner_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 201').all(userId,this.clock())
      : this.db.prepare('SELECT data FROM app_posts WHERE expired=0 AND lat BETWEEN ? AND ? AND expires_at>? ORDER BY expires_at DESC').all(origin.lat-0.23,origin.lat+0.23,this.clock());
    const candidates = rows.map(parse).filter(post => mine || (post.status==='open' && distanceKm(origin,post)<=25)).sort((a,b)=>b.createdAt-a.createdAt);
    const meta=this.db.prepare('SELECT epoch,version FROM app_meta WHERE id=1').get();
    return { posts:candidates.slice(0,200).map(publicPost), now:this.clock(), mode:'production', ...meta,
      scope:JSON.stringify({cityId,point:point??null,mine}), truncated:candidates.length>200,
      ...(userId?{ownedPostIds:this.ownership(userId),ownedPosts:this.db.prepare('SELECT data FROM app_posts WHERE owner_id=? AND expires_at>? ORDER BY expires_at DESC LIMIT 10').all(userId,this.clock()).map(parse).map(publicPost)}:{}) };
  }
  getPublicPost(id) { return { post:publicPost(parse(this.livePost(id))) }; }
  create(userId,input,key) {
    this.writer(userId); const data=validatePost(input); this.sweep();
    return this.transaction(()=>{
      const result=this.intent(userId,'create',key,data,()=>{
      if (this.db.prepare('SELECT COUNT(*) AS n FROM app_posts').get().n>=this.maxPosts) fail(429,'post_capacity_reached');
      if (this.db.prepare('SELECT COUNT(*) AS n FROM app_posts WHERE owner_id=? AND expires_at>?').get(userId,this.clock()).n>=10) fail(429,'own_post_capacity_reached');
      const now=this.clock(), id=randomUUID();
      const post={...data,id,totalPlaces:data.places,createdAt:now,updatedAt:now,expiresAt:now+data.durationMinutes*60_000,status:'open',revision:0,demo:false};
      delete post.durationMinutes;
      this.db.prepare('INSERT INTO app_posts(id,owner_id,data,lat,lng,expires_at,retain_until) VALUES(?,?,?,?,?,?,?)').run(id,userId,JSON.stringify(post),post.lat,post.lng,post.expiresAt,post.expiresAt+PRIVATE_RETENTION_MS);
      this.publicChanged=true;
      return {post:publicPost(post)};
      }, result=>({type:'post',id:result.post.id,expiresAt:result.post.expiresAt+PRIVATE_RETENTION_MS}));
      return this.getPublicPost(result.post.id);
    });
  }
  mutate(userId,id,input,key) {
    this.writer(userId); fields(input,['action']);
    if (!['fill','close','reopen'].includes(input.action)) fail(400,'invalid_action');
    return this.transaction(()=>{
      const row=this.livePost(id); if (row.owner_id!==userId) fail(403,'owner_required');
      this.intent(userId,`post:${id}`,key,input,()=>{
        const post=parse(row), action=input.action;
        if (action==='reopen') { if(post.places>=post.totalPlaces) fail(409,'no_place_to_reopen'); post.places++; post.status='open'; }
        else {
          if (post.status!=='open') fail(409,'post_already_full');
          if (action==='fill' && post.kind!=='need') fail(400,'fill_requires_need');
          post.places=action==='close'?0:post.places-1; if (!post.places) post.status='full';
        }
        post.revision++; post.updatedAt=this.clock();
        this.db.prepare('UPDATE app_posts SET data=? WHERE id=?').run(JSON.stringify(post),id); this.publicChanged=true;
        return {post:publicPost(post)};
      }, {type:'post',id,expiresAt:row.retain_until});
      return {post:publicPost(parse(this.postRow(id)))};
    });
  }
  remove(userId,id) {
    this.actor(userId);
    return this.transaction(()=>{
      const row=this.postRow(id); if(row.owner_id!==userId) fail(403,'owner_required');
      this.deletePost(id); this.publicChanged=true;
    });
  }
  contact(userId,id,input,key) {
    this.writer(userId); fields(input,['message']); const message=text(input.message,500,true); this.sweep();
    return this.transaction(()=>{
      const row=this.postRow(id);
      if(row.owner_id===userId) fail(409,'own_post_contact');
      if(this.blocked(userId,row.owner_id)) fail(403,'contact_blocked');
      const result=this.intent(userId,`contact:${id}`,key,{message},()=>{
        const previous=this.db.prepare('SELECT id FROM app_threads WHERE post_id=? AND guest_id=? AND expires_at>?').get(id,userId,this.clock());
        if(previous) return {threadId:previous.id,existing:true};
        const post=parse(this.livePost(id)); if(post.status!=='open') fail(409,'post_already_full');
        if(this.db.prepare('SELECT COUNT(*) AS n FROM app_threads WHERE post_id=?').get(id).n>=50) fail(429,'thread_capacity_reached');
        if(this.db.prepare('SELECT COUNT(*) AS n FROM app_threads').get().n>=this.maxThreads) fail(429,'total_thread_capacity_reached');
        for(const participant of [row.owner_id,userId]) {
          if(this.db.prepare('SELECT COUNT(*) AS n FROM app_threads WHERE owner_id=? OR guest_id=?').get(participant,participant).n>=this.maxThreadsPerUser) fail(429,'user_thread_capacity_reached');
        }
        if(this.db.prepare('SELECT COUNT(*) AS n FROM app_messages').get().n>=this.maxTotalMessages) fail(429,'total_message_capacity_reached');
        const threadId=randomUUID(),now=this.clock();
        this.db.prepare('INSERT INTO app_threads VALUES(?,?,?,?,?,?,?)').run(threadId,id,row.owner_id,userId,now,now,post.expiresAt+PRIVATE_RETENTION_MS);
        this.db.prepare('INSERT INTO app_messages(id,thread_id,sender,text,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),threadId,'guest',message,now);
        return {threadId,existing:false};
      }, result=>({type:'thread',id:result.threadId,expiresAt:row.retain_until}));
      this.threadAccess(userId,result.threadId);
      return result;
    });
  }
  threadAccess(userId,id) {
    this.actor(userId);
    const row=this.db.prepare('SELECT * FROM app_threads WHERE id=? AND expires_at>?').get(id,this.clock());
    if(!row) fail(404,'thread_not_found');
    if(row.owner_id!==userId && row.guest_id!==userId) fail(403,'thread_access_denied');
    return {...row,side:row.owner_id===userId?'owner':'guest'};
  }
  messages(id) {
    return this.db.prepare(`SELECT m.id,m.sender,m.text,m.created_at AS createdAt,
      v.duration_ms AS voiceDuration,length(v.bytes) AS voiceBytes
      FROM app_messages m LEFT JOIN app_voices v ON v.message_id=m.id WHERE m.thread_id=? ORDER BY m.seq`).all(id).map(message=>{
      if(message.voiceDuration!==null) message.voice={id:message.id,durationMs:message.voiceDuration,bytes:message.voiceBytes,contentType:VOICE_CONTENT_TYPE};
      delete message.voiceDuration; delete message.voiceBytes;
      return message;
    });
  }
  readThread(userId,id) {
    const row=this.threadAccess(userId,id),messages=this.messages(id);
    return {thread:{id,postId:row.post_id,side:row.side,createdAt:row.created_at,updatedAt:row.updated_at,expiresAt:row.expires_at,
      blocked:this.blocked(row.owner_id,row.guest_id),blockedByMe:Boolean(this.db.prepare('SELECT 1 FROM app_blocks WHERE blocker_id=? AND blocked_id=?').get(userId,row.side==='owner'?row.guest_id:row.owner_id)),...incomingMessages({messages},row.side),messages}};
  }
  addMessage(userId,id,input,key) {
    this.writer(userId); fields(input,['message']); const message=text(input.message,500,true); this.sweep();
    return this.transaction(()=>{
      const row=this.threadAccess(userId,id);
      return this.intent(userId,`message:${id}`,key,{message},()=>{
        if(this.blocked(row.owner_id,row.guest_id)) fail(403,'contact_blocked');
        if(this.db.prepare('SELECT COUNT(*) AS n FROM app_messages WHERE thread_id=?').get(id).n>=this.maxMessages) fail(429,'message_capacity_reached');
        if(this.db.prepare('SELECT COUNT(*) AS n FROM app_messages').get().n>=this.maxTotalMessages) fail(429,'total_message_capacity_reached');
        const msg={id:randomUUID(),sender:row.side,text:message,createdAt:this.clock()};
        this.db.prepare('INSERT INTO app_messages(id,thread_id,sender,text,created_at) VALUES(?,?,?,?,?)').run(msg.id,id,msg.sender,msg.text,msg.createdAt);
        this.db.prepare('UPDATE app_threads SET updated_at=? WHERE id=?').run(msg.createdAt,id);
        return {message:msg};
      }, {type:'thread',id,expiresAt:row.expires_at});
    });
  }
  voiceSource(input, withBytes=false) {
    // The HTTP boundary computes this digest from the original upload. Never
    // trust a client-supplied digest, and accept bytes only from the normalizer.
    fields(input,withBytes?['sourceHash','contentType','bytes','durationMs']:['sourceHash','contentType']);
    if(typeof input.sourceHash!=='string' || input.sourceHash.length!==64 || !/^[a-f0-9]{64}$/.test(input.sourceHash) ||
      !['audio/webm','audio/ogg','audio/mp4'].includes(input.contentType)) fail(400,'invalid_voice_source');
    return {sourceHash:input.sourceHash,contentType:input.contentType};
  }
  voiceWriter(userId,id) {
    this.writer(userId);
    const thread=this.threadAccess(userId,id);
    if(this.blocked(thread.owner_id,thread.guest_id)) fail(403,'contact_blocked');
    return thread;
  }
  storedVoiceResult(userId,id,result) {
    if(!this.db.prepare(`SELECT 1 FROM app_voices v JOIN app_messages m ON m.id=v.message_id
      WHERE v.message_id=? AND v.sender_id=? AND m.thread_id=?`).get(result.message.id,userId,id)) fail(410,'intent_unavailable');
    return result;
  }
  checkVoiceCapacity(userId,id,additionalBytes=1) {
    if(this.db.prepare('SELECT COUNT(*) n FROM app_messages WHERE thread_id=?').get(id).n>=this.maxMessages) fail(429,'message_capacity_reached');
    if(this.db.prepare('SELECT COUNT(*) n FROM app_messages').get().n>=this.maxTotalMessages) fail(429,'total_message_capacity_reached');
    if(this.db.prepare('SELECT COUNT(*) n FROM app_voices v JOIN app_messages m ON m.id=v.message_id WHERE m.thread_id=?').get(id).n>=this.maxVoicesPerThread) fail(429,'voice_thread_capacity_reached');
    if(this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) n FROM app_voices WHERE sender_id=?').get(userId).n+additionalBytes>this.maxVoiceBytesPerUser) fail(429,'voice_user_capacity_reached');
    if(this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) n FROM app_voices').get().n+additionalBytes>this.maxTotalVoiceBytes) fail(429,'voice_total_capacity_reached');
  }
  prepareVoice(userId,id,input,key) {
    this.writer(userId); const source=this.voiceSource(input); this.sweep();
    return this.transaction(()=>{
      this.voiceWriter(userId,id);
      const replay=this.cachedIntent(userId,`message:${id}`,key,source);
      if(replay!==null) return this.storedVoiceResult(userId,id,replay);
      this.checkIntentCapacity(userId); this.checkVoiceCapacity(userId,id);
      return null; // No reservation: final insertion rechecks access, expiry and all quotas.
    });
  }
  addVoiceMessage(userId,id,input,key) {
    this.writer(userId); const source=this.voiceSource(input,true); this.sweep();
    return this.transaction(()=>{
      const thread=this.voiceWriter(userId,id);
      const result=this.intent(userId,`message:${id}`,key,source,()=>{
        if(!Buffer.isBuffer(input.bytes) || input.bytes.length<27 || input.bytes.toString('ascii',0,4)!=='OggS' || input.bytes[4]!==0 ||
          !Number.isSafeInteger(input.durationMs) || input.durationMs<1 || input.durationMs>60000) fail(400,'invalid_voice');
        if(input.bytes.length>MAX_VOICE_BYTES) fail(413,'voice_too_large');
        this.checkVoiceCapacity(userId,id,input.bytes.length);
        const message={id:randomUUID(),sender:thread.side,text:'',createdAt:this.clock()};
        message.voice={id:message.id,durationMs:input.durationMs,bytes:input.bytes.length,contentType:VOICE_CONTENT_TYPE};
        this.db.prepare('INSERT INTO app_messages(id,thread_id,sender,text,created_at) VALUES(?,?,?,?,?)').run(message.id,id,message.sender,'',message.createdAt);
        this.db.prepare('INSERT INTO app_voices(message_id,sender_id,duration_ms,bytes) VALUES(?,?,?,?)').run(message.id,userId,input.durationMs,input.bytes);
        this.db.prepare('UPDATE app_threads SET updated_at=? WHERE id=?').run(message.createdAt,id);
        return {message};
      },{type:'thread',id,expiresAt:thread.expires_at});
      return this.storedVoiceResult(userId,id,result);
    });
  }
  getVoice(userId,messageId) {
    this.actor(userId);
    const message=this.db.prepare(`SELECT m.thread_id FROM app_voices v JOIN app_messages m ON m.id=v.message_id
      JOIN app_threads t ON t.id=m.thread_id WHERE v.message_id=? AND t.expires_at>?`).get(messageId,this.clock());
    if(!message) fail(404,'voice_not_found');
    this.threadAccess(userId,message.thread_id);
    const row=this.db.prepare('SELECT bytes,duration_ms FROM app_voices WHERE message_id=?').get(messageId);
    return {bytes:Buffer.from(row.bytes),contentType:VOICE_CONTENT_TYPE,durationMs:row.duration_ms};
  }
  getReportVoice(userId,reportId,messageId) {
    if(!this.moderators.has(userId)) fail(403,'moderator_required');
    const row=this.db.prepare(`SELECT v.bytes,v.duration_ms FROM app_report_voices v JOIN app_reports r ON r.id=v.report_id
      WHERE v.report_id=? AND v.message_id=? AND r.created_at>?`).get(reportId,messageId,this.clock()-REPORT_RETENTION_MS);
    if(!row) fail(404,'voice_not_found');
    return {bytes:Buffer.from(row.bytes),contentType:VOICE_CONTENT_TYPE,durationMs:row.duration_ms};
  }
  updates(userId, { cursor } = {}) {
    this.actor(userId); this.sweep();
    let before=Number.MAX_SAFE_INTEGER,beforeId='~';
    if(cursor !== undefined && cursor !== null) {
      if(typeof cursor!=='string' || cursor.length>180) fail(400,'invalid_cursor');
      try { const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString()); before=parsed[0];beforeId=parsed[1]; } catch { fail(400,'invalid_cursor'); }
      if(!Number.isSafeInteger(before)||before<0||typeof beforeId!=='string'||!/^[a-f0-9-]{36}$/.test(beforeId)) fail(400,'invalid_cursor');
    }
    const candidates=this.db.prepare('SELECT * FROM app_threads WHERE (owner_id=? OR guest_id=?) AND expires_at>? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 201').all(userId,userId,this.clock(),before,before,beforeId);
    const rows=candidates.slice(0,200),last=rows.at(-1);
    return {threads:rows.map(row=>{
      const side=row.owner_id===userId?'owner':'guest',post=parse(this.postRow(row.post_id)),messages=this.messages(row.id);
      return {id:row.id,postId:row.post_id,side,messageCount:messages.length,...incomingMessages({messages},side),updatedAt:row.updated_at,expiresAt:row.expires_at,
        role:post.role,zoneLabel:post.zoneLabel,timezone:post.timezone,blocked:this.blocked(row.owner_id,row.guest_id)};
    }),unavailable:[],nextCursor:candidates.length>200?Buffer.from(JSON.stringify([last.created_at,last.id])).toString('base64url'):null};
  }
  ownership(userId) { this.actor(userId); return this.db.prepare('SELECT id FROM app_posts WHERE owner_id=? AND expires_at>?').all(userId,this.clock()).map(row=>row.id); }
  block(userId,threadId,blocked=true) {
    const row=this.threadAccess(userId,threadId),other=row.side==='owner'?row.guest_id:row.owner_id;
    if(typeof blocked!=='boolean') fail(400,'invalid_block');
    if(blocked) this.db.prepare('INSERT OR IGNORE INTO app_blocks VALUES(?,?,?)').run(userId,other,this.clock());
    else this.db.prepare('DELETE FROM app_blocks WHERE blocker_id=? AND blocked_id=?').run(userId,other);
    return {blocked:this.blocked(userId,other)};
  }
  reportEvidence(userId,targetType,targetId) {
    if(targetType==='post') {
      const serialized=JSON.stringify(this.getPublicPost(targetId));
      if(Buffer.byteLength(serialized,'utf8')>this.maxReportEvidenceBytes) fail(413,'report_evidence_too_large');
      return serialized;
    }
    const {messages,...metadata}=this.readThread(userId,targetId).thread;
    // Keep the first contact and a contiguous recent tail, in chronological
    // order. Omissions are explicit; individual messages are never cut mid-text.
    const selected=messages.length<=MAX_REPORT_MESSAGES?[...messages]:[messages[0],...messages.slice(-(MAX_REPORT_MESSAGES-1))];
    while(true) {
      const serialized=JSON.stringify({thread:{...metadata,messages:selected},excerpt:{
        strategy:'first_contact_and_recent_messages',totalMessages:messages.length,
        includedMessages:selected.length,omittedMessages:messages.length-selected.length,truncated:selected.length<messages.length,
      }});
      if(Buffer.byteLength(serialized,'utf8')<=this.maxReportEvidenceBytes) return serialized;
      // If even the essential first/last messages and metadata cannot fit, fail
      // visibly and atomically instead of recording misleading empty evidence.
      if(selected.length<=2) fail(413,'report_evidence_too_large');
      selected.splice(1,1);
    }
  }
  report(userId,input,key) {
    this.actor(userId); fields(input,['targetType','targetId','reason','details']);
    if(!['post','thread'].includes(input.targetType) || typeof input.targetId!=='string' || input.targetId.length>80 || !['spam','harassment','unsafe','other'].includes(input.reason)) fail(400,'invalid_report');
    const details=text(input.details,500),targetId=input.targetId;
    // Authorize before looking up cached intents, but avoid loading a whole
    // private conversation when capacity would reject a new report anyway.
    if(input.targetType==='post') this.livePost(targetId); else this.threadAccess(userId,targetId);
    return this.transaction(()=>this.intent(userId,'report',key,{...input,details},()=>{
      this.db.prepare('DELETE FROM app_reports WHERE created_at<=?').run(this.clock()-REPORT_RETENTION_MS);
      if(this.db.prepare('SELECT COUNT(*) AS n FROM app_reports').get().n>=this.maxReports) fail(429,'total_report_capacity_reached');
      if(this.db.prepare("SELECT COUNT(*) AS n FROM app_reports WHERE reporter_id=? AND created_at>?").get(userId,this.clock()-24*60*60_000).n>=10) fail(429,'report_capacity_reached');
      const evidence=this.reportEvidence(userId,input.targetType,targetId);
      // Copy only voices actually retained by the bounded text/metadata excerpt.
      // Keep blobs separate: neither evidence JSON nor intents contain audio bytes.
      const voices=input.targetType==='thread'?JSON.parse(evidence).thread.messages.filter(message=>message.voice).map(message=>message.voice.id):[];
      let incomingVoiceBytes=0;
      for(const messageId of voices) {
        const voice=this.db.prepare(`SELECT length(v.bytes) n FROM app_voices v JOIN app_messages m ON m.id=v.message_id
          WHERE v.message_id=? AND m.thread_id=?`).get(messageId,targetId);
        if(!voice) fail(500,'report_voice_unavailable');
        incomingVoiceBytes+=voice.n;
      }
      if(incomingVoiceBytes>0 && this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) n FROM app_report_voices').get().n+incomingVoiceBytes>this.maxReportVoiceBytes) fail(429,'report_voice_capacity_reached');
      const id=randomUUID();
      this.db.prepare('INSERT INTO app_reports(id,reporter_id,target_type,target_id,reason,details,evidence,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,userId,input.targetType,targetId,input.reason,details,evidence,this.clock());
      const target=input.targetType==='post'?this.postRow(targetId):this.threadAccess(userId,targetId);
      const subjects=new Set(input.targetType==='post'?[target.owner_id]:[target.owner_id,target.guest_id]);
      for(const subject of subjects) this.db.prepare('INSERT INTO app_report_subjects(report_id,user_id) VALUES(?,?)').run(id,subject);
      for(const messageId of voices) this.db.prepare(`INSERT INTO app_report_voices(report_id,message_id,duration_ms,bytes)
        SELECT ?,message_id,duration_ms,bytes FROM app_voices WHERE message_id=?`).run(id,messageId);
      return {id,status:'open'};
    }));
  }
  listReports(userId) { if(!this.moderators.has(userId)) fail(403,'moderator_required'); return this.db.prepare("SELECT * FROM app_reports WHERE status='open' ORDER BY created_at LIMIT 100").all(); }
  resolveReport(userId,id,action) {
    if(!this.moderators.has(userId)) fail(403,'moderator_required');
    if(!['dismiss','remove'].includes(action)) fail(400,'invalid_action');
    return this.transaction(()=>{
      const report=this.db.prepare('SELECT * FROM app_reports WHERE id=?').get(id); if(!report) fail(404,'report_not_found');
      if(report.status!=='open') return {id,status:report.status};
      if(action==='remove') {
        if(report.target_type==='post') { this.deletePost(report.target_id); this.publicChanged=true; }
        else this.deleteThread(report.target_id);
      }
      const status=action==='dismiss'?'dismissed':'removed';
      this.db.prepare('UPDATE app_reports SET status=?,resolved_at=?,moderator_id=? WHERE id=?').run(status,this.clock(),userId,id);
      return {id,status};
    });
  }
  revokeIntents(type,id) {
    // Keep a content-free tombstone until the retry deadline: a stale retry
    // must never claim success or recreate content removed by its participants.
    this.db.prepare("UPDATE app_intents SET response='{}',revoked=1 WHERE reference_type=? AND reference_id=?").run(type,id);
  }
  deleteThread(id) {
    this.revokeIntents('thread',id);
    this.db.prepare('DELETE FROM app_threads WHERE id=?').run(id);
  }
  deletePost(id) {
    for(const thread of this.db.prepare('SELECT id FROM app_threads WHERE post_id=?').all(id)) this.deleteThread(thread.id);
    this.revokeIntents('post',id);
    this.db.prepare('DELETE FROM app_posts WHERE id=?').run(id);
  }
  eraseAccountData(userId) {
    this.actor(userId);
    this.transaction(()=>{
      const posts=this.db.prepare('SELECT id FROM app_posts WHERE owner_id=?').all(userId);
      const threads=this.db.prepare('SELECT id FROM app_threads WHERE owner_id=? OR guest_id=?').all(userId,userId);
      // Account erasure includes reports about its posts/conversations. Ordinary
      // moderation removals keep report evidence for the separate 30-day deadline.
      // Use the original attribution even if the target has already disappeared.
      this.db.prepare('DELETE FROM app_reports WHERE reporter_id=? OR id IN (SELECT report_id FROM app_report_subjects WHERE user_id=?)').run(userId,userId);
      for(const {id} of threads) {
        this.db.prepare("DELETE FROM app_reports WHERE target_type='thread' AND target_id=?").run(id);
        this.deleteThread(id);
      }
      for(const {id} of posts) {
        this.db.prepare("DELETE FROM app_reports WHERE target_type='post' AND target_id=?").run(id);
        this.deletePost(id);
      }
      this.db.prepare('DELETE FROM app_intents WHERE actor_id=?').run(userId);
      this.db.prepare('DELETE FROM app_blocks WHERE blocker_id=? OR blocked_id=?').run(userId,userId);
      this.db.prepare('DELETE FROM app_reports WHERE reporter_id=?').run(userId);
      this.db.prepare('DELETE FROM app_suspended_users WHERE id=?').run(userId);
      this.publicChanged ||= posts.length>0;
    });
  }
}
