import { createCipheriv,createDecipheriv,randomBytes,randomUUID } from 'node:crypto';
import { createReadStream,createWriteStream } from 'node:fs';
import { appendFile,link,lstat,mkdir,open,readFile,unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC=Buffer.from('TSEBKP01'),HEADER_BYTES=20,TAG_BYTES=16,MAX_BYTES=2*1024**3;
async function regular(filename) {
  if(!path.isAbsolute(filename))throw new Error('An absolute path is required');
  const info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink())throw new Error('A regular file is required');
  return info;
}
export async function backupKey(filename,{create=false}={}) {
  if(!path.isAbsolute(filename))throw new Error('An absolute key path is required');
  if(create) {
    await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
    let handle;
    try {handle=await open(filename,'wx',0o600);await handle.writeFile(randomBytes(32));await handle.sync();}
    catch(error){if(error.code!=='EEXIST')throw error;}
    finally{await handle?.close();}
  }
  const info=await regular(filename);
  if(info.mode&0o077)throw new Error('Backup key must not be accessible to group or others');
  const key=await readFile(filename);
  if(key.length!==32)throw new Error('Expected a 256-bit backup key');
  return key;
}
async function temporary(destination) {
  if(!path.isAbsolute(destination))throw new Error('An absolute output path is required');
  await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
  const filename=path.join(path.dirname(destination),`.backup-${randomUUID()}.partial`);
  const handle=await open(filename,'wx',0o600);await handle.close();return filename;
}
async function commit(temporary,destination) {
  const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
  // Hard-link creation is exclusive: never overwrite an existing recovery point.
  await link(temporary,destination);await unlink(temporary);
}
export async function encryptBackup(source,destination,key) {
  if(!Buffer.isBuffer(key)||key.length!==32)throw new Error('Expected a 256-bit backup key');
  const info=await regular(source);if(info.size>MAX_BYTES)throw new Error('Backup exceeds the configured size limit');
  const temp=await temporary(destination),nonce=randomBytes(12),header=Buffer.concat([MAGIC,nonce]);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(header);
  try {
    await appendFile(temp,header);
    await pipeline(createReadStream(source),cipher,createWriteStream(temp,{flags:'a'}));
    await appendFile(temp,cipher.getAuthTag());await commit(temp,destination);
  }catch(error){await unlink(temp).catch(()=>{});throw error;}
}
export async function decryptBackup(source,destination,key) {
  if(!Buffer.isBuffer(key)||key.length!==32)throw new Error('Expected a 256-bit backup key');
  const info=await regular(source);if(info.size<HEADER_BYTES+TAG_BYTES||info.size>MAX_BYTES+HEADER_BYTES+TAG_BYTES)throw new Error('Invalid backup size');
  const sourceHandle=await open(source,'r'),header=Buffer.alloc(HEADER_BYTES),tag=Buffer.alloc(TAG_BYTES);
  try {await sourceHandle.read(header,0,header.length,0);await sourceHandle.read(tag,0,tag.length,info.size-TAG_BYTES);}finally{await sourceHandle.close();}
  if(!header.subarray(0,8).equals(MAGIC))throw new Error('Unknown backup format');
  const temp=await temporary(destination),decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));
  decipher.setAAD(header);decipher.setAuthTag(tag);
  try {
    // Only an authenticated complete plaintext becomes the destination file.
    if(info.size===HEADER_BYTES+TAG_BYTES){decipher.final();}
    else await pipeline(createReadStream(source,{start:HEADER_BYTES,end:info.size-TAG_BYTES-1}),decipher,createWriteStream(temp));
    await commit(temp,destination);
  }catch(error){await unlink(temp).catch(()=>{});throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [operation,source,destination,keyFile]=process.argv.slice(2);
  if(process.argv.length!==6||!['encrypt','decrypt'].includes(operation))throw new Error('Usage: node ops/backup-crypto.mjs encrypt|decrypt SOURCE DESTINATION KEYFILE');
  const key=await backupKey(keyFile,{create:operation==='encrypt'});
  await (operation==='encrypt'?encryptBackup:decryptBackup)(source,destination,key);
  console.log(JSON.stringify({operation,ok:true}));
}
