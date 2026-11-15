// jayce-chat: RAG chat endpoint for jayceparabellum.github.io
// POST /chat  {messages:[{role:'user'|'assistant', content:string, sig?:string}, ...]}  ->  text/event-stream
//   event: meta   {query, sources[], trace}     retrieval results, sent before generation starts
//   event: delta  {t}                           streamed answer text
//   event: done   {usage, total_ms, sig}   sig: HMAC of (question, answer); earlier answers are only trusted with it
//   event: error  {message}
// POST /contact  hiring inquiry -> email to Jayce via Resend (see contact.js)
import Anthropic from '@anthropic-ai/sdk';
import { createLLM } from './llm.js';
import KB from './kb.generated.json';
import { createRetriever } from './retrieve.js';
import { SYSTEM_PROMPT, REWRITE_PROMPT, buildUserTurn } from './prompts.js';
import { sendContact, ContactError } from './contact.js';
import { trustedHistory, sign } from './history.js';
import { markerFilter, CONTACT_INTENT } from './marker.js';
import { STARTERS, hash } from './starters.js';

const MAX_TURNS = 10;          // history messages kept (5 exchanges)
const MAX_QUESTION = 600;      // chars
const MAX_HISTORY_MSG = 2000;  // chars per earlier message

const retrieve = createRetriever(KB);
const PROMPT_VERSION = hash(SYSTEM_PROMPT);
const STARTER_TTL = 60 * 60 * 24 * 7; // a week; a KB or prompt change also changes the key

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (url.pathname === '/health' && url.searchParams.has('warm')) {
      // Called by the site when a visitor arrives, so the first question skips loading embeddings.
      const t0 = Date.now(); let passages = 0;
      try { passages = await retrieve.warm(env); } catch { /* the question path will retry */ }
      return json({ ok: true, passages, ms: Date.now() - t0 }, 200, cors);
    }
    if (url.pathname === '/health') return json({ ok: true, kb: KB.version, chunks: KB.chunks.length, model: createLLM(env)?.name || null,
      chat: !!createLLM(env), signed_history: !!env.HISTORY_SECRET || !!env.ANTHROPIC_API_KEY,
      contact: env.CONTACT_TO ? (env.RESEND_API_KEY ? 'resend' : 'formsubmit') : false }, 200, cors);
    if (!['/chat', '/contact'].includes(url.pathname) || request.method !== 'POST') return json({ error: 'Not found' }, 404, cors);
    if (!cors) return json({ error: 'Origin not allowed' }, 403);
    if (url.pathname === '/contact') return contact(request, env, cors);

    // Per-IP rate limit (Workers Rate Limiting binding; see wrangler.toml).
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many questions in a short time. Please wait a minute and try again.' }, 429, cors);
    }
    // Site-wide cap, so rotating IPs can't run up the API bill.
    if (env.GLOBAL_LIMITER) {
      const { success } = await env.GLOBAL_LIMITER.limit({ key: 'all' });
      if (!success) return json({ error: 'The assistant is very busy right now. Please try again in a minute.' }, 429, cors);
    }

    const llm = createLLM(env);
    if (!llm) return json({ error: 'Assistant is not configured.' }, 503, cors);
    let messages;
    try { messages = await trustedHistory(validate(await request.json()), env, MAX_HISTORY_MSG); }
    catch (e) { return json({ error: e.message || 'Bad request' }, 400, cors); }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    ctx.waitUntil(answer({ messages, env, llm, send }).catch(e => send('error', { message: publicError(e) })).finally(() => writer.close()));

    return new Response(readable, { headers: { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  },
};

async function contact(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (env.CONTACT_LIMITER) {
    const { success } = await env.CONTACT_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'Too many messages in a short time. Please wait a minute and try again.' }, 429, cors);
  }
  try {
    const body = await request.json().catch(() => { throw new ContactError('Bad request'); });
    const result = await sendContact(body, env, { country: request.cf?.country, when: new Date().toUTCString() });
    return json({ ok: true, id: result.id || null }, 200, cors);
  } catch (e) {
    if (e instanceof ContactError) return json({ error: e.message }, e.status, cors);
    console.error(e);
    return json({ error: 'Your message couldn’t be sent right now. Please email Jayce directly.' }, 500, cors);
  }
}

