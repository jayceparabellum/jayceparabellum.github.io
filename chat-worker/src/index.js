// jayce-chat: agentic RAG chat endpoint for jayceparabellum.github.io (see BUILD-PLAN.md in this folder).
// POST /chat  {messages:[{role, content, sig?}], thread_id?, turn?}  ->  text/event-stream
//   event: meta     {query, sources[], trace, route, web}   retrieval results, sent before generation starts
//   event: delta    {t}                                      streamed answer text
//   event: replace  {t, reason}                              the supervisor rejected the streamed draft; show this instead
//   event: done     {usage, total_ms, sig, supervisor}       sig: HMAC of (question, final answer)
//   event: error    {message}
// POST /feedback  {thread_id, message_id, rating: 1|-1, comment?, question?}
// POST /contact   hiring inquiry -> email to Jayce (see contact.js)
// GET  /health    status;  /health?warm=1 loads passage embeddings into this isolate
//
// Per message:  starter cache -> [orchestrator || site retrieval || speculative web search] -> semantic cache
//   -> writer (streamed) -> supervisor (checks the finished draft; one retry, then a fallback reply).
import Anthropic from '@anthropic-ai/sdk';
import { createLLM } from './llm.js';
import KB from './kb.generated.json';
import { createRetriever, embedQuery } from './retrieve.js';
import { SYSTEM_PROMPT, buildUserTurn } from './prompts.js';
import { sendContact, ContactError } from './contact.js';
import { trustedHistory, sign } from './history.js';
import { markerFilter, CONTACT_INTENT, MARKER } from './marker.js';
import { STARTERS, hash } from './starters.js';
import { CONFIG, logger, redact } from './config.js';
import { orchestrate, guessRoute, supervise, summarize, FALLBACK_REPLY } from './agents.js';
import { webSearch } from './web.js';
import { THREAD_RE, cacheLookup, cacheStore, memoryLoad, memoryStore, feedbackStore, cleanup } from './state.js';

