// contact.js: hiring inquiries from the chat's "Contact Jayce" form, relayed to Jayce's inbox through Resend.
// POST /contact {type, name, email, company?, message, transcript?, website(honeypot), elapsed_ms}
// The recipient address lives in the Worker (CONTACT_TO), never in the request, so this can't be used as an open relay.

export const TYPES = {
  freelance: 'Freelance / contract',
  corporate: 'Full-time / corporate role',
  consulting: 'Consulting',
};

const LIMITS = { name: 100, email: 200, company: 120, message: 4000, transcript: 6000 };
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

export class ContactError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const clean = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const oneLine = s => s.replace(/[\r\n]+/g, ' ');

export function validateContact(body) {
  if (!body || typeof body !== 'object') throw new ContactError('Bad request');
  const form = {
    type: clean(body.type, 20),
    name: oneLine(clean(body.name, LIMITS.name)),
    email: oneLine(clean(body.email, LIMITS.email)),
    company: oneLine(clean(body.company, LIMITS.company)),
    message: clean(body.message, LIMITS.message),
    transcript: clean(body.transcript, LIMITS.transcript),
  };
  // Bots fill the hidden "website" field or submit instantly. Pretend success so they don't retry.
  const spam = !!clean(body.website, 200) || (Number(body.elapsed_ms) >= 0 && Number(body.elapsed_ms) < 1200);
  if (!TYPES[form.type]) throw new ContactError('Please choose freelance, corporate or consulting.');
  if (form.name.length < 2) throw new ContactError('Please enter your name.');
  if (!EMAIL_RE.test(form.email)) throw new ContactError('Please enter a valid email address so Jayce can reply.');
  if (form.message.length < 10) throw new ContactError('Please add a short message (at least a sentence).');
  return { form, spam };
}

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function composeEmail(form, { to, from, meta = {} }) {
  const label = TYPES[form.type];
  const subject = `Hiring inquiry · ${label} · ${form.name}${form.company ? ` (${form.company})` : ''}`.slice(0, 180);
  const rows = [['Engagement', label], ['Name', form.name], ['Email', form.email], ['Company', form.company || '—'],
    ['Sent', meta.when || new Date().toISOString()], ['From', meta.country ? `Website chat · ${meta.country}` : 'Website chat']];
  const text = `${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${form.message}\n` +
    (form.transcript ? `\n--- Chat before the form ---\n${form.transcript}\n` : '') +
    `\nReply to this email to answer ${form.name} directly.`;
  const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,Arial,sans-serif;color:#1d2330;max-width:620px">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#6b7280">New hiring inquiry from your website</p>
<h2 style="margin:0 0 14px;font-size:20px;color:#16305E">${esc(label)} · ${esc(form.name)}</h2>
<table style="border-collapse:collapse;font-size:14px;margin-bottom:16px">${rows.map(([k, v]) =>
    `<tr><td style="padding:3px 14px 3px 0;color:#6b7280">${k}</td><td style="padding:3px 0">${k === 'Email' ? `<a href="mailto:${esc(v)}">${esc(v)}</a>` : esc(v)}</td></tr>`).join('')}</table>
<div style="white-space:pre-wrap;background:#f4f7fb;border:1px solid #e2e7ef;border-radius:8px;padding:14px 16px">${esc(form.message)}</div>
${form.transcript ? `<details style="margin-top:14px"><summary style="cursor:pointer;color:#1A56B0">Chat before the form</summary><pre style="white-space:pre-wrap;font:13px/1.5 Consolas,monospace;color:#4a5161">${esc(form.transcript)}</pre></details>` : ''}
<p style="margin-top:16px;font-size:13px;color:#6b7280">Reply to this email to answer ${esc(form.name)} directly.</p></div>`;
  return { from, to: [to], reply_to: form.email, subject, text, html };
}

export async function sendContact(body, env, meta = {}, fetchImpl = fetch) {
  const { form, spam } = validateContact(body);
  if (spam) return { ok: true, skipped: true };
  if (!env.CONTACT_TO) throw new ContactError('The contact form isn’t set up yet. Please email Jayce directly.', 503);
  const result = env.RESEND_API_KEY ? await viaResend(form, env, meta, fetchImpl) : await viaFormSubmit(form, env, meta, fetchImpl);
  console.log(JSON.stringify({ contact: form.type, via: result.via }));
  return { ok: true, id: result.id || null };
}

const failed = () => new ContactError('Your message couldn’t be sent right now. Please email Jayce directly.', 502);

async function viaResend(form, env, meta, fetchImpl) {
  const email = composeEmail(form, { to: env.CONTACT_TO, from: env.CONTACT_FROM || 'Jayce’s website <onboarding@resend.dev>', meta });
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(email),
  });
  if (!res.ok) { console.error('resend', res.status, (await res.text().catch(() => '')).slice(0, 300)); throw failed(); }
  return { via: 'resend', id: (await res.json().catch(() => ({}))).id };
}

// FormSubmit (formsubmit.co): free, no account or key. The first message sends Jayce a one-time "Activate" email;
// after that, messages arrive normally. FORMSUBMIT_ID (the random alias from that email) can replace the address.
async function viaFormSubmit(form, env, meta, fetchImpl) {
  const target = encodeURIComponent(env.FORMSUBMIT_ID || env.CONTACT_TO);
  const site = (env.SITE_URL || 'https://jayceparabellum.github.io').replace(/\/$/, '');
  const { subject } = composeEmail(form, { to: env.CONTACT_TO, from: '', meta });
  const res = await fetchImpl(`https://formsubmit.co/ajax/${target}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: site, referer: `${site}/` },
    body: JSON.stringify({
      _subject: subject, _template: 'table', _captcha: 'false', _replyto: form.email,
      Engagement: TYPES[form.type], Name: form.name, email: form.email, Company: form.company || '—', Message: form.message,
      ...(form.transcript ? { 'Chat before the form': form.transcript } : {}),
      Sent: `${meta.when || new Date().toUTCString()}${meta.country ? ` · ${meta.country}` : ''} · website chat`,
    }),
  });
  const out = await res.json().catch(() => ({}));
  // FormSubmit answers 200 with success "false" plus a message, e.g. while activation is pending.
  if (!res.ok || String(out.success) !== 'true') {
    console.error('formsubmit', res.status, JSON.stringify(out).slice(0, 300));
    if (/activat/i.test(out.message || '')) return { via: 'formsubmit-activation' };
    throw failed();
  }
  return { via: 'formsubmit' };
}
