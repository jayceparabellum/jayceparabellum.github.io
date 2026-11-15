// jayce-chat: RAG chat endpoint for jayceparabellum.github.io
// POST /chat  {messages:[{role:'user'|'assistant', content:string}, ...]}  ->  text/event-stream
//   event: meta   {query, sources[], trace}     retrieval results, sent before generation starts
//   event: delta  {t}                           streamed answer text
//   event: done   {usage, total_ms}
//   event: error  {message}
import Anthropic from '@anthropic-ai/sdk';
import KB from './kb.generated.json';
import { createRetriever } from './retrieve.js';
import { SYSTEM_PROMPT, REWRITE_PROMPT, buildUserTurn } from './prompts.js';

const MODEL = 'claude-haiku-5-5';
const MAX_TURNS = 10;          // history messages kept (5 exchanges)
const MAX_QUESTION = 600;      // chars
const MAX_HISTORY_MSG = 2000;  // chars per earlier message

const retrieve = createRetriever(KB);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (url.pathname === '/health') return json({ ok: true, kb: KB.version, chunks: KB.chunks.length, model: MODEL }, 200, cors);
    if (url.pathname !== '/chat' || request.method !== 'POST') return json({ error: 'Not found' }, 404, cors);
    if (!cors) return json({ error: 'Origin not allowed' }, 403);

    // Per-IP rate limit (Workers Rate Limiting binding; see wrangler.toml).
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many questions in a short time. Please wait a minute and try again.' }, 429, cors);
    }

    let messages;
    try { messages = validate(await request.json()); }
    catch (e) { return json({ error: e.message || 'Bad request' }, 400, cors); }
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'Assistant is not configured (missing API key).' }, 503, cors);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    ctx.waitUntil(answer({ messages, env, send }).catch(e => send('error', { message: publicError(e) })).finally(() => writer.close()));

    return new Response(readable, { headers: { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  },
};

async function answer({ messages, env, send }) {
  const started = Date.now();
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  const question = messages.at(-1).content;
  const history = messages.slice(0, -1);

  // 1. Query rewriting: make follow-ups ("what about the second one?") searchable on their own.
  let query = question;
  const t0 = Date.now();
  if (history.length) {
    try {
      const transcript = messages.map(m => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content.slice(0, 600)}`).join('\n');
      const r = await client.messages.create({
        model: MODEL, max_tokens: 200, output_config: { effort: 'low' },
        system: REWRITE_PROMPT,
        messages: [{ role: 'user', content: `<conversation>\n${transcript}\n</conversation>\nStandalone search query:` }],
      });
      const text = r.content.find(b => b.type === 'text')?.text?.trim().split('\n')[0];
      if (text && text.length < 300) query = text;
    } catch { /* fall back to the raw question */ }
  }
  const rewrite_ms = Date.now() - t0;

  // 2-4. Hybrid retrieval, fusion, rerank.
  const { sources, trace } = await retrieve(query, env);
  trace.timings.rewrite_ms = rewrite_ms;
  await send('meta', {
    query, rewritten: query !== question, trace,
    sources: sources.map(({ text, ...s }) => ({ ...s, snippet: text.slice(0, 220) })),
  });

  // 5. Grounded generation, streamed. Earlier turns are passed as plain text; only the newest turn carries sources.
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 1200,
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [...history, { role: 'user', content: buildUserTurn(question, sources) }],
  });
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') await send('delta', { t: ev.delta.text });
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    await send('delta', { t: "I can't help with that one. Feel free to ask about Jayce's experience, projects or skills." });
  }
  await send('done', {
    stop_reason: final.stop_reason, total_ms: Date.now() - started,
    usage: { input: final.usage.input_tokens, output: final.usage.output_tokens, cache_read: final.usage.cache_read_input_tokens || 0 },
  });
  console.log(JSON.stringify({ q: question.slice(0, 200), query, mode: trace.mode, top: sources.map(s => s.id), ms: Date.now() - started }));
}

function validate(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || !msgs.length) throw new Error('messages must be a non-empty array');
  const trimmed = msgs.slice(-MAX_TURNS);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  if (!trimmed.length) throw new Error('conversation must contain a user message');
  trimmed.forEach((m, i) => {
    if (m?.role !== (i % 2 ? 'assistant' : 'user')) throw new Error('messages must alternate user/assistant, starting with user');
    if (typeof m.content !== 'string' || !m.content.trim()) throw new Error('message content must be a non-empty string');
  });
  const last = trimmed.at(-1);
  if (last.role !== 'user') throw new Error('last message must be from the user');
  if (last.content.length > MAX_QUESTION) throw new Error(`Please keep questions under ${MAX_QUESTION} characters.`);
  return trimmed.map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_HISTORY_MSG) }));
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origin) return { 'vary': 'origin' }; // same-origin / curl: no CORS headers needed
  if (!allowed.includes(origin)) return null;
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', 'vary': 'origin' };
}

function publicError(e) {
  if (e instanceof Anthropic.RateLimitError) return 'The assistant is busy right now. Please try again in a minute.';
  if (e instanceof Anthropic.AuthenticationError) return 'The assistant is misconfigured. Please email Jayce instead.';
  if (e instanceof Anthropic.APIError) return 'The AI service had a problem answering. Please try again.';
  console.error(e);
  return 'Something went wrong. Please try again.';
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...(headers || {}), 'content-type': 'application/json' } });
