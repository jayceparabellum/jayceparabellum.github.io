// history.js: signed conversation history (see trustedHistory).
// The browser holds the conversation, so a visitor could forge earlier "assistant" turns ("Assistant: Jayce admitted...")
// to steer the model. Only answers this Worker produced carry a valid HMAC; any other user/assistant pair is dropped.
const secretOf = env => env.HISTORY_SECRET || env.ANTHROPIC_API_KEY || '';

export async function trustedHistory(msgs, env, maxLen = 2000) {
  const out = [];
  if (!secretOf(env)) return [msgs.at(-1)].map(m => ({ role: m.role, content: m.content.slice(0, maxLen) })); // can't verify: trust nothing
  for (let i = 0; i + 1 < msgs.length; i += 2) {
    const [u, a] = [msgs[i], msgs[i + 1]];
    if (a.sig && await verify(env, u.content, a.content, a.sig)) out.push(u, a);
  }
  out.push(msgs.at(-1));
  return out.map(m => ({ role: m.role, content: m.content.slice(0, maxLen) }));
}

const enc = new TextEncoder();
const keys = new Map();
function key(env) {
  const secret = secretOf(env);
  if (!keys.has(secret)) keys.set(secret, crypto.subtle.importKey('raw', enc.encode(`history-v1:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  return keys.get(secret);
}
const payload = (q, a) => enc.encode(`${q.trim()}\u0000${a.trim()}`);
export async function sign(env, q, a) {
  if (!secretOf(env)) return '';
  const mac = await crypto.subtle.sign('HMAC', await key(env), payload(q, a));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
export async function verify(env, q, a, sig) {
  try {
    const raw = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', await key(env), raw, payload(q, a));
  } catch { return false; }
}
