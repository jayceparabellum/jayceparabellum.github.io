// llm.js: the two model calls the chat needs (query rewrite, streamed answer), behind one interface.
// Default: open models on Cloudflare Workers AI (free daily allowance, no API key; uses the AI binding).
// If an ANTHROPIC_API_KEY secret is set, Claude Haiku is used instead.
import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-haiku-5-5';
export const WORKERS_CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const WORKERS_REWRITE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

// Workers AI's stream drops the whitespace-only token that Llama emits before a number, so "June 2028"
// arrives as "June" + "2028". Re-insert the space when a lowercase word (or , ; : ) ]) is followed by a digit.
// Uppercase-final chunks are left alone so part numbers like "CFM56" and "TF34" stay intact.
export function fixSpacing(prev, t) {
  // Only after a whole word ("June", "in"): never inside "1,500", "10:30", "p95" or "v1.5".
  return /(?:^|\s)[A-Za-z][a-z]+$/.test(prev) && /^\d/.test(t) ? ' ' + t : t;
}

export function createLLM(env) {
  if (env.ANTHROPIC_API_KEY) return claude(env);
  if (env.AI) return workersAI(env);
  return null;
}

function claude(env) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
  return {
    name: CLAUDE_MODEL,
    async complete(system, user, { max_tokens = 200 } = {}) {
      const r = await client.messages.create({ model: CLAUDE_MODEL, max_tokens, output_config: { effort: 'low' }, system, messages: [{ role: 'user', content: user }] });
      return r.content.find(b => b.type === 'text')?.text || '';
    },
    async stream(system, messages, onText) {
      const s = client.messages.stream({ model: CLAUDE_MODEL, max_tokens: 1200, output_config: { effort: 'low' },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages });
      for await (const ev of s) if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') await onText(ev.delta.text);
      const f = await s.finalMessage();
      if (f.stop_reason === 'refusal') await onText("I can't help with that one. Feel free to ask about Jayce's experience, projects or skills.");
      return { stop_reason: f.stop_reason, usage: { input: f.usage.input_tokens, output: f.usage.output_tokens, cache_read: f.usage.cache_read_input_tokens || 0 } };
    },
  };
}

function workersAI(env) {
  const chatModel = env.CHAT_MODEL || WORKERS_CHAT_MODEL;
  const rewriteModel = env.REWRITE_MODEL || WORKERS_REWRITE_MODEL;
  return {
    name: chatModel.split('/').pop(),
    // Small, fast model for control decisions (orchestrator, supervisor, summaries); big: true uses the writer model.
    async complete(system, user, { max_tokens = 80, big = false } = {}) {
      const r = await env.AI.run(big ? chatModel : rewriteModel, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens, temperature: 0 });
      const out = r?.response ?? r?.choices?.[0]?.message?.content ?? '';
      // For JSON-looking replies Workers AI may hand back an already-parsed object; keep the contract a string.
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
    async stream(system, messages, onText) {
      const body = await env.AI.run(chatModel, { messages: [{ role: 'system', content: system }, ...messages], stream: true, max_tokens: 900, temperature: 0.2 });
      let usage = { input: 0, output: 0, cache_read: 0 }, buf = '', prev = '', finish = null;
      const reader = body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          let t = j.response ?? j.choices?.[0]?.delta?.content;
          if (t) { t = fixSpacing(prev, t); prev = t; await onText(t); }
          if (j.usage) usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0, cache_read: 0 };
          finish = j.choices?.[0]?.finish_reason || j.finish_reason || finish;
        }
      }
      // Workers AI doesn't always report a finish reason; treat output at the token cap as cut off.
      const cut = finish === 'length' || usage.output >= 900;
      return { stop_reason: cut ? 'length' : 'end', usage };
    },
  };
}
