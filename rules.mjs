import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const RULE_DOCUMENTS=Object.freeze([
  Object.freeze({version:'2026-08-28.1',sha256:'b840996363e54787c1705056a225587f0d929e4dfa6b29446a5b303b577f93c3',url:'/rules/2026-08-28.1.html'}),
  Object.freeze({version:'2026-08-28.2',sha256:'755bc23eb469888f9a62b6897f4f7813524699a001bd90fc990e435e41eaacd1',url:'/rules/2026-08-28.2.html'}),
]);
export const RULES=RULE_DOCUMENTS.at(-1);

export function verifyRulesDocument(bytes,version=RULES.version) {
  const document=RULE_DOCUMENTS.find(rule=>rule.version===version);
  if (!document || !Buffer.isBuffer(bytes) || createHash('sha256').update(bytes).digest('hex') !== document.sha256) {
    throw new Error('rules_document_hash_mismatch');
  }
  return Buffer.from(bytes);
}

// Verify at process startup, then serve these exact bytes even if a deployment
// changes the file on disk. A new text requires a new immutable version.
const verifiedBytes=new Map(RULE_DOCUMENTS.map(rule=>[rule.version,verifyRulesDocument(readFileSync(new URL(`./public${rule.url}`,import.meta.url)),rule.version)]));
export function rulesDocument(version=RULES.version) {
  const bytes=verifiedBytes.get(version);if(!bytes)throw new Error('unknown_rules_version');return Buffer.from(bytes);
}
