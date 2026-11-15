// Build the RAG knowledge base from knowledge/*.md.
// Writes assets/kb.json (browser fallback) and chat-worker/src/kb.generated.json (Worker bundle).
// Run after editing anything in knowledge/:   node scripts/build-kb.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chunkMarkdown } from '../assets/rag-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'knowledge');
const chunks = readdirSync(dir).filter(f => f.endsWith('.md')).sort()
  .flatMap(f => chunkMarkdown(readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n'), f));

// Content hash per chunk: unchanged chunks keep their embeddings, and cached answers citing a changed chunk are dropped.
for (const c of chunks) c.hash = createHash('sha256').update(`${c.title}\n${c.section}\n${c.text}`).digest('hex').slice(0, 12);

// Guardrail: the KB is public. Fail the build if anything that looks private slipped in.
const PRIVATE = [/\(\d{3}\)\s?\d{3}-\d{4}/, /\b\d{3}-\d{3}-\d{4}\b/, /\b\d{3}-\d{2}-\d{4}\b/, /\b\d{3,5} [NSEW]\.? \w+ (Street|St|Avenue|Ave|Road|Rd)\b/i, /\bAPT\s?#/i, /Credential ID/i];
for (const c of chunks) for (const re of PRIVATE) if (re.test(c.text)) throw new Error(`Private-looking data in ${c.id}: ${re}`);

const hash = createHash('sha256').update(JSON.stringify(chunks)).digest('hex').slice(0, 12);
const out = JSON.stringify({ version: hash, built: new Date().toISOString().slice(0, 10), chunks }, null, 1);
writeFileSync(join(root, 'assets', 'kb.json'), out);
writeFileSync(join(root, 'chat-worker', 'src', 'kb.generated.json'), out);
console.log(`KB ${hash}: ${chunks.length} chunks from ${new Set(chunks.map(c => c.title)).size} files`);
