import { createHash, randomUUID } from 'node:crypto';
import { ApiError, fields, text, validateIdempotencyKey } from './domain.mjs';
import { REPORT_RETENTION_MS } from './production-store.mjs';

// Pilot guards, not measured public capacity. The operator must budget complete
// backups, draft replacements and report evidence before enabling media routes.
export const PRESENTATION_LIMITS = Object.freeze({ photoBytes:1024**2, videoBytes:8*1024**2,
  videoDurationMs:15000, accountBytes:18*1024**2, totalBytes:64*1024**2, intents:128 });
const RETRY_MS=7*86400000;
const fail=(status,code)=>{throw new ApiError(status,code);};
const empty=()=>({bio:'',videoText:'',photoId:null,videoId:null});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Reusable presentation: private draft + explicitly published snapshot.
 * No public directory of accounts and no upload/processing endpoint is added by
 * this module. The HTTP boundary must revalidate the session after conversion.
 */
export class PresentationStore {
  constructor({db,store,clock=Date.now,maxAccountBytes=PRESENTATION_LIMITS.accountBytes,
    maxTotalBytes=PRESENTATION_LIMITS.totalBytes,maxIntents=PRESENTATION_LIMITS.intents,maxTotalIntents=100000,maxReportBytes=16*1024**2}={}) {
    if(!db||!store||typeof clock!=='function')throw new TypeError('Database, production store and clock required');
    for(const limit of [maxAccountBytes,maxTotalBytes,maxIntents,maxTotalIntents,maxReportBytes])if(!Number.isSafeInteger(limit)||limit<1)throw new TypeError('Positive limits required');
    if(store.presentations)throw new TypeError('Presentation service already attached');
    Object.assign(this,{db,store,clock,maxAccountBytes,maxTotalBytes,maxIntents,maxTotalIntents,maxReportBytes});
    db.exec(`CREATE TABLE IF NOT EXISTS app_presentations (
      user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision>=0), draft_json TEXT NOT NULL,
      published_json TEXT, publication_id TEXT, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS app_presentation_assets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES app_presentations(user_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('photo','video')), content_type TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, duration_ms INTEGER,
      bytes BLOB NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS app_presentation_assets_owner ON app_presentation_assets(user_id);
    CREATE TABLE IF NOT EXISTS app_presentation_intents (
      user_id TEXT NOT NULL REFERENCES app_presentations(user_id) ON DELETE CASCADE,
      key TEXT NOT NULL, fingerprint TEXT NOT NULL, asset_id TEXT NOT NULL,
      revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(user_id,key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS app_presentation_intents_expiry ON app_presentation_intents(expires_at);
    CREATE TABLE IF NOT EXISTS app_report_presentations (
      report_id TEXT PRIMARY KEY REFERENCES app_reports(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
      publication_id TEXT NOT NULL, snapshot_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS app_report_presentation_assets (
      report_id TEXT NOT NULL REFERENCES app_report_presentations(report_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('photo','video')), content_type TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, duration_ms INTEGER, bytes BLOB NOT NULL,
      PRIMARY KEY(report_id,kind)
    ) STRICT;`);
    store.presentations=this;
  }
  #owner(userId) {
    this.store.actor(userId);
    if(!this.db.prepare('SELECT 1 FROM auth_users WHERE id=?').get(userId))fail(401,'login_required');
  }
  sweep(now=this.clock()) {
    if(!this.store.transactionDepth)throw new Error('Presentation cleanup requires the parent transaction');
    this.db.prepare('DELETE FROM app_presentation_intents WHERE expires_at<=?').run(now);
  }
  #row(userId) {
    const row=this.db.prepare('SELECT * FROM app_presentations WHERE user_id=?').get(userId);
    return row?{revision:row.revision,draft:JSON.parse(row.draft_json),published:row.published_json?JSON.parse(row.published_json):null,publicationId:row.publication_id,updatedAt:row.updated_at}
      :{revision:0,draft:empty(),published:null,publicationId:null,updatedAt:null};
  }
  #expected(row,expectedRevision) {
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)fail(400,'invalid_presentation_revision');
    if(row.revision!==expectedRevision)fail(409,'presentation_changed');
    if(row.revision>=Number.MAX_SAFE_INTEGER)fail(409,'presentation_revision_exhausted');
  }
  #write(userId,row) {
    const revision=row.revision+1;
    this.db.prepare(`INSERT INTO app_presentations(user_id,revision,draft_json,published_json,publication_id,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,draft_json=excluded.draft_json,
      published_json=excluded.published_json,publication_id=excluded.publication_id,updated_at=excluded.updated_at`)
      .run(userId,revision,JSON.stringify(row.draft),row.published?JSON.stringify(row.published):null,row.publicationId,this.clock());
    this.#prune(userId,row);
    return revision;
  }
  #prune(userId,row) {
    const references=[...new Set([row.draft.photoId,row.draft.videoId,row.published?.photoId,row.published?.videoId].filter(Boolean))];
    if(references.length)this.db.prepare(`DELETE FROM app_presentation_assets WHERE user_id=? AND id NOT IN (${references.map(()=>'?').join(',')})`).run(userId,...references);
    else this.db.prepare('DELETE FROM app_presentation_assets WHERE user_id=?').run(userId);
  }
  #signalPublic(userId) {
    if(this.db.prepare(`SELECT 1 FROM app_posts WHERE owner_id=? AND expired=0 AND expires_at>?
      AND json_extract(data,'$.status')='open' LIMIT 1`).get(userId,this.clock()))this.store.publicChanged=true;
  }
  #assetMetadata(userId,id,kind) {
    if(!id)return null;
    const row=this.db.prepare(`SELECT kind,content_type,width,height,duration_ms,length(bytes) AS byte_length
      FROM app_presentation_assets WHERE id=? AND user_id=?`).get(id,userId);
    if(!row||row.kind!==kind)fail(500,'presentation_integrity_error');
    return {contentType:row.content_type,width:row.width,height:row.height,byteLength:row.byte_length,
      ...(kind==='video'?{durationMs:row.duration_ms}:{})};
  }
  #view(userId,data) {
    if(!data)return null;
    return {bio:data.bio,videoText:data.videoText,photo:this.#assetMetadata(userId,data.photoId,'photo'),
      video:this.#assetMetadata(userId,data.videoId,'video')};
  }
  own(userId) {
    this.#owner(userId);const row=this.#row(userId);
    return {revision:row.revision,publicationId:row.publicationId,draft:this.#view(userId,row.draft),published:this.#view(userId,row.published),
      hasDraftChanges:JSON.stringify(row.draft)!==JSON.stringify(row.published),updatedAt:row.updatedAt};
  }
  saveText(userId,input) {
    this.#owner(userId);this.store.ugcWriter(userId);fields(input,['expectedRevision','bio','videoText']);
    const bio=text(input.bio,180),videoText=text(input.videoText,500);
    return this.store.transaction(()=>{
      const row=this.#row(userId);this.#expected(row,input.expectedRevision);
      row.draft={...row.draft,bio,videoText};this.#write(userId,row);return this.own(userId);
    });
  }
  publish(userId,input) {
    this.#owner(userId);this.store.ugcWriter(userId);fields(input,['expectedRevision','publicConsent']);
    if(input.publicConsent!==true)fail(400,'presentation_public_consent_required');
    return this.store.transaction(()=>{
      const row=this.#row(userId);this.#expected(row,input.expectedRevision);
      if(!row.draft.bio&&!row.draft.photoId&&!row.draft.videoId)fail(400,'presentation_empty');
      if(row.draft.videoId&&!row.draft.videoText)fail(400,'presentation_video_text_required');
      this.#view(userId,row.draft); // Refuse a dangling or cross-account reference.
      const changed=JSON.stringify(row.published)!==JSON.stringify(row.draft);
      row.published={...row.draft};if(changed)row.publicationId=randomUUID();
      this.#write(userId,row);if(changed)this.#signalPublic(userId);
      return this.own(userId);
    });
  }
  unpublish(userId,input) {
    this.#owner(userId);fields(input,['expectedRevision']);
    return this.store.transaction(()=>{
      const row=this.#row(userId);this.#expected(row,input.expectedRevision);const wasPublic=Boolean(row.published);
      row.published=null;row.publicationId=null;this.#write(userId,row);if(wasPublic)this.#signalPublic(userId);return this.own(userId);
    });
  }
  erase(userId,input) {
    this.#owner(userId);fields(input,['expectedRevision']);
    return this.store.transaction(()=>{
      const row=this.#row(userId);this.#expected(row,input.expectedRevision);const wasPublic=Boolean(row.published);
      row.draft=empty();row.published=null;row.publicationId=null;
      // Keep a revision tombstone: an in-flight upload must not recreate an
      // erased presentation by observing a reset revision of zero.
      this.#write(userId,row);if(wasPublic)this.#signalPublic(userId);return this.own(userId);
    });
  }
  removeDraftAsset(userId,kind,input) {
    this.#owner(userId);fields(input,['expectedRevision']);if(!['photo','video'].includes(kind))fail(400,'invalid_presentation_kind');
    return this.store.transaction(()=>{
      const row=this.#row(userId);this.#expected(row,input.expectedRevision);row.draft={...row.draft,[`${kind}Id`]:null};
      this.#write(userId,row);return this.own(userId);
    });
  }
  #source(kind,input) {
    if(!['photo','video'].includes(kind)||!input||typeof input.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceHash))fail(400,'invalid_presentation_source');
    if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail(400,'invalid_presentation_revision');
    return digest([kind,input.sourceHash,input.expectedRevision]);
  }
  #retry(userId,key,fingerprint) {
    const previous=this.db.prepare('SELECT * FROM app_presentation_intents WHERE user_id=? AND key=? AND expires_at>?').get(userId,key,this.clock());
    if(!previous)return null;
    if(previous.fingerprint!==fingerprint)fail(409,'idempotency_conflict');
    if(!this.db.prepare('SELECT 1 FROM app_presentation_assets WHERE id=? AND user_id=?').get(previous.asset_id,userId))fail(410,'presentation_upload_unavailable');
    return {acceptedRevision:previous.revision,presentation:this.own(userId)};
  }
  prepareAsset(userId,kind,input,key) {
    this.#owner(userId);this.store.ugcWriter(userId);validateIdempotencyKey(key);
    const fingerprint=this.#source(kind,input),retry=this.#retry(userId,key,fingerprint);if(retry)return retry;
    this.#expected(this.#row(userId),input.expectedRevision);return null;
  }
  addAsset(userId,kind,input,key) {
    this.#owner(userId);this.store.ugcWriter(userId);validateIdempotencyKey(key);const fingerprint=this.#source(kind,input);
    const {bytes,contentType,width,height,durationMs=null}=input;
    if(!Buffer.isBuffer(bytes)||!bytes.length||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)fail(400,'invalid_presentation_asset');
    if(kind==='photo') {
      if(bytes.length>PRESENTATION_LIMITS.photoBytes)fail(413,'presentation_asset_too_large');
      if(contentType!=='image/jpeg'||width>1600||height>1600||durationMs!==null||bytes.length<4||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)fail(400,'invalid_presentation_asset');
    } else {
      if(bytes.length>PRESENTATION_LIMITS.videoBytes)fail(413,'presentation_asset_too_large');
      if(contentType!=='video/mp4'||width>1280||height>1280||!Number.isInteger(durationMs)||durationMs<1||durationMs>PRESENTATION_LIMITS.videoDurationMs||bytes.length<12||bytes.toString('ascii',4,8)!=='ftyp')fail(400,'invalid_presentation_asset');
    }
    return this.store.transaction(()=>{
      const retry=this.#retry(userId,key,fingerprint);if(retry)return retry;
      const row=this.#row(userId);this.#expected(row,input.expectedRevision);
      this.db.prepare('DELETE FROM app_presentation_intents WHERE expires_at<=?').run(this.clock());
      if(this.db.prepare('SELECT COUNT(*) n FROM app_presentation_intents WHERE user_id=?').get(userId).n>=this.maxIntents)fail(429,'presentation_intent_capacity_reached');
      if(this.db.prepare('SELECT COUNT(*) n FROM app_presentation_intents').get().n>=this.maxTotalIntents)fail(429,'presentation_total_intent_capacity_reached');
      // Account and global totals include the published version and private
      // replacements. A failed attempt never removes the previous version.
      const totals=this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) n FROM app_presentation_assets').get().n;
      const owned=this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) n FROM app_presentation_assets WHERE user_id=?').get(userId).n;
      if(owned+bytes.length>this.maxAccountBytes)fail(429,'presentation_account_capacity_reached');
      if(totals+bytes.length>this.maxTotalBytes)fail(429,'presentation_total_capacity_reached');
      if(!this.db.prepare('SELECT 1 FROM app_presentations WHERE user_id=?').get(userId)) {
        this.db.prepare('INSERT INTO app_presentations VALUES(?,0,?,NULL,NULL,?)').run(userId,JSON.stringify(empty()),this.clock());
      }
      const id=randomUUID();
      this.db.prepare('INSERT INTO app_presentation_assets VALUES(?,?,?,?,?,?,?,?,?)').run(id,userId,kind,contentType,width,height,durationMs,bytes,this.clock());
      row.draft={...row.draft,[`${kind}Id`]:id};const revision=this.#write(userId,row);
      this.db.prepare('INSERT INTO app_presentation_intents VALUES(?,?,?,?,?,?)').run(userId,key,fingerprint,id,revision,this.clock()+RETRY_MS);
      return {acceptedRevision:revision,presentation:this.own(userId)};
    });
  }
  #publicOwner(postId,viewerId) {
    const row=this.store.postRow(postId),post=JSON.parse(row.data);
    if(row.expires_at<=this.clock()||post.status!=='open'||(viewerId&&this.store.blockedBy(viewerId,row.owner_id)))fail(404,'presentation_not_found');
    return row.owner_id;
  }
  forPost(postId,viewerId=null) {
    const userId=this.#publicOwner(postId,viewerId),row=this.#row(userId);
    if(!row.published)fail(404,'presentation_not_found');return {publicationId:row.publicationId,...this.#view(userId,row.published)};
  }
  decorate(snapshot) {
    const posts=[...(snapshot.posts??[]),...(snapshot.ownedPosts??[]),...(snapshot.post?[snapshot.post]:[])];
    const ids=[...new Set(posts.filter(post=>post.status==='open'&&post.expiresAt>this.clock()).map(post=>post.id))];
    if(!ids.length)return snapshot;
    // One bounded join for at most 210 cards, not one query per account/card.
    const rows=this.db.prepare(`SELECT p.id,s.publication_id FROM app_posts p JOIN app_presentations s ON s.user_id=p.owner_id
      WHERE p.id IN (${ids.map(()=>'?').join(',')}) AND s.published_json IS NOT NULL AND s.publication_id IS NOT NULL`).all(...ids);
    const versions=new Map(rows.map(row=>[row.id,row.publication_id]));
    for(const post of posts)if(versions.has(post.id))post.presentationId=versions.get(post.id);
    return snapshot;
  }
  #asset(userId,data,kind) {
    if(!['photo','video'].includes(kind))fail(400,'invalid_presentation_kind');
    const id=data?.[`${kind}Id`];if(!id)fail(404,'presentation_asset_not_found');
    const row=this.db.prepare('SELECT * FROM app_presentation_assets WHERE id=? AND user_id=? AND kind=?').get(id,userId,kind);
    if(!row)fail(404,'presentation_asset_not_found');
    return {bytes:Buffer.from(row.bytes),contentType:row.content_type,width:row.width,height:row.height,
      ...(kind==='video'?{durationMs:row.duration_ms}:{})};
  }
  ownAsset(userId,kind,{published=false,revision}={}) {
    this.#owner(userId);const row=this.#row(userId);
    if(revision!==undefined&&revision!==row.revision)fail(404,'presentation_asset_not_found');
    return this.#asset(userId,published?row.published:row.draft,kind);
  }
  assetForPost(postId,kind,viewerId=null,publicationId) {
    const userId=this.#publicOwner(postId,viewerId),row=this.#row(userId);
    // Versioned media URLs cannot start reading a newer file halfway through
    // playback. The public token changes only on publication, never on a draft.
    if(publicationId!==undefined&&publicationId!==row.publicationId)fail(404,'presentation_asset_not_found');
    return this.#asset(userId,row.published,kind);
  }
  attachReportEvidence(reportId,postId,publicationId,viewerId) {
    if(!this.store.transactionDepth)throw new Error('Report evidence requires the parent transaction');
    const userId=this.#publicOwner(postId,viewerId),row=this.#row(userId);
    // Never substitute a different face/version for what the reporter saw.
    // The caller can refresh or explicitly report the post without media.
    if(!row.published||row.publicationId!==publicationId)fail(409,'presentation_changed');
    const report=this.db.prepare('SELECT evidence FROM app_reports WHERE id=?').get(reportId);
    if(!report)fail(404,'report_not_found');
    const evidence=JSON.stringify({...JSON.parse(report.evidence),presentation:{publicationId,...this.#view(userId,row.published)}});
    if(Buffer.byteLength(evidence)>this.store.maxReportEvidenceBytes)fail(413,'report_evidence_too_large');
    const assets=['photo','video'].filter(kind=>row.published[`${kind}Id`]).map(kind=>({kind,...this.#asset(userId,row.published,kind)}));
    const current=this.db.prepare('SELECT COALESCE(SUM(length(bytes)),0) n FROM app_report_presentation_assets').get().n;
    if(current+assets.reduce((n,asset)=>n+asset.bytes.length,0)>this.maxReportBytes)fail(429,'report_presentation_capacity_reached');
    this.db.prepare('INSERT INTO app_report_presentations VALUES(?,?,?,?)').run(reportId,userId,publicationId,JSON.stringify(row.published));
    for(const asset of assets)this.db.prepare('INSERT INTO app_report_presentation_assets VALUES(?,?,?,?,?,?,?)')
      .run(reportId,asset.kind,asset.contentType,asset.width,asset.height,asset.durationMs??null,asset.bytes);
    this.db.prepare('UPDATE app_reports SET evidence=? WHERE id=?').run(evidence,reportId);
  }
  reportAsset(moderatorId,reportId,kind) {
    if(!this.store.moderators.has(moderatorId))fail(403,'moderator_required');
    if(!['photo','video'].includes(kind))fail(400,'invalid_presentation_kind');
    const row=this.db.prepare(`SELECT a.* FROM app_report_presentation_assets a JOIN app_reports r ON r.id=a.report_id
      WHERE a.report_id=? AND a.kind=? AND r.created_at>?`).get(reportId,kind,this.clock()-REPORT_RETENTION_MS);
    if(!row)fail(404,'presentation_asset_not_found');
    return {bytes:Buffer.from(row.bytes),contentType:row.content_type,width:row.width,height:row.height,
      ...(kind==='video'?{durationMs:row.duration_ms}:{})};
  }
  removeReportedPresentation(moderatorId,reportId) {
    if(!this.store.moderators.has(moderatorId))fail(403,'moderator_required');
    if(!this.store.transactionDepth)throw new Error('Moderation requires the parent transaction');
    const proof=this.db.prepare(`SELECT p.* FROM app_report_presentations p JOIN app_reports r ON r.id=p.report_id
      WHERE p.report_id=? AND r.created_at>?`).get(reportId,this.clock()-REPORT_RETENTION_MS);
    if(!proof)fail(404,'presentation_not_found');
    const row=this.#row(proof.owner_id);
    if(row.published&&row.publicationId!==proof.publication_id)fail(409,'presentation_changed');
    const snapshot=JSON.parse(proof.snapshot_json),wasPublic=Boolean(row.published);
    // Remove matching draft references too; preserve unrelated private edits.
    for(const [field,value] of Object.entries(snapshot))if(row.draft[field]===value)row.draft[field]=empty()[field];
    row.published=null;row.publicationId=null;this.#write(proof.owner_id,row);
    if(wasPublic)this.#signalPublic(proof.owner_id);
  }
}
