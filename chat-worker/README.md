# jayce-chat: RAG assistant for jayceparabellum.github.io

A Cloudflare Worker that answers questions about Jayce's career from a curated knowledge base, with citations.

```
question ─▶ validate + rate-limit + origin check
         ─▶ rewrite follow-ups into a standalone query      (Claude Haiku 5.5, effort low)
         ─▶ BM25 (keywords + domain synonyms)  ┐
         ─▶ BGE-base embeddings (Workers AI)   ┴▶ reciprocal rank fusion (k=60)
         ─▶ BGE cross-encoder rerank (Workers AI), top 5
         ─▶ grounded, cited answer streamed over SSE (Claude Haiku 5.5, cached system prompt)
```

Design choices:
- **Hybrid retrieval.** BM25 catches exact terms ("C-5M", "STIG", "pgvector"); embeddings catch paraphrases ("time in uniform"). RRF merges both without score calibration, and the reranker orders the final passages.
- **Grounding and refusal.** The model sees only numbered sources, must cite `[n]`, keeps qualifiers verbatim, and says when the sources don't cover a question.
- **Safety.** API key stays server-side; origin allowlist; 12 requests/min per IP; input length caps; sources and visitor text are treated as data (prompt-injection rule); privacy rules for phone, address and salary. The KB build fails if private-looking data appears.
- **Graceful degradation.** Without Workers AI it runs BM25-only; if the Worker is down, the website searches `assets/kb.json` in the browser and shows the closest notes.
- **Observability.** Each answer streams a `meta` event (rewritten query, per-stage ranks and scores, timings) that the UI shows under "How this answer was built". Logs record the query, the chunk IDs retrieved and latency, never visitor identity.

## Deploy (one time, about 10 minutes)

You need a free Cloudflare account and an Anthropic API key (console.anthropic.com → API keys).
**Set a monthly spend limit in the Anthropic console**, since the endpoint is public.

```bash
cd chat-worker
npm install
npx wrangler login                          # opens the browser; sign in to Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY   # paste the key when prompted (never commit it)
npm run deploy                              # prints https://jayce-chat.<your-subdomain>.workers.dev
```

Then set the `chat-endpoint` meta tag in `../index.html` to that URL plus `/chat`, commit and push.
Check it: `curl https://jayce-chat.<your-subdomain>.workers.dev/health`.

## Develop

```bash
npm test            # rebuilds the KB, runs the retrieval eval (25 golden questions) and unit tests
npm run dev         # full pipeline locally (Workers AI runs remotely, so it needs `wrangler login`)
npm run dev:local   # no Cloudflare login needed: BM25-only retrieval
```

Local secrets go in `.dev.vars` (gitignored): `ANTHROPIC_API_KEY=sk-ant-...`.

## API

`POST /chat` with `{"messages":[{"role":"user","content":"..."}]}` (alternating roles, max 10, last ≤ 600 chars) returns `text/event-stream`:
`meta` (query, sources, trace) → `delta` × n (`{t}`) → `done` (usage, timings), or `error` (`{message}`). `GET /health` returns the KB version.
