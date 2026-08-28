import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {presentationHeaders,readPresentationBody,sendPresentation,PRESENTATION_INPUT_LIMITS} from '../presentation-http.mjs';
const error=code=>value=>value.code===code;
const request=(chunks,headers={'content-type':'image/jpeg'})=>Object.assign(Readable.from(chunks),{headers,rawHeaders:Object.entries(headers).flat()});
test('presentation bodies reject unsupported/duplicate/encoded/oversized input and count actual bytes',async()=>{
 const input=request([Buffer.from('first'),Buffer.from('second')]);assert.equal((await readPresentationBody(input,'photo')).bytes.toString(),'firstsecond');
 assert.equal(presentationHeaders(request([],{'content-type':'video/quicktime'}),'video'),'video/quicktime');
 assert.throws(()=>presentationHeaders(request([],{'content-type':'image/svg+xml'}),'photo'),error('unsupported_presentation_type'));
 assert.throws(()=>presentationHeaders(request([],{'content-type':'image/png','content-encoding':'gzip'}),'photo'),error('unsupported_presentation_encoding'));
 assert.throws(()=>presentationHeaders(request([],{'content-type':'image/png','content-length':String(PRESENTATION_INPUT_LIMITS.photo+1)}),'photo'),error('presentation_input_too_large'));
 const duplicate=request([]);duplicate.rawHeaders.push('Content-Type','image/png');assert.throws(()=>presentationHeaders(duplicate,'photo'),error('invalid_presentation_headers'));
 await assert.rejects(readPresentationBody(request([Buffer.alloc(PRESENTATION_INPUT_LIMITS.photo),Buffer.from('x')]),'photo'),error('presentation_input_too_large'));
 await assert.rejects(readPresentationBody(request([]),'photo'),error('invalid_presentation_asset'));
});
const deliver=(headers={},method='GET')=>{
 const result={};const res={writeHead(status,headers){Object.assign(result,{status,headers});},end(bytes){result.bytes=bytes;}};
 sendPresentation({headers,method},res,{bytes:Buffer.from('0123456789'),contentType:'video/mp4'});return result;
};
test('private media ranges are single, bounded and never cached',()=>{
 for(const [range,text,contentRange] of [['bytes=2-4','234','bytes 2-4/10'],['bytes=8-99','89','bytes 8-9/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=3-','3456789','bytes 3-9/10']]) {
  const r=deliver({range});assert.equal(r.status,206);assert.equal(r.bytes.toString(),text);assert.equal(r.headers['Content-Range'],contentRange);assert.equal(r.headers['Cache-Control'],'no-store');
 }
 for(const range of ['bytes=-0','bytes=10-','bytes=5-1','bytes=0-1,3-5','bytes=-','items=1-2','bytes=90071992547409930-']) {
  const r=deliver({range});assert.equal(r.status,416);assert.equal(r.headers['Content-Range'],'bytes */10');assert.equal(r.bytes,undefined);
 }
 assert.equal(deliver({'range':'bytes=2-4','if-range':'old-validator'}).status,200);
 assert.equal(deliver({},'HEAD').bytes,undefined);assert.equal(deliver().headers['Cross-Origin-Resource-Policy'],'same-origin');
});
