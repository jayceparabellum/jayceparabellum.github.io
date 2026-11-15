// Retrieval eval (offline, BM25 path). The hybrid path only adds signal on top of this,
// so every golden question must already land its expected source in the top 3 lexically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRetriever } from '../src/retrieve.js';
import { rrf, tokenize, stem, chunkMarkdown } from '../../assets/rag-core.js';

const kb = JSON.parse(readFileSync(new URL('../src/kb.generated.json', import.meta.url)));
const retrieve = createRetriever(kb);

import { GOLDEN } from './golden.mjs';

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

test('STIG work is found both by the acronym and by "security hardening"', async () => {
  for (const q of ['STIG', 'security hardening']) {
    const { sources } = await retrieve(q, {});
    assert.ok(sources.some(s => /STIG/.test(s.text)), `${q}: ${sources.map(s => s.id).join(', ')}`);
  }
});

test('every chunk has a stable content hash and a unique id', () => {
  const ids = new Set(kb.chunks.map(c => c.id));
  assert.equal(ids.size, kb.chunks.length);
  assert.ok(kb.chunks.every(c => /^[0-9a-f]{12}$/.test(c.hash)));
});