const retrieve = createRetriever(KB);
const CHUNK_HASH = new Map(KB.chunks.map(c => [c.id, c.hash]));
const PROMPT_VERSION = hash(SYSTEM_PROMPT);
// Words that make a follow-up depend on earlier turns ("tell me more about it"), so it can't be matched as typed.
const REFERS_BACK = /\b(he|his|him|it|its|that|this|those|these|they|them|their|more|else|other|another|second|first|last|previous|same|above|earlier)\b/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (url.pathname === '/health' && url.searchParams.has('warm')) {
      const t0 = Date.now(); let passages = 0;
      try { passages = await retrieve.warm(env); } catch { /* the question path will retry */ }
      return json({ ok: true, passages, ms: Date.now() - t0 }, 200, cors);
    }
    if (url.pathname === '/health') return json({ ok: true, kb: KB.version, chunks: KB.chunks.length, model: createLLM(env)?.name || null,
      chat: !!createLLM(env), signed_history: !!env.HISTORY_SECRET || !!env.ANTHROPIC_API_KEY, web: !!env.TAVILY_API_KEY, state: !!env.DB,
      contact: env.CONTACT_TO ? (env.RESEND_API_KEY ? 'resend' : 'formsubmit') : false }, 200, cors);
    if (!['/chat', '/contact', '/feedback'].includes(url.pathname) || request.method !== 'POST') return json({ error: 'Not found' }, 404, cors);
    // POST routes are for the site's browser widget only: a missing Origin (scripts, curl) is refused too.
    if (!cors || !request.headers.get('origin')) return json({ error: 'Origin not allowed' }, 403);
    if (url.pathname === '/contact') return contact(request, env, cors);
    if (url.pathname === '/feedback') return feedback(request, env, cors);

    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many questions in a short time. Please wait a minute and try again.' }, 429, cors);
    }
    if (env.GLOBAL_LIMITER) {
      const { success } = await env.GLOBAL_LIMITER.limit({ key: 'all' });
      if (!success) return json({ error: 'The assistant is very busy right now. Please try again in a minute.' }, 429, cors);
    }

    const llm = createLLM(env);
    if (!llm) return json({ error: 'Assistant is not configured.' }, 503, cors);
    let body, messages;
    try {
      body = await request.json();
      messages = await trustedHistory(validate(body), env, CONFIG.MAX_HISTORY_MSG_CHARS);
    } catch (e) { return json({ error: e.message || 'Bad request' }, 400, cors); }
    const thread = typeof body.thread_id === 'string' && THREAD_RE.test(body.thread_id) ? body.thread_id : null;
    const turn = Number.isInteger(body.turn) && body.turn > 0 && body.turn < 10000 ? body.turn : 0;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    const log = logger(crypto.randomUUID().slice(0, 8));
    ctx.waitUntil(answer({ messages, thread, turn, env, llm, send, log, ctx })
      .catch(e => { log.error('answer', e); return send('error', { message: publicError(e), code: isQuota(e) ? 'quota' : undefined }); })
      .finally(() => writer.close()));

    return new Response(readable, { headers: { ...cors, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  },

  // Hourly: delete expired cache and memory rows.
  async scheduled(event, env) {
    if (env.DB) console.log(JSON.stringify({ node: 'cleanup', deleted: await cleanup(env.DB) }));
  },
};

async function answer({ messages, thread, turn, env, llm, send, log, ctx }) {
  const started = Date.now();
  const question = messages.at(-1).content;
  const history = messages.slice(0, -1);
  const timings = {};
  const time = async (name, p) => { const t = Date.now(); try { return await p; } finally { timings[name] = Date.now() - t; } };
  const wantsContact = CONTACT_INTENT.test(question);

  // 0. Starter chips: fixed public questions with no history answer from KV, re-signed for this request.
  const starterKey = !history.length && env.CHAT_CACHE && STARTERS.includes(question)
    ? `ans:${KB.version}:${PROMPT_VERSION}:${llm.name}:${hash(question)}` : null;
  if (starterKey) {
    const hit = await env.CHAT_CACHE.get(starterKey, 'json').catch(() => null);
    if (hit?.text) return replay({ send, question, text: hit.text, meta: hit.meta, env, llm, started, log, how: 'starter' });
  }

  // 1. Fan out: memory + orchestrator, site retrieval and (speculatively) the web search all start now.
  const abortWeb = new AbortController();
  const guess = guessRoute(question);
  let webP = guess.needs_web ? webSearch(guess.web_query, env, { signal: abortWeb.signal }) : null;
  // A question that stands on its own is embedded once, now: the vector serves the early cache check and,
  // for a first question, the site search as typed. Follow-ups wait for the orchestrator's rewritten query.
  const standalone = !history.length || !REFERS_BACK.test(question);
  const qv0P = standalone && env.AI ? embedQuery(env.AI, question).catch(() => null) : null;
  let siteP = history.length ? null : retrieve(question, env, qv0P ? { qv: qv0P } : {});
  const earlyHitP = thread && qv0P && !wantsContact
    ? qv0P.then(qv0 => qv0 && cacheLookup(env.DB, { scope: thread, qv: qv0, chunkHash: CHUNK_HASH })).catch(e => { log.error('cache', e); return null; }) : null;
  const memoryP = memoryLoad(env.DB, thread).catch(e => { log.error('memory', e); return ''; });
  const routeP = memoryP.then(memory => orchestrate(llm, { question, history, memory }));

  // 2a. Semantic cache, checked while the orchestrator runs: a near-identical question earlier in this visit.
  const early = earlyHitP && await time('cache_ms', earlyHitP);
  if (early) { abortWeb.abort(); return replay({ send, question, text: early.answer, meta: early.meta, env, llm, started, log, how: 'semantic', sim: early.sim }); }

  const memory = await time('memory_ms', memoryP);
  const route = await time('orchestrator_ms', routeP);
  const query = route.rewritten_query;
  if (!siteP || query !== question) siteP = retrieve(query, env);
  if (route.needs_web && !webP) webP = webSearch(route.web_query, env, { signal: abortWeb.signal });
  if (!route.needs_web && webP) { abortWeb.abort(); webP = null; } // speculation was wrong: discard it

  const site = await time('site_ms', siteP);
  const { qv, ...trace } = site.trace;
  Object.assign(trace.timings, timings);

  // 2b. Semantic cache for follow-ups, matched on the rewritten query (standalone questions were checked above).
  if (thread && qv && !wantsContact && !earlyHitP) {
    const hit = await cacheLookup(env.DB, { scope: thread, qv, chunkHash: CHUNK_HASH }).catch(e => { log.error('cache', e); return null; });
    if (hit) { abortWeb.abort(); return replay({ send, question, text: hit.answer, meta: hit.meta, env, llm, started, log, how: 'semantic', sim: hit.sim }); }
  }

  // 3. Web context, bounded by its own timeout; a failure leaves a site-only answer that says so.
  const web = webP ? await time('web_ms', webP) : null;
  const webStatus = !route.needs_web ? 'not needed' : web?.results.length ? 'provided' : 'unavailable';
  const webSources = (web?.results || []).map((r, i) => ({ id: `web-${i + 1}`, kind: 'web', title: r.title || new URL(r.url).hostname,
    section: new URL(r.url).hostname.replace(/^www\./, ''), url: r.url, text: r.text, scores: {} }));
  const sources = [...site.sources, ...webSources];
  Object.assign(trace.timings, timings);

  const meta = {
    query, rewritten: query !== question, trace,
    route: { needs_web: route.needs_web, web_query: route.web_query, by: route.source },
    web: route.needs_web ? { status: webStatus, query: web?.query || null, cached: !!web?.cached, error: web?.error || web?.skipped || null } : null,
    sources: sources.map(({ text, hash: _h, ...s }) => ({ ...s, snippet: text.slice(0, 220) })),
  };
  await send('meta', meta);

  // 4. Writer, streamed.
  const turnContent = extra => buildUserTurn(question, sources, { contactShown: wantsContact, memory, webStatus }) + (extra || '');
  const write = async (extra, onText) => {
    let out = '';
    const filter = markerFilter(wantsContact);
    const emit = async t => { if (t) { out += t; if (onText) await onText(t); } };
    const final = await llm.stream(SYSTEM_PROMPT, [...history, { role: 'user', content: turnContent(extra) }], t => emit(filter.push(t)));
    await emit(filter.flush());
    return { text: out, final };
  };
  const t4 = Date.now();
  let { text: full, final } = await write('', t => send('delta', { t }));
  trace.timings.writer_ms = Date.now() - t4;

  // 5. Supervisor: check the finished draft; on a fail, retry once with the reason, then fall back.
  const t5 = Date.now();
  const check = draft => (wantsContact ? { pass: true, by: 'skipped (contact)' } : supervise(llm, { draft: draft.split(MARKER).join(''), sources }));
  let verdict = await check(full);
  const attempts = [verdict];
  for (let i = 0; !verdict.pass && i < CONFIG.MAX_SUPERVISOR_RETRIES; i++) {
    const retry = await write(`\n\nA reviewer rejected your previous draft: ${verdict.reason}. Write the answer again and fix that. Use only what the sources support.`);
    verdict = await check(retry.text);
    attempts.push(verdict);
    if (verdict.pass) { full = retry.text; final = retry.final; }
  }
  if (!verdict.pass) full = FALLBACK_REPLY;
  if (attempts.length > 1) await send('replace', { t: full, reason: attempts[0].reason });
  trace.timings.supervisor_ms = Date.now() - t5;

  await send('done', { stop_reason: final.stop_reason, total_ms: Date.now() - started, model: llm.name, sig: await sign(env, question, full), usage: final.usage,
    timings: trace.timings, supervisor: { pass: attempts.at(-1).pass, attempts: attempts.length, by: attempts.at(-1).by, reason: attempts[0].pass ? null : attempts[0].reason } });

  // 6. After the reply: caches and memory (best-effort, off the critical path).
  // Never cache an empty, rejected or cut-off answer.
  const passed = attempts.at(-1).pass && full.trim().length > 0 && full !== FALLBACK_REPLY && !['max_tokens', 'length'].includes(final.stop_reason);
  const after = [];
  if (passed && starterKey && trace.mode.includes('rerank'))
    after.push(env.CHAT_CACHE.put(starterKey, JSON.stringify({ meta, text: full }), { expirationTtl: CONFIG.STARTER_TTL_HOURS * 3600 }));
  if (passed && thread && qv && !wantsContact)
    after.push(cacheStore(env.DB, { scope: thread, question: query, qv, answer: full, meta, sources }));
  if (thread && turn && turn % CONFIG.MEMORY_SUMMARY_EVERY_N_TURNS === 0)
    after.push(summarize(llm, [...history, { role: 'user', content: question }, { role: 'assistant', content: full }])
      .then(summary => memoryStore(env.DB, { thread, summary, turnStart: Math.max(1, turn - CONFIG.MEMORY_SUMMARY_EVERY_N_TURNS + 1), turnEnd: turn })));
  ctx.waitUntil(Promise.allSettled(after).then(rs => rs.forEach(r => r.status === 'rejected' && log.error('after', r.reason))));

  log.info('chat', { model: llm.name, mode: trace.mode, route: meta.route, web: meta.web?.status, top: site.sources.map(s => s.id),
    supervisor: attempts.map(a => a.pass), ms: Date.now() - started, timings: trace.timings,
    ...(Math.random() < CONFIG.LOG_QUESTION_SAMPLE_RATE ? { q: redact(question) } : {}) });
}

// Serve a cached answer as a normal stream, signed for this request.
async function replay({ send, question, text, meta, env, llm, started, log, how, sim }) {
  await send('meta', { ...meta, cached: how });
  for (let i = 0; i < text.length; i += 60) await send('delta', { t: text.slice(i, i + 60) });
  await send('done', { stop_reason: 'end_turn', total_ms: Date.now() - started, model: llm.name, cached: how, sig: await sign(env, question, text), usage: { input: 0, output: 0, cache_read: 0 } });
  log.info('chat', { model: llm.name, cached: how, sim, ms: Date.now() - started });
}

async function feedback(request, env, cors) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  if (env.FEEDBACK_LIMITER) {
    const { success } = await env.FEEDBACK_LIMITER.limit({ key: ip });
    if (!success) return json({ error: 'Too many votes in a short time.' }, 429, cors);
  }
  const b = await request.json().catch(() => null);
  const thread = b?.thread_id, messageId = b?.message_id, rating = b?.rating;
  if (typeof thread !== 'string' || !THREAD_RE.test(thread) || typeof messageId !== 'string' || !/^[A-Za-z0-9_+/=-]{8,64}$/.test(messageId) || ![1, -1].includes(rating))
    return json({ error: 'Bad request' }, 400, cors);
  if (!env.DB) return json({ error: 'Feedback is not available right now.' }, 503, cors);
  const clean = (s, n) => (typeof s === 'string' && s.trim() ? redact(stripControl(s)).slice(0, n) : null);
  try {
    await feedbackStore(env.DB, { thread, messageId, rating, comment: clean(b.comment, 500), question: rating === -1 ? clean(b.question, 600) : null });
    return json({ ok: true }, 200, cors);
  } catch (e) { console.error(e); return json({ error: 'Feedback could not be saved.' }, 500, cors); }
}

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

