// Hybrid retrieval: BM25 + dense (BGE on Workers AI) -> reciprocal rank fusion -> cross-encoder rerank.
// Every stage degrades gracefully: without the AI binding (e.g. plain local dev) it runs BM25-only.
import { buildBm25, searchBm25, rrf, cosine } from '../../assets/rag-core.js';

import { CONFIG } from './config.js';

export const EMBED_MODEL = CONFIG.EMBED_MODEL;
export const RERANK_MODEL = CONFIG.RERANK_MODEL;
// BGE v1.5 recommends this instruction on short retrieval queries (not on passages).
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

const { RETRIEVAL_TOP_K: CANDIDATES, RERANK_TOP_N: FINAL_K, MIN_RERANK, MIN_KEEP } = CONFIG;
// Broad "what's his stack / which tools" questions should always see the skills inventory.
export const SKILLS_QUERY = /\b(tech(nical)?[- ]?stack|stack|tools?|toolset|skills?|languages?|frameworks?|technologies|proficien\w*|expertise)\b/i;

export function createRetriever(kb) {
  const chunks = kb.chunks;
  const bm25 = buildBm25(chunks);
  let vectors = null; // per-isolate cache of passage embeddings (a promise, so concurrent requests share one load)

  // Load order: isolate memory -> KV (one ~170 KB read, keyed by KB version) -> compute and store in KV.
  function passageVectors(ai, kv) {
    return (vectors ??= loadVectors(ai, kv).catch(e => { vectors = null; throw e; }));
  }
  // Incremental: vectors are stored per KB version; on a new version, chunks whose content hash is
  // unchanged reuse the previous version's vectors and only edited or new chunks are embedded.
  async function loadVectors(ai, kv) {
    const key = `emb:${kb.version}:${EMBED_MODEL}`;
    const unpack = (buf, n) => { const all = new Float32Array(buf), dim = all.length / n; return Array.from({ length: n }, (_, i) => all.subarray(i * dim, (i + 1) * dim)); };
    if (kv) {
      try {
        const buf = await kv.get(key, 'arrayBuffer');
        if (buf && buf.byteLength === 4 * CONFIG.EMBED_DIM * chunks.length) return unpack(buf, chunks.length);
      } catch { /* fall through */ }
    }
    const out = new Array(chunks.length);
    let reused = 0;
    if (kv) {
      try {
        const prev = await kv.get(`emb:latest:${EMBED_MODEL}`, 'json');
        const buf = prev && await kv.get(prev.key, 'arrayBuffer');
        if (buf) {
          const old = unpack(buf, prev.hashes.length), byHash = new Map(prev.hashes.map((h, i) => [h, old[i]]));
          chunks.forEach((c, i) => { const v = byHash.get(c.hash); if (v) { out[i] = v; reused++; } });
        }
      } catch { /* embed everything */ }
    }
    const todo = chunks.map((c, i) => i).filter(i => !out[i]);
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      const r = await ai.run(EMBED_MODEL, { text: batch.map(j => `${chunks[j].title}. ${chunks[j].section}. ${chunks[j].text}`) });
      batch.forEach((j, k) => { out[j] = r.data[k]; });
    }
    if (kv) {
      const all = new Float32Array(chunks.length * CONFIG.EMBED_DIM);
      out.forEach((v, i) => all.set(v, i * CONFIG.EMBED_DIM));
      try {
        await kv.put(key, all.buffer, { expirationTtl: 60 * 60 * 24 * 30 });
        await kv.put(`emb:latest:${EMBED_MODEL}`, JSON.stringify({ key, hashes: chunks.map(c => c.hash) }));
      } catch { /* cache is best-effort */ }
    }
    console.log(JSON.stringify({ node: 'embed', kb: kb.version, reused, embedded: todo.length }));
    return out;
  }

  const retrieve = async function retrieve(query, env, opts = {}) {
    const t0 = Date.now();
    const trace = { mode: 'bm25', timings: {} };
    const lexical = searchBm25(bm25, query).slice(0, 20);
    let fused = lexical, dense = [];

    if (env.AI) {
      try {
        const [pv, qv] = await Promise.all([
          passageVectors(env.AI, env.CHAT_CACHE),
          opts.qv || embedQuery(env.AI, query),
        ]);
        trace.qv = qv;
        dense = pv.map((v, index) => ({ index, score: cosine(qv, v) })).sort((a, b) => b.score - a.score).slice(0, 20);
        fused = rrf([lexical, dense]);
        trace.mode = 'hybrid';
      } catch (e) { trace.denseError = String(e).slice(0, 200); }
    }
    trace.timings.retrieve_ms = Date.now() - t0;

    let ranked = fused.slice(0, CANDIDATES).map(r => ({ ...r, fused: r.score }));
    if (env.AI && ranked.length > 1) {
      const t1 = Date.now();
      try {
        const r = await env.AI.run(RERANK_MODEL, { query, contexts: ranked.map(x => ({ text: `${chunks[x.index].section}. ${chunks[x.index].text}` })) });
        const scores = new Map((r.response || []).map(x => [x.id, x.score]));
        ranked = ranked.map((x, i) => ({ ...x, rerank: scores.get(i) ?? 0 })).sort((a, b) => b.rerank - a.rerank);
        ranked = ranked.filter((x, i) => i < MIN_KEEP || x.rerank >= MIN_RERANK);
        trace.mode += '+rerank';
      } catch (e) { trace.rerankError = String(e).slice(0, 200); }
      trace.timings.rerank_ms = Date.now() - t1;
    }

    ranked = ranked.slice(0, FINAL_K);
    if (SKILLS_QUERY.test(query) && !ranked.some(x => chunks[x.index].id.startsWith('08-skills'))) {
      const pick = [...dense, ...lexical, ...chunks.map((_, index) => ({ index }))].find(r => chunks[r.index].id.startsWith('08-skills'));
      if (pick) { ranked.splice(1, 0, { ...pick, fused: pick.score ?? 0 }); ranked = ranked.slice(0, FINAL_K); trace.pinned = chunks[pick.index].id; }
    }

    const lexRank = new Map(lexical.map((r, i) => [r.index, i + 1]));
    const denseRank = new Map(dense.map((r, i) => [r.index, i + 1]));
    const sources = ranked.map(x => {
      const c = chunks[x.index];
      return {
        id: c.id, kind: 'site', hash: c.hash, title: c.title, section: c.section, url: c.url, text: c.text,
        scores: { bm25_rank: lexRank.get(x.index) ?? null, dense_rank: denseRank.get(x.index) ?? null,
          rrf: dense.length ? +x.fused.toFixed(4) : null, rerank: x.rerank != null ? +x.rerank.toFixed(3) : null },
      };
    });
    return { sources, trace };
  };
  // Warm-up: load passage embeddings into this isolate before the visitor's first question.
  retrieve.warm = env => (env.AI ? passageVectors(env.AI, env.CHAT_CACHE).then(v => v.length) : Promise.resolve(0));
  return retrieve;
}

export const embedQuery = (ai, query) => ai.run(EMBED_MODEL, { text: [QUERY_INSTRUCTION + query] }).then(r => r.data[0]);
