import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {lstat,mkdtemp,open,realpath,rename,link,unlink,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pullBackup} from './backup-pull.mjs';
import {runPullJob,checkPullJob} from './backup-pull-job.mjs';
import {backupKey,decryptBackup} from './backup-crypto.mjs';
import {ErasureJournal,ERASURE_JOURNAL_MAX_BYTES} from '../erasure-journal.mjs';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NAME=/^snapshot-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tseb$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TWO_HOURS=7200000;
function fail(code){throw Object.assign(new Error(code),{code});}
function stamp(name){const match=NAME.exec(name??'');if(!match)return NaN;const iso=match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/,'T$1:$2:$3Z'),at=Date.parse(iso);return Number.isFinite(at)&&new Date(at).toISOString().replace('.000Z','Z')===iso?at:NaN;}
function validTip(tip){return tip&&Object.keys(tip).sort().join(',')==='epoch,hash,journalId,seq'&&UUID.test(tip.epoch)&&UUID.test(tip.journalId)&&Number.isSafeInteger(tip.seq)&&tip.seq>=0&&/^[a-f0-9]{64}$/.test(tip.hash);}
function validPoint(point){return point&&Object.keys(point).sort().join(',')==='bytes,filename,sha256'&&Number.isFinite(stamp(point.filename))&&Number.isSafeInteger(point.bytes)&&point.bytes>=36&&point.bytes<=ERASURE_JOURNAL_MAX_BYTES+36&&/^[a-f0-9]{64}$/.test(point.sha256);}
function validate(pin){
  if(!pin||Object.keys(pin).sort().join(',')!=='point,previous,tip,verifiedAt,version'||pin.version!==1||!validTip(pin.tip))fail('erasure_pin_invalid');
  if(pin.point===null){if(pin.verifiedAt!==null||pin.tip.seq!==0||pin.previous!==null)fail('erasure_pin_invalid');}
  else if(!validPoint(pin.point)||!Number.isSafeInteger(pin.verifiedAt)||pin.verifiedAt<0||(pin.previous!==null&&(!validPoint(pin.previous)||stamp(pin.previous.filename)>=stamp(pin.point.filename))))fail('erasure_pin_invalid');
  return pin;
}
async function location(filename){
  if(typeof filename!=='string'||!path.isAbsolute(filename)||/[\x00-\x1f\x7f]/.test(filename)||filename.split('/').includes('..'))fail('erasure_pin_path');
  const dir=await realpath(path.dirname(filename)),file=path.join(dir,path.basename(filename));
  if(file===ROOT||file.startsWith(ROOT+path.sep))fail('private_path_inside_source');
  const info=await lstat(dir);if(!info.isDirectory()||(info.mode&0o777)!==0o700||info.uid!==process.getuid())fail('erasure_pin_path');
  return {file,dir,dev:info.dev,ino:info.ino};
}
async function readPin(target){
  const handle=await open(target.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const info=await handle.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid()||info.nlink!==1||info.size>2048)fail('erasure_pin_invalid');
    const bytes=Buffer.alloc(2049),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead>2048)fail('erasure_pin_invalid');
    const text=bytes.subarray(0,bytesRead).toString('utf8').trim(),pin=JSON.parse(text);
    if(JSON.stringify(pin)!==text)fail('erasure_pin_invalid');
    return {pin:validate(pin),dev:info.dev,ino:info.ino};
  }finally{await handle.close();}
}
async function writePin(target,pin,previous){
  validate(pin);const dir=await lstat(target.dir);
  if(dir.dev!==target.dev||dir.ino!==target.ino)fail('erasure_pin_path');
  const temp=path.join(target.dir,`.erasure-pin-${randomUUID()}.tmp`),handle=await open(temp,'wx',0o600);let present=true;
  try {
    try{await handle.writeFile(JSON.stringify(pin)+'\n');await handle.sync();}finally{await handle.close();}
    const currentDir=await lstat(target.dir);if(currentDir.dev!==target.dev||currentDir.ino!==target.ino)fail('erasure_pin_path');
    if(previous){const current=await readPin(target);if(current.dev!==previous.dev||current.ino!==previous.ino)fail('erasure_pin_changed');await rename(temp,target.file);present=false;}
    else {await link(temp,target.file);await unlink(temp);present=false;}
    const directory=await open(target.dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
  }finally{if(present)await unlink(temp);}
}
export async function initializeErasurePin(pinFile,tip){
  if(!validTip(tip)||tip.seq!==0||tip.hash!==createHash('sha256').update(JSON.stringify(['thesocialextra-erasure-v1',tip.epoch,tip.journalId])).digest('hex'))fail('erasure_genesis_required');
  const target=await location(pinFile);await writePin(target,{version:1,tip,point:null,previous:null,verifiedAt:null},null);
}
async function fingerprint(filename,expectedBytes){
  const handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const info=await handle.stat();if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid()||info.nlink!==1||info.size!==expectedBytes||info.size>ERASURE_JOURNAL_MAX_BYTES+36)fail('verification_failed');
    const hash=createHash('sha256');let count=0;const buffer=Buffer.alloc(65536);
    while(true){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;count+=bytesRead;if(count>expectedBytes)fail('verification_failed');hash.update(buffer.subarray(0,bytesRead));}
    if(count!==expectedBytes)fail('verification_failed');
    return {sha256:hash.digest('hex'),dev:info.dev,ino:info.ino};
  }finally{await handle.close();}
}
async function prunePrevious(directory,point){
  if(!point)return;
  const file=path.join(directory,point.filename);let previous;
  try{previous=await fingerprint(file,point.bytes);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(previous.sha256!==point.sha256)fail('verification_failed');
  const current=await lstat(file);if(current.dev!==previous.dev||current.ino!==previous.ino)fail('erasure_inventory_changed');
  await unlink(file);
  const handle=await open(directory,'r');try{await handle.sync();}finally{await handle.close();}
}
async function verifyRetainedPoint(directory,pin,work,key){
  if(!pin.point)return;
  const file=path.join(directory,pin.point.filename),before=await fingerprint(file,pin.point.bytes);
  if(before.sha256!==pin.point.sha256)fail('verification_failed');
  const restored=path.join(work,'retained.sqlite');let journal;
  try {
    await decryptBackup(file,restored,key);
    journal=new ErasureJournal(restored,{readOnly:true});const tip=journal.verify();
    if(Object.keys(tip).some(name=>tip[name]!==pin.tip[name]))fail('verification_failed');
    const after=await fingerprint(file,pin.point.bytes);
    if(after.dev!==before.dev||after.ino!==before.ino||after.sha256!==before.sha256)fail('verification_failed');
  }finally{journal?.close();}
}

/** The generic encrypted SQLite transport is used with a dedicated journal
 * directory/key/config. This resource never enters the application's backup
 * inventory. The pin advances monotonically, before a successful job status.
 */
export async function runErasurePullJob(configFile,statusFile,pinFile,{now=Date.now,signal,transport}={}){
  return runPullJob(configFile,statusFile,{now,signal,pull:async(config,options)=>{
    const target=await location(pinFile),previous=await readPin(target);
    const result=await pullBackup(config,{...options,transport,maxStoredBytes:64*1024**2,pruneExpired:false});
    const at=now(),snapshotAt=stamp(result.filename);
    if(!Number.isSafeInteger(at)||!Number.isFinite(snapshotAt)||snapshotAt>at+300000||at-snapshotAt>TWO_HOURS||result.bytes>ERASURE_JOURNAL_MAX_BYTES+36)fail('snapshot_stale');
    if(previous.pin.point&&result.filename!==previous.pin.point.filename&&snapshotAt<=stamp(previous.pin.point.filename))fail('verification_failed');
    let work,key,journal;
    try {
      work=await mkdtemp(path.join(config.localDirectory,'.erasure-verify-'));
      key=await backupKey(config.keyFile);const restored=path.join(work,'journal.sqlite');
      await decryptBackup(path.join(config.localDirectory,result.filename),restored,key);
      journal=new ErasureJournal(restored,{readOnly:true});const tip=journal.verify(),before=previous.pin.tip;
      if(tip.epoch!==before.epoch||tip.journalId!==before.journalId||tip.seq<before.seq||journal.hashAt(before.seq)!==before.hash)fail('verification_failed');
      if(signal?.aborted)fail('pull_interrupted');
      const point={filename:result.filename,bytes:result.bytes,sha256:(await fingerprint(path.join(config.localDirectory,result.filename),result.bytes)).sha256};
      const same=previous.pin.point?.filename===point.filename;
      if(same&&(previous.pin.point.sha256!==point.sha256||previous.pin.point.bytes!==point.bytes))fail('verification_failed');
      // B becomes the retained previous point when C arrives. Do not discard
      // the older verified A if B has disappeared or suffered local corruption.
      // The same-file retry was already decrypted and hash-checked above.
      if(!same)await verifyRetainedPoint(config.localDirectory,previous.pin,work,key);
      if(signal?.aborted)fail('pull_interrupted');
      await writePin(target,{version:1,tip,point,previous:same?previous.pin.previous:previous.pin.point,verifiedAt:at},previous);
      if(!same)await prunePrevious(config.localDirectory,previous.pin.previous);
      return result;
    }finally{journal?.close();key?.fill(0);if(work)await rm(work,{recursive:true,force:true});}
  }});
}

/** Attestation/freshness only; re-decrypt the retained archive before restore. */
export async function checkErasurePullJob(statusFile,pinFile,{now=Date.now}={}){
  const result=await checkPullJob(statusFile,{now});if(!result.ok)return result;
  try {
    const {pin}=await readPin(await location(pinFile)),point=result.status.point;
    if(!pin.point||pin.point.filename!==point.filename||pin.point.bytes!==point.bytes||pin.verifiedAt>result.status.finishedAt||now()-point.snapshotAt>TWO_HOURS)fail('erasure_point_stale_or_mismatched');
    return {...result,tip:pin.tip,completeAfterHostLoss:false};
  }catch{return {ok:false,error:'erasure_point_stale_or_mismatched',status:result.status};}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),controller=new AbortController();
  process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  let result;
  if(args[0]==='--check'&&args.length===3)result=await checkErasurePullJob(args[1],args[2]);
  else if(args.length===3){result=await runErasurePullJob(...args,{signal:controller.signal});if(result.ok)result=await checkErasurePullJob(args[1],args[2]);}
  else result={ok:false,error:'usage_config_status_pin_or_check_status_pin'};
  console.log(JSON.stringify(result));process.exitCode=result.ok?0:1;
}