const stripControl = s => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

export function validate(body) {
  const msgs = body?.messages;
  if (!Array.isArray(msgs) || !msgs.length) throw new Error('messages must be a non-empty array');
  const trimmed = msgs.slice(-CONFIG.MAX_TURNS);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  if (!trimmed.length) throw new Error('conversation must contain a user message');
  trimmed.forEach((m, i) => {
    if (m?.role !== (i % 2 ? 'assistant' : 'user')) throw new Error('messages must alternate user/assistant, starting with user');
    if (typeof m.content !== 'string' || !stripControl(m.content).trim()) throw new Error('message content must be a non-empty string');
    if (m.content.length > 12000) throw new Error('message too long');
  });
  const last = trimmed.at(-1);
  if (last.role !== 'user') throw new Error('last message must be from the user');
  if (stripControl(last.content).trim().length > CONFIG.MAX_QUESTION_CHARS) throw new Error(`Please keep questions under ${CONFIG.MAX_QUESTION_CHARS} characters.`);
  return trimmed.map(m => ({ role: m.role, content: stripControl(m.content).trim(), sig: typeof m.sig === 'string' ? m.sig : '' }));
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origin) return { 'vary': 'origin' }; // same-origin / curl: no CORS headers needed
  if (!allowed.includes(origin)) return null;
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', 'vary': 'origin' };
}

const isQuota = e => /neuron|quota|capacity|3036|3040|daily/i.test(String(e?.message));

function publicError(e) {
  if (e instanceof Anthropic.RateLimitError) return 'The assistant is busy right now. Please try again in a minute.';
  if (e instanceof Anthropic.AuthenticationError) return 'The assistant is misconfigured. Please email Jayce instead.';
  if (e instanceof Anthropic.APIError) return 'The AI service had a problem answering. Please try again.';
  if (/neuron|quota|limit|capacity|3036|3040/i.test(String(e?.message))) return 'The assistant has reached today’s free usage limit. Please try again tomorrow, or email Jayce.';
  return 'Something went wrong. Please try again.';
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...(headers || {}), 'content-type': 'application/json' } });
