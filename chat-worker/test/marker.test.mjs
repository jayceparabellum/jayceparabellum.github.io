import test from 'node:test';
import assert from 'node:assert/strict';
import { markerFilter, CONTACT_INTENT } from '../src/marker.js';

const run = (keep, chunks) => { const f = markerFilter(keep); return chunks.map(c => f.push(c)).join('') + f.flush(); };

test('strips a marker split across chunks when there is no contact intent', () => {
  assert.equal(run(false, ['He builds AI [1]. ', '[[con', 'tact]] ']), 'He builds AI [1].');
  assert.equal(run(false, ['A [', '[', 'contact', ']]\n']), 'A');
});
test('keeps ordinary brackets and citations', () => {
  assert.equal(run(false, ['See [1] and [', '2].']), 'See [1] and [2].');
});
test('keeps the marker when the visitor wants to get in touch', () => {
  assert.equal(run(true, ['Glad to hear from you.\n', '[[contact]]']), 'Glad to hear from you.\n[[contact]]');
});
test('intent detection', () => {
  assert.ok(CONTACT_INTENT.test('I want to hire Jayce for a consulting project'));
  assert.ok(CONTACT_INTENT.test('How do I get in touch?'));
  assert.ok(!CONTACT_INTENT.test('What does Jayce do at Teos Technology?'));
  assert.ok(!CONTACT_INTENT.test('How many pull requests did Jayce merge there?'));
  for (const q of ["I'd like to talk to Jayce about a full-time AI engineer role.", 'We have an opening on our platform team', 'Is he available for a contract role?', "We're looking for a solutions architect"])
    assert.ok(CONTACT_INTENT.test(q), q);
  for (const q of ["What is Jayce's current role?", 'What did he do in the Marines?', 'Which jobs has Jayce held?', 'Tell me about his AWS certifications', 'How does this chat work?'])
    assert.ok(!CONTACT_INTENT.test(q), q);
});

test('a recruiter asking for a summary does not trigger the contact form', () => {
  assert.ok(!CONTACT_INTENT.test('Give me a 3-bullet summary of Jayce for a recruiter'));
  assert.ok(!CONTACT_INTENT.test("I'm a recruiter, what are his strongest skills?"));
  assert.ok(CONTACT_INTENT.test("I'm recruiting for a platform engineer role"));
  assert.ok(CONTACT_INTENT.test('We want to hire Jayce'));
});
