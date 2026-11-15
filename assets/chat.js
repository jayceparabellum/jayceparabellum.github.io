// chat.js: streaming chat UI for the RAG assistant (Cloudflare Worker in chat-worker/).
// One conversation is shared by the inline panel (#chat-inline) and the floating panel (#chat-floating).
// If the backend is unreachable or not yet configured, it falls back to in-browser BM25 over assets/kb.json
// and shows the closest source notes instead of an AI answer.
(async () => {
  const core = await import('./rag-core.js');
  const metaEndpoint = document.querySelector('meta[name="chat-endpoint"]')?.content || '';
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const override = new URLSearchParams(location.search).get('chat');
  const ENDPOINT = override || (local ? 'http://127.0.0.1:8787/chat' : metaEndpoint);
  const CONFIGURED = ENDPOINT && !/YOUR-SUBDOMAIN/.test(ENDPOINT);

  const SUGGESTIONS = [
    'What does Jayce do at Teos Technology?',
    'Tell me about the TTB label verification tool',
    'What was Jayce’s military service?',
    'Which AWS certifications does Jayce hold?',
    'How was this chatbot built?',
  ];

  const state = { messages: [], busy: false, controller: null };
  const views = [];
  let kbIndex = null;

  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Minimal, safe formatter: escape first, then **bold**, "- " bullets, [n] citations, paragraphs.
  function format(text, sources = []) {
    const lines = esc(text.trim()).split('\n');
    let html = '', inList = false;
    for (const raw of lines) {
      const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[(\d+)\]/g, (m, n) => {
          const s = sources[n - 1];
          return s ? `<a class="cite" href="${esc(s.url)}" title="${esc(s.title + ' — ' + s.section)}">${n}</a>` : '';
        });
      if (/^\s*[-•]\s+/.test(raw)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${line.replace(/^\s*[-•]\s+/, '')}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      if (line.trim()) html += `<p>${line}</p>`;
    }
    return html + (inList ? '</ul>' : '');
  }

  function sourceList(sources) {
    if (!sources?.length) return '';
    return `<div class="chat-sources"><span>Sources</span>${sources.map((s, i) =>
      `<a href="${esc(s.url)}" title="${esc(s.section)}"><b>${i + 1}</b>${esc(s.title.split(' - ')[0])} · ${esc(s.section)}</a>`).join('')}</div>`;
  }

  function traceView(meta, done) {
    if (!meta) return '';
    const t = meta.trace?.timings || {};
    const rows = meta.sources.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.section)}</td><td>${s.scores.bm25_rank ?? '—'}</td><td>${s.scores.dense_rank ?? '—'}</td><td>${s.scores.rrf ?? '—'}</td><td>${s.scores.rerank ?? '—'}</td></tr>`).join('');
    return `<details class="chat-trace"><summary>How this answer was built</summary>
      <p><b>Search query:</b> ${esc(meta.query)}${meta.rewritten ? ' <em>(rewritten from your follow-up)</em>' : ''}</p>
      <p><b>Pipeline:</b> ${esc(meta.trace?.mode || '')} · rewrite ${t.rewrite_ms ?? 0} ms · retrieve ${t.retrieve_ms ?? 0} ms${t.rerank_ms != null ? ` · rerank ${t.rerank_ms} ms` : ''}${done ? ` · total ${done.total_ms} ms · ${done.usage.input}→${done.usage.output} tokens${done.usage.cache_read ? ` (${done.usage.cache_read} cached)` : ''}` : ''}</p>
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
      <p class="chat-foot">AI answers can be wrong. Check the cited sources. <button type="button" class="chat-clear">Clear chat</button></p>`;
    const v = { host, log: host.querySelector('.chat-log'), suggest: host.querySelector('.chat-suggest'),
      input: host.querySelector('textarea'), send: host.querySelector('.chat-send') };
    v.suggest.innerHTML = SUGGESTIONS.map(s => `<button type="button">${esc(s)}</button>`).join('');
    v.suggest.addEventListener('click', e => { const b = e.target.closest('button'); if (b) ask(b.textContent); });
    host.querySelector('.chat-form').addEventListener('submit', e => { e.preventDefault(); if (state.busy) return stop(); ask(v.input.value); });
    v.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); host.querySelector('.chat-form').requestSubmit(); } });
    v.input.addEventListener('input', () => { v.input.style.height = 'auto'; v.input.style.height = Math.min(v.input.scrollHeight, 140) + 'px'; });
    host.querySelector('.chat-clear').addEventListener('click', () => { stop(); state.messages = []; render(); });
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
    const history = state.messages.filter(m => !m.offline && !m.error).map(m => ({ role: m.role, content: m.content }));
    state.messages.push({ role: 'user', content: q });
    const bot = { role: 'assistant', content: '', pending: true, html: '' };
    state.messages.push(bot);
    state.busy = true; render();

    try {
      if (!CONFIGURED) throw Object.assign(new Error('offline'), { offline: true });
      state.controller = new AbortController();
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [...dedupe(history), { role: 'user', content: q }] }), signal: state.controller.signal });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw Object.assign(new Error(err.error || `HTTP ${res.status}`), { status: res.status, offline: res.status >= 500 });
      }
      let meta = null, done = null;
      const paint = () => { bot.html = format(bot.content, meta?.sources) + (done ? sourceList(meta?.sources) + traceView(meta, done) : ''); render(); };
      await readSSE(res.body, (event, data) => {
        if (event === 'meta') meta = data;
        else if (event === 'delta') { bot.content += data.t; paint(); }
        else if (event === 'done') { done = data; }
        else if (event === 'error') throw new Error(data.message);
      });
      if (!bot.content) throw new Error('No answer came back. Please try again.');
      bot.pending = false; paint();
    } catch (e) {
      bot.pending = false;
      if (e.name === 'AbortError') { bot.status = 'Stopped.'; if (!bot.content) bot.html = '<p>Stopped.</p>'; bot.error = !bot.content; }
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

  // Floating launcher
  const launcher = document.getElementById('chat-launcher'), dialog = document.getElementById('chat-dialog');
  const setOpen = open => {
    dialog.hidden = !open; launcher.setAttribute('aria-expanded', String(open)); launcher.hidden = open;
    if (open) { render(); dialog.querySelector('textarea')?.focus(); }
  };
  launcher?.addEventListener('click', () => setOpen(true));
  document.getElementById('chat-close')?.addEventListener('click', () => { setOpen(false); launcher.focus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && dialog && !dialog.hidden) { setOpen(false); launcher.focus(); } });
  // Hide the launcher while the inline assistant is on screen, so there aren't two chat boxes in view.
  const inline = document.getElementById('chat-inline');
  if (inline && launcher) new IntersectionObserver(([e]) => launcher.classList.toggle('hide', e.isIntersecting && dialog.hidden), { threshold: 0.2 }).observe(inline);

  document.querySelectorAll('.chat-host').forEach(mount);
  render();
})();
