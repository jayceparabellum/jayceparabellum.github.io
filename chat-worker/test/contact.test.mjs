import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContact, composeEmail, sendContact, ContactError } from '../src/contact.js';

const good = { type: 'consulting', name: 'Ada Lovelace', email: 'ada@example.com', company: 'Analytical Co',
  message: 'We need help shipping a RAG assistant next quarter.', website: '', elapsed_ms: 15000 };
const env = { RESEND_API_KEY: 're_test', CONTACT_TO: 'jayce.n.parabellum@gmail.com' };

test('accepts a complete inquiry for each engagement type', () => {
  for (const type of ['freelance', 'corporate', 'consulting']) assert.equal(validateContact({ ...good, type }).spam, false);
});

test('rejects missing or invalid fields with a helpful message', () => {
  for (const [patch, re] of [[{ type: 'other' }, /freelance/], [{ name: '' }, /name/], [{ email: 'nope' }, /email/],
    [{ email: 'a@b.c\nBcc: x@y.z' }, /email/], [{ message: 'hi' }, /message/]]) {
    assert.throws(() => validateContact({ ...good, ...patch }), e => e instanceof ContactError && re.test(e.message));
  }
});

test('flags honeypot and instant submissions as spam', () => {
  assert.equal(validateContact({ ...good, website: 'http://spam' }).spam, true);
  assert.equal(validateContact({ ...good, elapsed_ms: 200 }).spam, true);
});

test('email goes only to CONTACT_TO, replies to the visitor, and escapes HTML', () => {
  const form = validateContact({ ...good, name: '<img src=x onerror=alert(1)>', message: '<script>x</script> long enough' }).form;
  const e = composeEmail(form, { to: env.CONTACT_TO, from: 'site <onboarding@resend.dev>' });
  assert.deepEqual(e.to, ['jayce.n.parabellum@gmail.com']);
  assert.equal(e.reply_to, 'ada@example.com');
  assert.match(e.subject, /^Hiring inquiry · Consulting · /);
  assert.doesNotMatch(e.html, /<script>|<img src=x/);
  assert.match(e.html, /&lt;script&gt;/);
});

test('a "to" field in the request cannot redirect the email', async () => {
  let sent;
  await sendContact({ ...good, to: 'attacker@example.com', CONTACT_TO: 'attacker@example.com' }, env, {},
    async (url, init) => { sent = JSON.parse(init.body); return new Response('{"id":"1"}', { status: 200 }); });
  assert.deepEqual(sent.to, ['jayce.n.parabellum@gmail.com']);
});

test('sends through Resend with the API key, and skips spam silently', async () => {
  let calls = 0, auth;
  const fake = async (url, init) => { calls++; auth = init.headers.authorization; assert.equal(url, 'https://api.resend.com/emails'); return new Response('{"id":"abc"}'); };
  assert.deepEqual(await sendContact(good, env, {}, fake), { ok: true, id: 'abc' });
  assert.equal(auth, 'Bearer re_test');
  assert.deepEqual(await sendContact({ ...good, website: 'bot' }, env, {}, fake), { ok: true, skipped: true });
  assert.equal(calls, 1);
});

test('without a Resend key it posts to FormSubmit for CONTACT_TO, from the site origin', async () => {
  let url, init;
  const fake = async (u, i) => { url = u; init = i; return new Response('{"success":"true","message":"sent"}'); };
  assert.deepEqual(await sendContact({ ...good, to: 'x@evil.example' }, { CONTACT_TO: 'jayce.n.parabellum@gmail.com' }, {}, fake), { ok: true, id: null });
  assert.equal(url, 'https://formsubmit.co/ajax/jayce.n.parabellum%40gmail.com');
  const b = JSON.parse(init.body);
  assert.equal(b.Engagement, 'Consulting'); assert.equal(b._replyto, 'ada@example.com'); assert.match(b._subject, /^Hiring inquiry · Consulting/);
  assert.equal(init.headers.origin, 'https://jayceparabellum.github.io');
  await assert.rejects(sendContact(good, { CONTACT_TO: 'a@b.co' }, {}, async () => new Response('{"success":"false","message":"Form should POST"}')), e => e.status === 502);
});

test('reports 503 when not configured and 502 when Resend fails', async () => {
  await assert.rejects(sendContact(good, {}, {}, fetch), e => e.status === 503);
  await assert.rejects(sendContact(good, env, {}, async () => new Response('bad', { status: 422 })), e => e.status === 502);
});
