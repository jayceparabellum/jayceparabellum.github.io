# Build plan: website chatbot with agentic RAG (status)

This maps the November 15, 2026 build plan onto what is implemented. Decisions taken on that date: Cloudflare only (no Pinecone, Postgres or LangGraph), Tavily for web search, supervisor checks in parallel with the stream, and conversation memory lasts one visit.

## Request flow (per message)

```
question
  -> starter cache (KV; the six fixed chips only)                      --hit--> cited reply
  -> in parallel: orchestrator (Llama 3.1 8B, JSON route)
                  site retrieval (BM25 + BGE dense -> RRF -> BGE rerank)
                  web search, started speculatively for "what is X" questions
                  memory (D1, this visit's summaries)
  -> semantic cache (D1, this visit only, cosine >= 0.95)              --hit--> cited reply
  -> writer (Llama 3.3 70B, streamed; "From the site" / "General context from the web" labels)
  -> supervisor (structural checks + 8B grounding check on the finished draft)
       fail -> one retry with the reason -> fail again -> fallback reply + email
       a rejected draft is replaced in the widget ("replace" event)
```

## Plan component -> implementation

| Plan | Implemented as | File |
|---|---|---|
| 4.1 Semantic cache (pgvector) | D1 table, vectors as Float32 blobs, cosine in the Worker; scope = visit thread id; entries drop when a cited chunk's hash changes | `src/state.js` |
| 4.2 Orchestrator | 8B model, JSON `{rewritten_query, needs_web, web_query}`; a heuristic starts the web search before it answers; hard rule: questions about Jayce never go to the web | `src/agents.js` |
| 4.3 Site worker (Pinecone) | In-Worker hybrid search: BM25 + BGE-base embeddings, RRF, BGE reranker, top 20 -> top 5 | `src/retrieve.js` |
| 4.4 Memory worker | Every 6 turns the 8B model summarizes the visit; summaries live 24 h, scoped to the thread | `src/state.js`, `src/agents.js` |
| 4.5 Web worker | Tavily, 2.5 s timeout, 24 h KV cache, HTML stripped, 800-char excerpts, `<untrusted_web_content>` wrapping, personal names removed from queries | `src/web.js` |
| 4.6 Writer | Two labeled parts when web sources exist; site-only answers stay unlabeled | `src/prompts.js` |
| 4.7 Supervisor | Deterministic citation and label checks, then the model check; one retry; fallback reply | `src/agents.js`, `src/index.js` |
| 5 Data layer | Pinecone -> bundled KB with per-chunk hashes; Postgres -> D1 (`migrations/`) | `scripts/build-kb.mjs` |
| 6 Config | One module | `src/config.js` |
| 7 Security | Keys server-side, 600-char limit, control characters stripped, parameterized SQL, per-IP and site-wide rate limits, CORS allowlist, sampled and redacted question logs | `src/index.js` |
| Ingestion | GitHub Action: rebuild KB, test, migrate, deploy; only changed chunks are re-embedded | `.github/workflows/chat-worker.yml` |
| Feedback | Thumbs up/down in the widget -> `/feedback` -> D1; down-votes keep the (redacted) question for the eval set | `assets/chat.js`, `src/index.js` |
| Observability | Workers Logs (structured JSON with request id and per-node timings); trace panel under each answer | `wrangler.toml` |
| Tests | Unit (`npm test`), red team (`npm run redteam`), live eval with latency, cache, routing and security checks (`npm run eval`) | `test/`, `scripts/` |

## Differences from the plan

- **No Pinecone, Postgres or LangGraph.** The KB is about 60 chunks; a bundled index searches it in a few ms, and D1/KV cover the runtime state on the free tier. Retrieval sits behind `createRetriever`, so a hosted vector store can replace it later.
- **The résumé PDF isn't parsed.** The knowledge base is the curated `knowledge/*.md`, which already carries the résumé facts; parsing the PDF would add duplicate chunks.
- **Faithfulness** is measured as the supervisor pass rate, not by a separate judge.
- **Supervisor timing:** the answer streams immediately and the check runs on the finished draft, as chosen. A failing draft is visible for about a second before it is replaced.

## Setup that needs you

1. Web context: create a Tavily account and API key, then run `npx wrangler secret put TAVILY_API_KEY` in `chat-worker/`. Without it, concept questions get a site-only answer that says outside context was unavailable.
2. Auto-deploy: add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets on GitHub. Without them the Action runs the tests only.