async function answer({ messages, env, llm, send }) {
  const started = Date.now();
  const question = messages.at(-1).content;
  const history = messages.slice(0, -1);

  // Starter chips: serve a cached answer (re-signed for this request) when there is one.
  const starterKey = !history.length && env.CHAT_CACHE && STARTERS.includes(question)
    ? `ans:${KB.version}:${PROMPT_VERSION}:${llm.name}:${hash(question)}` : null;
  if (starterKey) {
    const hit = await env.CHAT_CACHE.get(starterKey, 'json').catch(() => null);
    if (hit?.text) {
      await send('meta', { ...hit.meta, cached: true });
      for (let i = 0; i < hit.text.length; i += 60) await send('delta', { t: hit.text.slice(i, i + 60) });
      await send('done', { stop_reason: 'end_turn', total_ms: Date.now() - started, model: llm.name, cached: true, sig: await sign(env, question, hit.text), usage: { input: 0, output: 0, cache_read: 0 } });
      console.log(JSON.stringify({ model: llm.name, q: question, cached: true, ms: Date.now() - started }));
      return;
    }
  }

  // 1. Query rewriting: make follow-ups ("what about the second one?") searchable on their own.
  let query = question;
  const t0 = Date.now();
  if (history.length) {
    try {
      const transcript = messages.map(m => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content.slice(0, 600)}`).join('\n');
      const r = await llm.complete(REWRITE_PROMPT, `<conversation>\n${transcript}\n</conversation>\nStandalone search query:`);
      const text = r.trim().split('\n')[0].replace(/^["']|["']$/g, '');
      if (text && text.length < 300) query = text;
    } catch { /* fall back to the raw question */ }
  }
  const rewrite_ms = Date.now() - t0;

  // 2-4. Hybrid retrieval, fusion, rerank.
  const { sources, trace } = await retrieve(query, env);
  trace.timings.rewrite_ms = rewrite_ms;
  const meta = {
    query, rewritten: query !== question, trace,
    sources: sources.map(({ text, ...s }) => ({ ...s, snippet: text.slice(0, 220) })),
  };
  await send('meta', meta);

  // 5. Grounded generation, streamed. Earlier turns are passed as plain text; only the newest turn carries sources.
  let full = '';
  const wantsContact = CONTACT_INTENT.test(question);
  const filter = markerFilter(wantsContact);
  const emit = async t => { if (t) { full += t; await send('delta', { t }); } };
  const final = await llm.stream(SYSTEM_PROMPT, [...history, { role: 'user', content: buildUserTurn(question, sources, wantsContact) }],
    t => emit(filter.push(t)));
  await emit(filter.flush());
  if (starterKey && full.trim() && !['max_tokens', 'length'].includes(final.stop_reason) && trace.mode.includes('rerank'))
    await env.CHAT_CACHE.put(starterKey, JSON.stringify({ meta, text: full }), { expirationTtl: STARTER_TTL }).catch(() => {});
  await send('done', { stop_reason: final.stop_reason, total_ms: Date.now() - started, model: llm.name, sig: await sign(env, question, full), usage: final.usage });
  console.log(JSON.stringify({ model: llm.name, q: question.slice(0, 200), query, mode: trace.mode, top: sources.map(s => s.id), ms: Date.now() - started }));
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
    if (m.content.length > 12000) throw new Error('message too long');
  });
  const last = trimmed.at(-1);
  if (last.role !== 'user') throw new Error('last message must be from the user');
  if (last.content.trim().length > MAX_QUESTION) throw new Error(`Please keep questions under ${MAX_QUESTION} characters.`);
  return trimmed.map(m => ({ role: m.role, content: m.content.trim(), sig: typeof m.sig === 'string' ? m.sig : '' }));
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
  if (/neuron|quota|limit|capacity|3036|3040/i.test(String(e?.message))) return 'The assistant has reached today’s free usage limit. Please try again tomorrow, or email Jayce.';
  console.error(e);
  return 'Something went wrong. Please try again.';
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...(headers || {}), 'content-type': 'application/json' } });
