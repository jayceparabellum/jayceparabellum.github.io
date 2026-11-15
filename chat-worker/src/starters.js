// starters.js: the suggestion chips in assets/chat.js (keep the two lists identical; a test checks this).
// Answers to these exact questions, asked with no history, are cached in KV per KB version and prompt,
// so the chips answer instantly. Only these fixed strings are ever used as keys; no visitor text is stored.
export const STARTERS = [
  'What does Jayce do at Teos Technology?',
  'Tell me about the TTB label verification tool',
  'What was Jayce’s military service?',
  'Which AWS certifications does Jayce hold?',
  'How was this chatbot built?',
  'I’d like to hire Jayce',
];

// FNV-1a, enough to tell prompt versions apart in a cache key.
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}
