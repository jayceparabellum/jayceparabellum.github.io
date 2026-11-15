import test from 'node:test';
import assert from 'node:assert/strict';
import { fixSpacing } from '../src/llm.js';

test('re-inserts the space Workers AI drops before numbers', () => {
  assert.equal(fixSpacing('Boulder in June', '2028'), ' 2028');
  assert.equal(fixSpacing('service in', '2022-2023'), ' 2022-2023');
  assert.equal(fixSpacing('Cohort', '4'), ' 4');
});
test('leaves part numbers, hyphens and existing spaces alone', () => {
  assert.equal(fixSpacing('GE CFM', '56-7'), '56-7');
  assert.equal(fixSpacing('the C-', '5M'), '5M');
  assert.equal(fixSpacing('in June', ' 2028'), ' 2028');
  assert.equal(fixSpacing('expected June 20', '28'), '28');
});
