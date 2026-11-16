import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRetriever } from '../src/retrieve.js';

const kb = JSON.parse(readFileSync(new URL('../src/kb.generated.json', import.meta.url)));
const retrieve = createRetriever(kb);

// Fake Workers AI: embeddings fail (BM25 only), and the reranker buries every network-engineering chunk.
const env = { AI: { async run(model, input) {
  if (model.includes('reranker')) return { response: input.contexts.map((c, id) => ({ id, score: /CACI - Network|Phacil - Systems/.test(c.text) ? 0 : 0.9 })) };
  throw new Error('no embeddings in tests');
} } };

test('a reranker that buries the named section cannot drop it', async () => {
  const { sources, trace } = await retrieve('What network engineering work did Jayce do at CACI?', env);
  assert.ok(trace.mode.includes('rerank'));
  assert.ok(sources.some(s => /^05-network/.test(s.id) && /CACI/.test(s.section)), sources.map(s => s.id).join(', '));
  assert.deepEqual(trace.pinned_entities?.length, 1);
});
