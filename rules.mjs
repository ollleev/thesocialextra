import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const RULES = Object.freeze({
  version: '2026-08-28.1',
  sha256: 'b840996363e54787c1705056a225587f0d929e4dfa6b29446a5b303b577f93c3',
  url: '/rules/2026-08-28.1.html',
});

export function verifyRulesDocument(bytes) {
  if (!Buffer.isBuffer(bytes) || createHash('sha256').update(bytes).digest('hex') !== RULES.sha256) {
    throw new Error('rules_document_hash_mismatch');
  }
  return Buffer.from(bytes);
}

// Verify at process startup, then serve these exact bytes even if a deployment
// changes the file on disk. A new text requires a new immutable version.
const verifiedBytes = verifyRulesDocument(readFileSync(new URL(`./public${RULES.url}`, import.meta.url)));
export function rulesDocument() { return Buffer.from(verifiedBytes); }
