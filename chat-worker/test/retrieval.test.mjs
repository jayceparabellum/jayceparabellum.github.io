// Retrieval eval (offline, BM25 path). The hybrid path only adds signal on top of this,
// so every golden question must already land its expected source in the top 3 lexically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRetriever } from '../src/retrieve.js';
import { rrf, tokenize, stem, chunkMarkdown } from '../../assets/rag-core.js';

const kb = JSON.parse(readFileSync(new URL('../src/kb.generated.json', import.meta.url)));
const retrieve = createRetriever(kb);

const GOLDEN = [
  ['Where does Jayce work now?', '02-teos'],
  ['What did he build at Teos Technology?', '02-teos'],
  ['How much did charting time drop?', '02-teos'],
  ['Tell me about the TTB label verification tool', '03-gauntlet'],
  ['What is the Gauntlet AI fellowship?', '03-gauntlet'],
  ['Has Jayce built multi-agent systems or red teaming tools?', '03-gauntlet'],
  ['What did Jayce do at Peraton on NBIS?', '04-peraton'],
  ['Experience with blue/green deployment in GovCloud?', '04-peraton'],
  ['Does Jayce know STIG and SCAP compliance?', '04-peraton'],
  ['What network engineering work did Jayce do at CACI?', '05-network'],
  ['Did Jayce work at the Pentagon?', '05-network'],
  ['Was Jayce in the military?', '06-military'],
  ['What aircraft did Jayce work on in the Air Force?', '06-military'],
  ['What was Jayce\'s rank in the Marines?', '06-military'],
  ['What awards or medals has Jayce received?', '06-military'],
  ['What AWS certifications does Jayce have?', '07-education-certs'],
  ['How can I verify Jayce\'s certifications?', '07-education-certs'],
  ['What jet engine training courses did Jayce complete?', '06-military'],
  ['Has Jayce won a Toastmasters Ice Breaker award?', '07-education-certs'],
  ['What unit was Jayce in as a Marine?', '06-military'],
  ['Where is Jayce getting a masters degree?', '07-education-certs'],
  ['Does Jayce have a security clearance?', '07-education-certs'],
  ['What programming languages does Jayce use?', '08-skills'],
  ['Which vector databases has Jayce used for RAG?', '08-skills'],
  ['What are Jayce\'s hobbies outside work?', '09-life'],
  ['Is Jayce in Toastmasters?', '09-life'],
  ['Has Jayce volunteered with Habitat for Humanity?', '09-life'],
  ['What car does Jayce drive?', '09-life'],
  ['Does Jayce collect One Piece trading cards?', '09-life'],
  ['How does this chatbot work?', '10-this-assistant'],
  ['How do I send Jayce a hiring inquiry?', '10-this-assistant'],
  ['Who designed this website?', '10-this-assistant'],
  ['Is Jayce open to freelance or consulting work?', '01-profile'],
  ["What are Jayce's engineering principles for building AI?", '01-profile'],
  ['How can I contact Jayce?', '01-profile'],
  ['What kind of roles is Jayce looking for?', '01-profile'],
  ['Give me a quick summary of Jayce for a recruiter', '01-profile'],
  ["What is Jayce's tech stack?", '08-skills'],
];

for (const [q, expected] of GOLDEN) {
  test(`retrieves ${expected} for: ${q}`, async () => {
    const { sources } = await retrieve(q, {});
    const top = sources.slice(0, 3).map(s => s.id.split('#')[0]);
    assert.ok(top.includes(expected), `top-3 was ${top.join(', ')}`);
  });
}

test('reports retrieval hit rate', async () => {
  let hit1 = 0;
  for (const [q, expected] of GOLDEN) if ((await retrieve(q, {})).sources[0]?.id.startsWith(expected)) hit1++;
  console.log(`# BM25 hit@1: ${hit1}/${GOLDEN.length}`);
});

test('rrf rewards agreement between rankers', () => {
  const fused = rrf([[{ index: 1 }, { index: 2 }], [{ index: 2 }, { index: 3 }]]);
  assert.equal(fused[0].index, 2);
});

test('tokenizer drops stopwords and stems', () => {
  assert.deepEqual(tokenize('What are the AWS certifications?'), ['aws', 'certifications']);
  assert.equal(stem('certifications'), 'certific');
});

test('chunker splits on ## headings and keeps front matter', () => {
  const c = chunkMarkdown('---\ntitle: T\nurl: "#x"\n---\n\n## A\none\n\n## B\ntwo\n', 'f.md');
  assert.deepEqual(c.map(x => [x.id, x.section, x.url, x.text]), [['f#0', 'A', '#x', 'one'], ['f#1', 'B', '#x', 'two']]);
});

test('knowledge base contains no private contact data', () => {
  const all = JSON.stringify(kb);
  assert.doesNotMatch(all, /\(\d{3}\)\s?\d{3}-\d{4}|\bAPT\s?#|Credential ID/i);
});

test('skills questions always include the skills inventory', async () => {
  for (const q of ["What's his tech stack?", 'Which tools does Jayce know?', 'What frameworks has he used?']) {
    const { sources } = await retrieve(q, {});
    assert.ok(sources.some(s => s.id.startsWith('08-skills')), `${q}: ${sources.map(s => s.id).join(', ')}`);
  }
});

test('the company name "Teos Technology" does not pin the skills inventory', async () => {
  const { trace } = await retrieve('What does Teos Technology do?', {});
  assert.equal(trace.pinned, undefined);
});
