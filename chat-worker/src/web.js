// web.js: general web context for concepts the site mentions but doesn't explain (STIG, SCAP, RAG, ...).
// Web results explain concepts only; they are never a source of facts about Jayce (enforced in the
// orchestrator, the writer prompt and the supervisor). Results are sanitized, capped, cached for 24 h in KV,
// and wrapped as untrusted data. Without a TAVILY_API_KEY secret the worker is simply off.
import { CONFIG, redact } from './config.js';
import { hash } from './starters.js';

// Names and handles that must never reach a search engine: the web is not asked about Jayce.
const PERSONAL = /\b(jayce|parabellum|nhan|jayceparabellum|teos)\b/gi;

// A short, de-personalized concept query, or null when nothing searchable is left.
export function cleanWebQuery(q) {
  if (!q) return null;
  const words = redact(q).replace(PERSONAL, ' ').replace(/\[(email|number)\]/g, ' ')
    .replace(/[^\p{L}\p{N}\s/+.#-]/gu, ' ').split(/\s+/).filter(Boolean);
  const out = words.slice(0, CONFIG.WEB_QUERY_MAX_WORDS).join(' ').trim();
  return out.length >= 2 ? out : null;
}

// Strip tags, scripts and control characters; collapse whitespace; cap length.
export function sanitizeExcerpt(s, max = CONFIG.WEB_EXCERPT_CHARS) {
  const text = String(s ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + '…' : text;
}

const safeUrl = u => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

// Returns { results: [{url, title, text}], cached, ms } or { results: [], error } (never throws).
export async function webSearch(query, env, { signal } = {}) {
  const t0 = Date.now();
  const q = cleanWebQuery(query);
  if (!q) return { results: [], skipped: 'empty query', ms: 0 };
  if (!env.TAVILY_API_KEY) return { results: [], skipped: 'no key', ms: 0 };
  const key = `web:${hash(q.toLowerCase())}`;
  if (env.CHAT_CACHE) {
    const hit = await env.CHAT_CACHE.get(key, 'json').catch(() => null);
    if (hit) return { query: q, results: hit, cached: true, ms: Date.now() - t0 };
  }
  const timeout = AbortSignal.timeout(CONFIG.WEB_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query: q, search_depth: 'basic', max_results: CONFIG.WEB_MAX_RESULTS, include_answer: false, include_raw_content: false }),
    });
    if (!res.ok) return { query: q, results: [], error: `HTTP ${res.status}`, ms: Date.now() - t0 };
    const data = await res.json();
    const results = (data.results || []).map(r => ({ url: safeUrl(r.url), title: sanitizeExcerpt(r.title, 120), text: sanitizeExcerpt(r.content) }))
      .filter(r => r.url && r.text).slice(0, CONFIG.WEB_MAX_RESULTS);
    if (env.CHAT_CACHE && results.length)
      await env.CHAT_CACHE.put(key, JSON.stringify(results), { expirationTtl: CONFIG.WEB_CACHE_TTL_HOURS * 3600 }).catch(() => {});
    return { query: q, results, cached: false, ms: Date.now() - t0 };
  } catch (e) {
    return { query: q, results: [], error: e?.name === 'TimeoutError' ? 'timeout' : e?.name === 'AbortError' ? 'cancelled' : 'fetch failed', ms: Date.now() - t0 };
  }
}
