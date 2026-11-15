// state.js: runtime state in D1 (Build Plan §4.1, §4.4, §5.2). Every call is best-effort: if D1 is down,
// the chat answers without cache or memory. Every query is scoped by thread_id, so one visitor's cache
// or memory is never served to another. Rows expire; the hourly cron deletes them.
import { CONFIG, HOUR } from './config.js';
import { cosine } from '../../assets/rag-core.js';

export const THREAD_RE = /^[A-Za-z0-9_-]{16,64}$/;
const id = () => crypto.randomUUID();
const toBlob = v => new Uint8Array(Float32Array.from(v).buffer);
const fromBlob = b => new Float32Array((b instanceof ArrayBuffer ? new Uint8Array(b) : Uint8Array.from(b)).buffer);

// ---- Semantic cache ----

// Nearest cached answer in this visit whose question is >= threshold similar and whose cited chunks are unchanged.
export async function cacheLookup(db, { scope, qv, chunkHash }) {
  if (!db || !scope || !qv) return null;
  const { results } = await db.prepare('SELECT question_vec, answer, meta, source_chunks FROM semantic_cache WHERE scope_key = ?1 AND expires_at > ?2 ORDER BY created_at DESC LIMIT 50')
    .bind(scope, Date.now()).all();
  let best = null;
  for (const r of results) {
    const sim = cosine(qv, fromBlob(r.question_vec));
    if (sim < CONFIG.CACHE_SIMILARITY_THRESHOLD || (best && sim <= best.sim)) continue;
    const cited = JSON.parse(r.source_chunks);
    if (cited.some(c => chunkHash.get(c.id) !== c.hash)) continue; // a cited chunk changed: stale
    best = { sim, answer: r.answer, meta: JSON.parse(r.meta) };
  }
  return best;
}

export async function cacheStore(db, { scope, question, qv, answer, meta, sources }) {
  if (!db || !scope || !qv) return;
  const now = Date.now();
  await db.prepare('INSERT INTO semantic_cache (id, scope_key, question, question_vec, answer, meta, source_chunks, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
    .bind(id(), scope, question.slice(0, 600), toBlob(qv), answer, JSON.stringify(meta), JSON.stringify(sources.filter(s => s.kind !== 'web').map(s => ({ id: s.id, hash: s.hash }))), now, now + CONFIG.CACHE_TTL_HOURS * HOUR).run();
}

// ---- Conversation memory (one visit) ----

export async function memoryLoad(db, thread) {
  if (!db || !thread) return '';
  const { results } = await db.prepare('SELECT summary FROM conversation_memory WHERE thread_id = ?1 AND expires_at > ?2 ORDER BY turn_end DESC LIMIT ?3')
    .bind(thread, Date.now(), CONFIG.MEMORY_MAX_SUMMARIES).all();
  return results.reverse().map(r => r.summary).join('\n');
}

export async function memoryStore(db, { thread, summary, turnStart, turnEnd }) {
  if (!db || !thread || !summary) return;
  const now = Date.now();
  await db.prepare('INSERT INTO conversation_memory (id, thread_id, summary, turn_start, turn_end, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id(), thread, summary, turnStart, turnEnd, now, now + CONFIG.MEMORY_TTL_HOURS * HOUR).run();
}

// ---- Feedback ----

export async function feedbackStore(db, { thread, messageId, rating, comment, question }) {
  await db.prepare('INSERT OR REPLACE INTO feedback (id, thread_id, message_id, rating, comment, question, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id(), thread, messageId, rating, comment || null, question || null, Date.now()).run();
}

// ---- Cleanup (cron) ----

export async function cleanup(db) {
  const now = Date.now();
  const r = await db.batch([
    db.prepare('DELETE FROM semantic_cache WHERE expires_at <= ?1').bind(now),
    db.prepare('DELETE FROM conversation_memory WHERE expires_at <= ?1').bind(now),
    db.prepare('DELETE FROM feedback WHERE created_at <= ?1').bind(now - 180 * 24 * HOUR), // keep votes 6 months
  ]);
  return r.map(x => x.meta?.changes ?? 0);
}
