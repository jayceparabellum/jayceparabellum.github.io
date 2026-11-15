// Hybrid retrieval: BM25 + dense (BGE on Workers AI) -> reciprocal rank fusion -> cross-encoder rerank.
// Every stage degrades gracefully: without the AI binding (e.g. plain local dev) it runs BM25-only.
import { buildBm25, searchBm25, rrf, cosine } from '../../assets/rag-core.js';

export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
export const RERANK_MODEL = '@cf/baai/bge-reranker-base';
// BGE v1.5 recommends this instruction on short retrieval queries (not on passages).
const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

const CANDIDATES = 12;     // fused candidates sent to the reranker
const FINAL_K = 5;         // passages given to the LLM
const MIN_RERANK = 0.02;   // drop passages the reranker considers irrelevant (always keep the top one)

export function createRetriever(kb) {
  const chunks = kb.chunks;
  const bm25 = buildBm25(chunks);
  let vectors = null; // per-isolate cache of passage embeddings

  async function passageVectors(ai) {
    if (vectors) return vectors;
    const texts = chunks.map(c => `${c.title}. ${c.section}. ${c.text}`);
    const out = [];
    for (let i = 0; i < texts.length; i += 50) {
      const r = await ai.run(EMBED_MODEL, { text: texts.slice(i, i + 50) });
      out.push(...r.data);
    }
    return (vectors = out);
  }

  return async function retrieve(query, env) {
    const t0 = Date.now();
    const trace = { mode: 'bm25', timings: {} };
    const lexical = searchBm25(bm25, query).slice(0, 20);
    let fused = lexical, dense = [];

    if (env.AI) {
      try {
        const [pv, qv] = await Promise.all([
          passageVectors(env.AI),
          env.AI.run(EMBED_MODEL, { text: [QUERY_INSTRUCTION + query] }).then(r => r.data[0]),
        ]);
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
        ranked = ranked.filter((x, i) => i === 0 || x.rerank >= MIN_RERANK);
        trace.mode += '+rerank';
      } catch (e) { trace.rerankError = String(e).slice(0, 200); }
      trace.timings.rerank_ms = Date.now() - t1;
    }

    const lexRank = new Map(lexical.map((r, i) => [r.index, i + 1]));
    const denseRank = new Map(dense.map((r, i) => [r.index, i + 1]));
    const sources = ranked.slice(0, FINAL_K).map(x => {
      const c = chunks[x.index];
      return {
        id: c.id, title: c.title, section: c.section, url: c.url, text: c.text,
        scores: { bm25_rank: lexRank.get(x.index) ?? null, dense_rank: denseRank.get(x.index) ?? null,
          rrf: dense.length ? +x.fused.toFixed(4) : null, rerank: x.rerank != null ? +x.rerank.toFixed(3) : null },
      };
    });
    return { sources, trace };
  };
}
