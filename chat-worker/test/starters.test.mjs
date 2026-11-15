import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STARTERS, hash } from '../src/starters.js';

test('Worker starter list matches the chips in assets/chat.js', () => {
  const src = readFileSync(new URL('../../assets/chat.js', import.meta.url), 'utf8');
  const block = src.match(/const SUGGESTIONS = \[([\s\S]*?)\];/)[1];
  const chips = [...block.matchAll(/'([^']*)'/g)].map(m => m[1]);
  assert.deepEqual(chips, STARTERS);
});

test('hash is stable and distinguishes strings', () => {
  assert.equal(hash('abc'), hash('abc'));
  assert.notEqual(hash('abc'), hash('abd'));
});
