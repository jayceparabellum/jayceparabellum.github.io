// chat.js: streaming chat UI for the RAG assistant (Cloudflare Worker in chat-worker/).
// One conversation is shared by the inline panel (#chat-inline) and the floating panel (#chat-floating).
// If the backend is unreachable or not yet configured, it falls back to in-browser BM25 over assets/kb.json
// and shows the closest source notes instead of an AI answer.
(async () => {
  const core = await import('./rag-core.js');
  const metaEndpoint = document.querySelector('meta[name="chat-endpoint"]')?.content || '';
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const params = new URLSearchParams(location.search);
  // ?chat=<url> points the UI at another backend, for local testing only (never on the live site).
  const override = local ? params.get('chat') : null;
  const ENDPOINT = override || (local ? 'http://127.0.0.1:8787/chat' : metaEndpoint);
  const CONFIGURED = ENDPOINT && !/YOUR-SUBDOMAIN/.test(ENDPOINT);
  const CONTACT_ENDPOINT = CONFIGURED ? ENDPOINT.replace(/\/chat\/?$/, '/contact') : '';
  const FEEDBACK_ENDPOINT = CONFIGURED ? ENDPOINT.replace(/\/chat\/?$/, '/feedback') : '';
  // One id per browser visit (sessionStorage): scopes the Worker's memory and semantic cache to this visit only.
  const THREAD_ID = (() => {
    const make = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    try { let t = sessionStorage.getItem('chatThread'); if (!t) { t = make(); sessionStorage.setItem('chatThread', t); } return t; } catch { return make(); }
  })();
  let turnCount = 0;
  const EMAIL = 'jayce.n.parabellum@gmail.com';
  const TYPES = { freelance: 'Freelance / contract', corporate: 'Full-time / corporate', consulting: 'Consulting' };
  const MARKER = /\s*\[\[contact\]\]\s*/i;
  const HIRE_RE = /\b(hire|hiring|recruiting (for|him|jayce)|recruit (him|jayce)|interview|freelanc|contract(or|ing)?\b|consult|reach (out|him|jayce)|contact|get in touch|email (him|jayce)|work with (him|jayce)|(talk|speak|chat|meet) (to|with) (him|jayce)|connect with|full[- ]time|part[- ]time|opportunit|opening|job offer|position|(a|an|our|my|this) [\w -]{0,40}\b(role|job)\b|role for|(we|i)('re| are| am) looking|my team|our team)/i;

  const SUGGESTIONS = [
    'What does Jayce do at Teos Technology?',
    'Tell me about the TTB label verification tool',
    'What was Jayce’s military service?',
    'Which AWS certifications does Jayce hold?',
    'How was this chatbot built?',
    'I’d like to hire Jayce',
  ];

  const state = { messages: [], busy: false, controller: null,
    contact: { open: false, sending: false, sent: false, error: '', fallback: false, openedAt: 0,
      draft: { type: '', name: '', email: '', company: '', message: '', transcript: true, website: '' } } };
  const views = [];
  let kbIndex = null;

  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Minimal, safe formatter: escape first, then **bold**, "- " bullets, [n] citations, paragraphs.
  // Hide the [[contact]] marker, including a half-streamed one at the end of the text.
  const visible = t => t.replace(/\s*\[\[contact\]\]\s*/gi, '\n').replace(/\s*\[(\[(c(o(n(t(a(c(t(\](\])?)?)?)?)?)?)?)?)?)?$/i, '').trim();
  function format(text, sources = []) {
    const lines = esc(visible(text)).split('\n');
    let html = '', inList = false;
    for (const raw of lines) {
      const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        // Only allowlisted sites become links, so the model can't hand visitors an arbitrary URL.
        .replace(/\b(?:https?:\/\/)?((?:www\.)?jayceparabellum\.github\.io(?:\/[^\s<)\]]*)?)/gi, (m, u) => `<a href="https://${u.replace(/[.,;]+$/, '')}" target="_blank" rel="noopener">${u.replace(/[.,;]+$/, '')}</a>${(u.match(/[.,;]+$/) || [''])[0]}`)
        .replace(/\[(\d+)\]/g, (m, n) => {
          const s = sources[n - 1];
          if (!s) return '';
          return s.kind === 'web'
            ? `<a class="cite web" href="${esc(safeHttps(s.url))}" target="_blank" rel="noopener noreferrer" title="${esc('Web: ' + s.title)}">${n}</a>`
            : `<a class="cite" href="${esc(s.url)}" title="${esc(s.title + ' — ' + s.section)}">${n}</a>`;
        });
      if (/^\s*[-•]\s+/.test(raw)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${line.replace(/^\s*[-•]\s+/, '')}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      if (line.trim()) html += `<p>${line}</p>`;
    }
    return html + (inList ? '</ul>' : '');
  }

  const safeHttps = u => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : '#'; } catch { return '#'; } };
  function sourceList(sources) {
    if (!sources?.length) return '';
    const site = sources.map((s, i) => [s, i]).filter(([s]) => s.kind !== 'web');
    const web = sources.map((s, i) => [s, i]).filter(([s]) => s.kind === 'web');
    return `<div class="chat-sources"><span>From the site</span>${site.map(([s, i]) =>
      `<a href="${esc(s.url)}" title="${esc(s.section)}"><b>${i + 1}</b>${esc(s.title.split(' - ')[0])} · ${esc(s.section)}</a>`).join('')}</div>` +
      (web.length ? `<div class="chat-sources web"><span>General context from the web</span>${web.map(([s, i]) =>
        `<a href="${esc(safeHttps(s.url))}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)}"><b>${i + 1}</b>${esc(s.section)} · ${esc(s.title.slice(0, 70))}</a>`).join('')}</div>` : '');
  }

  function feedbackBar(m) {
    if (!FEEDBACK_ENDPOINT || !m.sig || m.local || m.offline) return '';
    if (m.vote) return `<p class="chat-vote done">${m.vote === 1 ? 'Thanks for the feedback.' : 'Thanks. This helps improve the assistant.'}</p>`;
    return `<p class="chat-vote" data-id="${esc(m.sig.slice(0, 32))}"><span>Was this helpful?</span><button type="button" data-vote="1" aria-label="Helpful">👍</button><button type="button" data-vote="-1" aria-label="Not helpful">👎</button></p>`;
  }
  async function vote(id, rating) {
    const i = state.messages.findIndex(m => m.role === 'assistant' && m.sig?.slice(0, 32) === id);
    if (i < 0) return;
    const m = state.messages[i];
    m.vote = rating; m.html = m.html.replace(/<p class="chat-vote"[\s\S]*?<\/p>$/, '') + feedbackBar(m); render();
    fetch(FEEDBACK_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thread_id: THREAD_ID, message_id: id, rating, question: rating === -1 ? state.messages[i - 1]?.content : undefined }) }).catch(() => {});
  }

  function traceView(meta, done) {
    if (!meta) return '';
    const t = meta.trace?.timings || {};
    const rows = meta.sources.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.section)}</td><td>${s.scores.bm25_rank ?? '—'}</td><td>${s.scores.dense_rank ?? '—'}</td><td>${s.scores.rrf ?? '—'}</td><td>${s.scores.rerank ?? '—'}</td></tr>`).join('');
    return `<details class="chat-trace"><summary>How this answer was built</summary>
      <p><b>Search query:</b> ${esc(meta.query)}${meta.rewritten ? ' <em>(rewritten from your follow-up)</em>' : ''}</p>
      ${meta.route ? `<p><b>Route:</b> site${meta.route.needs_web ? ` + web (“${esc(meta.route.web_query || '')}”: ${esc(meta.web?.status || '')}${meta.web?.cached ? ', cached' : ''})` : ''}${done?.supervisor ? ` · supervisor ${done.supervisor.pass ? 'passed' : 'failed'}${done.supervisor.attempts > 1 ? ` after ${done.supervisor.attempts} drafts` : ''}` : ''}${meta.cached ? ` · ${esc(meta.cached)} cache` : ''}</p>` : ''}
      <p><b>Pipeline:</b> ${esc(meta.trace?.mode || '')} · rewrite ${t.rewrite_ms ?? 0} ms · retrieve ${t.retrieve_ms ?? 0} ms${t.rerank_ms != null ? ` · rerank ${t.rerank_ms} ms` : ''}${done ? ` · total ${done.total_ms} ms · ${done.usage && !done.cached ? `${done.usage.input}→${done.usage.output} tokens${done.usage.cache_read ? ` (${done.usage.cache_read} cached)` : ''}` : 'cached answer'}` : ''}</p>
      <div class="trace-table"><table><thead><tr><th>#</th><th>Passage</th><th>BM25 rank</th><th>Vector rank</th><th>RRF</th><th>Rerank</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>`;
  }

  function mount(host) {
    host.innerHTML = `
      <div class="chat-log" aria-live="polite"></div>
      <div class="chat-suggest"></div>
      <form class="chat-form">
        <label class="sr-only" for="${host.id}-input">Ask a question about Jayce</label>
        <textarea id="${host.id}-input" rows="1" maxlength="600" placeholder="Ask about Jayce’s work…"></textarea>
        <button type="submit" class="chat-send">Ask</button>
      </form>
      <p class="chat-foot"><button type="button" class="chat-contact-btn">✉ Contact Jayce</button><span>AI answers can be wrong. Check the cited sources.</span><button type="button" class="chat-clear">Clear chat</button></p>
      <section class="chat-contact" hidden aria-label="Contact Jayce"></section>`;
    const v = { host, log: host.querySelector('.chat-log'), suggest: host.querySelector('.chat-suggest'),
      input: host.querySelector('textarea'), send: host.querySelector('.chat-send'), panel: host.querySelector('.chat-contact') };
    host.querySelector('.chat-contact-btn').addEventListener('click', () => openContact());
    v.log.addEventListener('click', e => {
      if (e.target.closest('.open-contact')) openContact();
      const b = e.target.closest('.chat-vote button');
      if (b) vote(b.parentElement.dataset.id, +b.dataset.vote);
    });
    wirePanel(v);
    v.suggest.innerHTML = SUGGESTIONS.map(s => `<button type="button">${esc(s)}</button>`).join('');
    v.suggest.addEventListener('click', e => { const b = e.target.closest('button'); if (b) ask(b.textContent); });
    host.querySelector('.chat-form').addEventListener('submit', e => { e.preventDefault(); if (state.busy) return stop(); ask(v.input.value); });
    v.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); host.querySelector('.chat-form').requestSubmit(); } });
    v.input.addEventListener('input', () => { v.input.style.height = 'auto'; v.input.style.height = Math.min(v.input.scrollHeight, 140) + 'px'; });
    host.querySelector('.chat-clear').addEventListener('click', () => { stop(); state.messages = []; Object.assign(state.contact, { sent: false, error: '' }); render(); renderPanels(); });
    views.push(v);
  }

  function render() {
    for (const v of views) {
      v.log.innerHTML = state.messages.length ? state.messages.map(m => m.role === 'user'
        ? `<div class="msg user"><p>${esc(m.content)}</p></div>`
        : `<div class="msg bot${m.pending ? ' pending' : ''}${m.offline ? ' offline' : ''}">${m.html || '<p class="typing"><span></span><span></span><span></span></p>'}${m.status ? `<p class="msg-status">${esc(m.status)}</p>` : ''}</div>`).join('')
        : `<div class="msg bot intro"><p>Hi! I’m an AI assistant grounded in Jayce’s résumé, CV and project notes. Ask me anything about Jayce’s work, and I’ll cite where each answer comes from.</p></div>`;
      v.suggest.hidden = state.messages.length > 0;
      v.send.textContent = state.busy ? 'Stop' : 'Ask';
      v.send.classList.toggle('stop', state.busy);
      v.log.scrollTop = v.log.scrollHeight;
    }
  }

  function stop() { state.controller?.abort(); }

  async function ask(text) {
    const q = (text || '').trim();
    if (!q || state.busy) return;
    views.forEach(v => { v.input.value = ''; v.input.style.height = 'auto'; });
    const history = state.messages.filter(m => !m.offline && !m.error && !m.local && !m.pending)
      .map(m => (m.role === 'assistant' ? { role: m.role, content: m.content, sig: m.sig || '' } : { role: m.role, content: m.content }));
    state.messages.push({ role: 'user', content: q });
    const bot = { role: 'assistant', content: '', pending: true, html: '' };
    state.messages.push(bot);
    state.busy = true; render();

    try {
      if (!CONFIGURED) throw Object.assign(new Error('offline'), { offline: true });
      state.controller = new AbortController();
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [...dedupe(history), { role: 'user', content: q }], thread_id: THREAD_ID, turn: ++turnCount }), signal: state.controller.signal });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Object.assign(new Error(err.error || `HTTP ${res.status}`), { status: res.status, offline: res.status >= 500 });
      }
      let meta = null, done = null;
      const paint = () => { bot.html = format(bot.content, meta?.sources) + (bot.contact ? contactCta() : '') + (done ? sourceList(meta?.sources) + traceView(meta, done) + feedbackBar(bot) : ''); render(); };
      await readSSE(res.body, (event, data) => {
        if (event === 'meta') meta = data;
        else if (event === 'delta') { bot.content += data.t; paint(); }
        else if (event === 'replace') { bot.content = data.t; bot.status = 'Revised after a fact check.'; paint(); }
        else if (event === 'done') { done = data; bot.sig = data.sig; }
        else if (event === 'error') throw Object.assign(new Error(data.message), { offline: data.code === 'quota' && !bot.content });
      });
      if (!bot.content) throw new Error('No answer came back. Please try again.');
      bot.pending = false;
      if (MARKER.test(bot.content) && HIRE_RE.test(q)) { bot.contact = true; preselect(q); openContact(false); }
      paint();
    } catch (e) {
      bot.pending = false;
      if (e.name === 'AbortError') { bot.status = 'Stopped.'; if (!bot.content) bot.html = '<p>Stopped.</p>'; bot.error = !bot.content; }
      else if (HIRE_RE.test(q) && !bot.content) {
        bot.local = true;
        bot.html = `<p>Jayce would be glad to hear from you. He’s open to freelance or contract work, full-time corporate roles and consulting. Use the contact form and your message goes straight to his inbox.</p>${contactCta()}`;
        preselect(q); openContact(false);
      }
      else if (e.offline || e instanceof TypeError) await offlineAnswer(q, bot);
      else { bot.error = true; bot.html = `<p>${esc(e.message)}</p>`; }
    } finally {
      state.busy = false; state.controller = null; render();
    }
  }

  // The API requires alternating roles; drop anything that would break that (e.g. after a stopped answer).
  function dedupe(msgs) {
    const out = [];
    for (const m of msgs) { if (out.length && out.at(-1).role === m.role) out.pop(); if (m.content) out.push(m); }
    if (out.at(-1)?.role === 'user') out.pop();
    return out;
  }

  async function readSSE(body, onEvent) {
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] || 'message';
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data) onEvent(event, JSON.parse(data));
      }
    }
  }

  async function offlineAnswer(q, bot) {
    bot.offline = true;
    try {
      if (!kbIndex) {
        const kb = await fetch(new URL('./kb.json', import.meta.url)).then(r => r.json());
        kbIndex = { chunks: kb.chunks, bm25: core.buildBm25(kb.chunks) };
      }
      const hits = core.searchBm25(kbIndex.bm25, q).slice(0, 2).map(h => kbIndex.chunks[h.index]);
      bot.html = hits.length
        ? `<p class="msg-status">The AI is offline right now, so here are the closest notes from Jayce’s profile:</p>` +
          hits.map((c, i) => `<blockquote><p><b>${esc(c.section)}</b> ${esc(c.text.length > 420 ? c.text.slice(0, 420) + '…' : c.text)}</p></blockquote>`).join('') + sourceList(hits)
        : `<p>The AI is offline right now and I couldn’t find a matching note. Email <a href="mailto:jayce.n.parabellum@gmail.com">jayce.n.parabellum@gmail.com</a>.</p>`;
    } catch {
      bot.html = `<p>The assistant is unavailable right now. Email <a href="mailto:jayce.n.parabellum@gmail.com">jayce.n.parabellum@gmail.com</a> or see the <a href="./Jayce-Parabellum-Resume.pdf">résumé</a>.</p>`;
    }
  }

  // ---- Contact Jayce: a form that opens over the chat log (so streaming answers never wipe what's typed) ----
  const contactCta = () => `<p class="contact-cta"><button type="button" class="open-contact">✉ Open the contact form</button></p>`;

  function preselect(q) {
    const d = state.contact.draft;
    if (d.type) return;
    if (/freelanc|contract|gig|part[- ]time/i.test(q)) d.type = 'freelance';
    else if (/consult|advis/i.test(q)) d.type = 'consulting';
    else if (/full[- ]time|corporate|permanent|salar|position|role|job|recruit|interview/i.test(q)) d.type = 'corporate';
  }

  function openContact(focus = true) {
    const c = state.contact;
    if (c.sent) { c.sent = false; c.error = ''; }
    if (!c.open) { c.open = true; c.openedAt = Date.now(); }
    renderPanels();
    if (focus) {
      const v = views.find(v => v.host.offsetParent) || views[0];
      v?.panel.querySelector('input[name="type"]:checked, input[name="type"]')?.focus();
    }
  }
  function closeContact() { state.contact.open = false; state.contact.error = ''; renderPanels(); }

  function transcriptText() {
    return state.messages.filter(m => m.role === 'user' || (m.content && !m.pending && !m.error))
      .map(m => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${visible(m.content)}`).join('\n\n').slice(-6000);
  }

  function mailtoHref() {
    const d = state.contact.draft;
    const subject = `Hiring inquiry · ${TYPES[d.type] || 'General'} · ${d.name}`.trim();
    const body = `${d.message}\n\n${d.name}${d.company ? `, ${d.company}` : ''}\n${d.email}`;
    return `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function panelHtml(v) {
    const c = state.contact, d = c.draft, id = v.host.id + '-cc';
    if (c.sent) return `<div class="cc-done" role="status"><p class="cc-title">Message sent ✓</p>
      <p>Thanks, ${esc(d.name.split(' ')[0] || 'there')}. Your note is in Jayce’s inbox, and he’ll reply to <b>${esc(d.email)}</b>.</p>
      <div class="cc-actions"><button type="button" class="cc-close cc-secondary">Back to the chat</button></div></div>`;
    const hasChat = state.messages.some(m => m.role === 'user');
    return `<form class="cc-form" novalidate>
      <div class="cc-head"><p class="cc-title">Contact Jayce</p><button type="button" class="cc-close cc-x" aria-label="Close the contact form">✕</button></div>
      <p class="cc-sub">Goes straight to Jayce’s inbox. He replies by email.</p>
      <fieldset class="cc-types"><legend>I’m reaching out about</legend>
        ${Object.entries(TYPES).map(([k, label]) => `<label><input type="radio" name="type" value="${k}"${d.type === k ? ' checked' : ''}/><span>${label}</span></label>`).join('')}
      </fieldset>
      <div class="cc-row">
        <label for="${id}-name">Name<input id="${id}-name" name="name" autocomplete="name" maxlength="100" value="${esc(d.name)}"/></label>
        <label for="${id}-email">Email<input id="${id}-email" name="email" type="email" autocomplete="email" maxlength="200" value="${esc(d.email)}"/></label>
      </div>
      <label for="${id}-company">Company <span class="cc-opt">(optional)</span><input id="${id}-company" name="company" autocomplete="organization" maxlength="120" value="${esc(d.company)}"/></label>
      <label for="${id}-message">Message<textarea id="${id}-message" name="message" rows="4" maxlength="4000" placeholder="The role or project, the timeline, and how Jayce could help">${esc(d.message)}</textarea></label>
      ${hasChat ? `<label class="cc-check"><input type="checkbox" name="transcript"${d.transcript ? ' checked' : ''}/> Include this chat so Jayce has context</label>` : ''}
      <div class="cc-hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"/></label></div>
      ${c.error ? `<p class="cc-error" role="alert">${esc(c.error)}${c.fallback ? ` <a href="${esc(mailtoHref())}">Open it in your email app instead</a>, or write to ${EMAIL}.` : ''}</p>` : ''}
      <div class="cc-actions"><button type="submit" class="cc-send"${c.sending ? ' disabled' : ''}>${c.sending ? 'Sending…' : 'Send to Jayce'}</button>
        <button type="button" class="cc-close cc-secondary">Cancel</button></div>
    </form>`;
  }

  function renderPanels() {
    for (const v of views) {
      v.panel.hidden = !state.contact.open;
      v.host.classList.toggle('contact-open', state.contact.open);
      if (state.contact.open) v.panel.innerHTML = panelHtml(v);
    }
  }

  function wirePanel(v) {
    v.panel.addEventListener('input', e => {
      const f = e.target;
      if (f.name && f.name in state.contact.draft) state.contact.draft[f.name] = f.type === 'checkbox' ? f.checked : f.type === 'radio' ? f.value : f.value;
    });
    v.panel.addEventListener('click', e => { if (e.target.closest('.cc-close')) { closeContact(); v.input.focus(); } });
    v.panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeContact(); v.input.focus(); } });
    v.panel.addEventListener('submit', e => { e.preventDefault(); submitContact(e.target); });
  }

  async function submitContact(form) {
    const c = state.contact, d = c.draft;
    if (c.sending) return;
    for (const k of ['name', 'email', 'company', 'message']) d[k] = form.elements[k].value.trim();
    d.type = form.querySelector('input[name="type"]:checked')?.value || '';
    d.website = form.elements.website.value;
    if (form.elements.transcript) d.transcript = form.elements.transcript.checked;
    const problem = !d.type ? 'Please choose freelance, corporate or consulting.'
      : d.name.length < 2 ? 'Please enter your name.'
      : !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(d.email) ? 'Please enter a valid email address so Jayce can reply.'
      : d.message.length < 10 ? 'Please add a short message (at least a sentence).' : '';
    c.fallback = false;
    if (problem) { c.error = problem; renderPanels(); return; }
    if (!CONTACT_ENDPOINT) { c.error = 'The contact form is offline right now.'; c.fallback = true; renderPanels(); return; }
    c.sending = true; c.error = ''; renderPanels();
    try {
      const payload = { type: d.type, name: d.name, email: d.email, company: d.company, message: d.message,
        transcript: d.transcript ? transcriptText() : '', website: d.website, elapsed_ms: Date.now() - c.openedAt };
      let res = await fetch(CONTACT_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
        .catch(() => null);
      let out = res ? await res.json().catch(() => ({})) : {};
      // The Worker's relay can be throttled (FormSubmit limits shared server IPs); then send from this browser instead.
      if (!res || res.status >= 500) ({ res, out } = await sendDirect(payload));
      if (!res.ok) throw Object.assign(new Error(out.error || 'Your message couldn’t be sent right now.'), { fallback: res.status !== 400 && res.status !== 429 });
      c.sent = true;
      state.messages.push({ role: 'assistant', local: true, content: '', html: `<p>✓ Your message is on its way to Jayce. He’ll reply to <b>${esc(d.email)}</b>.</p>` });
      render();
    } catch (e) {
      c.error = e instanceof TypeError ? 'Your message couldn’t be sent (network error).' : e.message;
      c.fallback = e instanceof TypeError || !!e.fallback;
    } finally { c.sending = false; renderPanels(); }
  }

  // Direct FormSubmit post from the visitor's browser (same fields the Worker sends).
  async function sendDirect(p) {
    if (p.website) return { res: { ok: true }, out: {} }; // honeypot: pretend success
    const r = await fetch(`https://formsubmit.co/ajax/${EMAIL}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ _subject: `Hiring inquiry · ${TYPES[p.type]} · ${p.name}${p.company ? ` (${p.company})` : ''}`.slice(0, 180),
        _template: 'table', _captcha: 'false', _honey: '', _replyto: p.email, Engagement: TYPES[p.type], Name: p.name, email: p.email,
        Company: p.company || '—', Message: p.message, ...(p.transcript ? { 'Chat before the form': p.transcript } : {}),
        Sent: `${new Date().toUTCString()} · website chat (direct)` }) }).catch(() => null);
    const o = r ? await r.json().catch(() => ({})) : {};
    const ok = !!r && r.ok && (String(o.success) === 'true' || /activat/i.test(o.message || ''));
    return { res: { ok, status: ok ? 200 : (r?.status || 0) || 502 }, out: ok ? {} : { error: 'Your message couldn’t be sent right now. Please email Jayce directly.' } };
  }

  // Floating launcher
  const launcher = document.getElementById('chat-launcher'), dialog = document.getElementById('chat-dialog');
  const setOpen = open => {
    dialog.hidden = !open; launcher.setAttribute('aria-expanded', String(open)); launcher.hidden = open;
    if (open) { render(); dialog.querySelector('textarea')?.focus(); }
  };
  launcher?.addEventListener('click', () => setOpen(true));
  // Every "Ask my AI" link opens the one chat panel.
  document.addEventListener('click', e => { const a = e.target.closest?.('a[href="#ask"]'); if (a && dialog) { e.preventDefault(); setOpen(true); } });
  document.getElementById('chat-close')?.addEventListener('click', () => { setOpen(false); launcher.focus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && dialog && !dialog.hidden) { setOpen(false); launcher.focus(); } });
  // Hide the launcher while the inline assistant is on screen, so there aren't two chat boxes in view.
  const inline = document.getElementById('chat-inline');
  if (inline && launcher) new IntersectionObserver(([e]) => launcher.classList.toggle('hide', e.isIntersecting && dialog.hidden), { threshold: 0.2 }).observe(inline);

  document.querySelectorAll('.chat-host').forEach(mount);
  render();

  // Warm the Worker (it loads passage embeddings) shortly after arrival and when a chat box gets focus,
  // at most every two minutes, so the visitor's first question skips that work.
  if (CONFIGURED) {
    let warmedAt = 0;
    const warm = () => {
      if (Date.now() - warmedAt < 120000) return;
      warmedAt = Date.now();
      fetch(ENDPOINT.replace(/\/chat\/?$/, '/health?warm=1')).catch(() => {});
    };
    setTimeout(warm, params.has('ask') ? 0 : 1500);
    document.addEventListener('focusin', e => { if (e.target.closest?.('.chat-host') || dialog?.contains(e.target)) warm(); });
  }

  // Deep links (the résumé QR code uses ?ask): ?ask opens the assistant, ?ask=contact opens the contact form.
  if (dialog && (params.has('ask') || location.hash === '#chat')) {
    const touch = matchMedia('(pointer:coarse)').matches;
    setOpen(true);
    if (touch) document.activeElement?.blur();
    if (params.get('ask') === 'contact') openContact(!touch);
  }
})();
