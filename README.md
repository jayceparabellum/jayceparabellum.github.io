# jayceparabellum.github.io

Personal site for Jayce Nhan Parabellum: AI Software Engineer, cloud architect, USMC/USAF veteran.
Static HTML/CSS/JS served by GitHub Pages from `main`, plus a RAG chat assistant backed by a Cloudflare Worker.

## Layout

| Path | Purpose |
| --- | --- |
| `index.html` | The whole page. |
| `assets/jayce.css`, `chat.css` | Site and chat styles. `flow.css`, `reading.css`, `profile-hero.css`, `concierge.css` come from the template. |
| `assets/site.js`, `flow.js`, `navigation.js` | Template behaviour: scroll reveals, mobile menu. |
| `assets/chat.js` | Chat UI: streaming answers, citations, retrieval trace, offline fallback. |
| `assets/rag-core.js` | BM25, RRF and the markdown chunker, shared by the browser and the Worker. |
| `knowledge/*.md` | **The chatbot's knowledge base.** Public, curated facts, one `## section` per chunk. |
| `assets/kb.json` | Built from `knowledge/` (don't edit by hand). |
| `chat-worker/` | Cloudflare Worker, agentic RAG: orchestrator → hybrid site retrieval, optional Tavily web context and visit memory in parallel → semantic cache → Llama 3.3 writer → supervisor check. Plus the contact form and feedback. See `chat-worker/BUILD-PLAN.md`. |
| `scripts/build-kb.mjs` | Rebuilds `assets/kb.json` and `chat-worker/src/kb.generated.json`. Refuses to build if it finds phone numbers, addresses or credential IDs. |
| `tools/add-photo.py` | Resizes a photo and strips all metadata (iPhone GPS included) before it goes in `images/`. |
| `Jayce-Parabellum-Resume.pdf` | Web copy of the AI Engineering résumé (phone number removed). |
| `Jayce-Parabellum-CV.pdf` | Web copy of the full CV, from `Resumes/CV - Public Website - 2026.docx` (no home address, phone, or credential or license IDs). |

## Common edits

**Add an iPhone photo:** `pip install pillow pillow-heif`, then
`python tools/add-photo.py "C:/path/IMG_1234.HEIC" images/my-photo.jpg`, then add an `<img>` in `index.html`.

**Change a fact:** edit both the page copy in `index.html` and the matching `knowledge/*.md` file, then
`node scripts/build-kb.mjs` and redeploy the Worker (`cd chat-worker && npm run deploy`). Once the GitHub secrets in `chat-worker/BUILD-PLAN.md` are set, a push to `main` does this automatically.

**Preview locally:** `python -m http.server 8000` in this folder, then open http://localhost:8000.
On localhost the chat calls `http://127.0.0.1:8787/chat` (run the Worker with `npm run dev` in `chat-worker/`).
If the Worker isn't reachable, the chat falls back to showing the closest knowledge-base notes.

## Deploy

Commit to `main`; Pages serves the root. After the first Worker deploy, put its URL in the
`<meta name="chat-endpoint">` tag in `index.html`.
