# jayce-chat: RAG assistant for jayceparabellum.github.io

A Cloudflare Worker that answers questions about Jayce's career from a curated knowledge base, with citations.

```
question ─▶ validate + rate-limit + origin check + drop unsigned history
         ─▶ rewrite follow-ups into a standalone query      (Llama 3.1 8B on Workers AI)
         ─▶ BM25 (keywords + domain synonyms)  ┐
         ─▶ BGE-base embeddings (Workers AI)   ┴▶ reciprocal rank fusion (k=60)
         ─▶ BGE cross-encoder rerank (Workers AI), top 5
         ─▶ grounded, cited answer streamed over SSE (Llama 3.3 70B on Workers AI; Claude Haiku if a key is set)
```

Design choices:
- **Hybrid retrieval.** BM25 catches exact terms ("C-5M", "STIG", "pgvector"); embeddings catch paraphrases ("time in uniform"). RRF merges both without score calibration, and the reranker orders the final passages.
- **Grounding and refusal.** The model sees only numbered sources, must cite `[n]`, keeps qualifiers verbatim, and says when the sources don't cover a question.
- **Safety.** API key stays server-side; origin allowlist; 12 requests/min per IP plus a 60/min site-wide cap; input length caps; sources and visitor text are treated as data (prompt-injection rule); privacy rules for phone, address and salary. The KB build fails if private-looking data appears.
- **Can't be steered into misquoting Jayce.** The browser holds the conversation, so each answer carries an HMAC signature (`done.sig`); earlier assistant turns without a valid signature are dropped with their question (`src/history.js`). The prompt forbids speaking as Jayce, making commitments for him, accepting false premises, or repeating words put in its mouth, however the request is framed. `npm run redteam -- <url>/chat` replays 13 attacks against a live Worker.
- **Contact form.** `POST /contact` emails hiring inquiries (freelance, corporate or consulting) to `CONTACT_TO` through Resend, with the visitor as reply-to. The recipient is fixed in the Worker, inputs are validated and escaped, a honeypot and timing check drop bots, and it's limited to 3 per minute per IP (`src/contact.js`).
- **Graceful degradation.** Without Workers AI it runs BM25-only; if the Worker is down, the website searches `assets/kb.json` in the browser and shows the closest notes.
- **Observability.** Each answer streams a `meta` event (rewritten query, per-stage ranks and scores, timings) that the UI shows under "How this answer was built". Logs record the query, the chunk IDs retrieved and latency, never visitor identity.

## Deploy (one time, about 5 minutes, free)

Everything runs on Cloudflare's free tier: answers come from Llama 3.3 70B on Workers AI (free daily allowance),
and the contact form relays through FormSubmit (no account). All you need is a free Cloudflare account.

```bash
cd chat-worker
npm install
npx wrangler login     # opens the browser; sign in to Cloudflare (on Windows PowerShell use npx.cmd)
npm run deploy         # prints https://jayce-chat.<your-subdomain>.workers.dev
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put HISTORY_SECRET
```

Then set the `chat-endpoint` meta tag in `../index.html` to that URL plus `/chat`, commit and push.
Activate the contact form once: send one inquiry through the site, then click "Activate" in the FormSubmit email. Activation is per page address, so do it from the live site. FormSubmit often throttles shared Cloudflare IPs (HTTP 429), so when the Worker relay fails the page posts to FormSubmit straight from the visitor's browser; setting `RESEND_API_KEY` makes the Worker relay reliable.
Check it: `curl https://jayce-chat.<your-subdomain>.workers.dev/health` should show `"chat":true,"signed_history":true`,
then `npm run redteam -- https://jayce-chat.<your-subdomain>.workers.dev/chat`.

Upgrades, if you ever want them: `npx wrangler secret put ANTHROPIC_API_KEY` switches answers to Claude Haiku;
`npx wrangler secret put RESEND_API_KEY` (a resend.com account made with `CONTACT_TO`'s address) switches mail to Resend.
When Workers AI's free daily allowance runs out, the chat says so and the website falls back to showing the closest notes.

## Develop

```bash
npm test            # rebuilds the KB, runs the retrieval eval (36 golden questions), contact and signed-history tests
npm run dev         # full pipeline locally (Workers AI runs remotely, so it needs `wrangler login`)
npm run dev:local   # no Cloudflare login needed: BM25-only retrieval
```

Local secrets go in `.dev.vars` (gitignored), e.g. `HISTORY_SECRET=...`. `npm run dev` uses Workers AI remotely, so it needs `wrangler login`.

## API

`POST /chat` with `{"messages":[{"role":"user","content":"..."}]}` (alternating roles, max 10, last ≤ 600 chars) returns `text/event-stream`:
`meta` (query, sources, trace) → `delta` × n (`{t}`) → `done` (usage, timings, `sig`), or `error` (`{message}`). Send each earlier answer back with its `sig`.
`POST /contact` with `{type: "freelance"|"corporate"|"consulting", name, email, company?, message, transcript?}` returns `{ok:true}`.
`GET /health` returns the KB version and whether chat and contact are configured.

The website deep link `https://jayceparabellum.github.io/?ask` opens the assistant (`?ask=contact` opens the contact form); the QR code on the résumé and CV (`images/qr-chat.png`, `.svg`) points there.
