// config.js: every tunable in one place (Build Plan §6). Nodes import from here; nothing is hard-coded in them.
export const CONFIG = {
  // Site retrieval (in-Worker hybrid BM25 + BGE dense, fused with RRF, then BGE reranker)
  RETRIEVAL_TOP_K: 20,          // fused candidates sent to the reranker
  RERANK_TOP_N: 5,              // passages given to the writer
  MIN_RERANK: 0.02,             // drop passages the reranker considers irrelevant...
  MIN_KEEP: 3,                  // ...but always keep the top few

  // Semantic cache (D1, scoped to one visit)
  CACHE_SIMILARITY_THRESHOLD: 0.95,
  CACHE_TTL_HOURS: 72,          // capped by the visit itself: rows are scoped to the thread
  STARTER_TTL_HOURS: 24 * 7,    // KV cache for the fixed starter chips (public, no visitor text)

  // Web worker (Tavily)
  WEB_TIMEOUT_MS: 2500,
  WEB_CACHE_TTL_HOURS: 24,
  WEB_MAX_RESULTS: 3,
  WEB_EXCERPT_CHARS: 800,
  WEB_QUERY_MAX_WORDS: 8,

  // Supervisor
  MAX_SUPERVISOR_RETRIES: 1,

  // Memory (one visit only)
  MEMORY_SUMMARY_EVERY_N_TURNS: 6,
  MEMORY_TTL_HOURS: 24,
  MEMORY_MAX_SUMMARIES: 3,

  // Abuse protection (the limits themselves are Workers Rate Limiting bindings in wrangler.toml)
  RATE_LIMIT_PER_IP_PER_MIN: 12,
  MAX_QUESTION_CHARS: 600,
  MAX_TURNS: 10,                // history messages kept (5 exchanges)
  MAX_HISTORY_MSG_CHARS: 2000,

  // Logging: visitor text is only logged for a sample of requests, and redacted.
  LOG_QUESTION_SAMPLE_RATE: 0.1,

  // Embeddings
  EMBED_MODEL: '@cf/baai/bge-base-en-v1.5',
  EMBED_DIM: 768,
  RERANK_MODEL: '@cf/baai/bge-reranker-base',
};

export const HOUR = 3600 * 1000;

// Structured JSON logs (Workers Logs picks these up). One line per event, tagged with the request id.
export function logger(requestId) {
  const base = { rid: requestId };
  return {
    info: (node, data = {}) => console.log(JSON.stringify({ ...base, level: 'info', node, ...data })),
    error: (node, e, data = {}) => console.error(JSON.stringify({ ...base, level: 'error', node, error: e?.name || 'Error', message: String(e?.message || e).slice(0, 300), ...data })),
  };
}

// Strip things that look like contact details before visitor text goes to a log or a third party.
export function redact(s) {
  return String(s)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
    .slice(0, 200);
}
