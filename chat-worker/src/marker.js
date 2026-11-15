// marker.js: the model ends hiring/contact replies with [[contact]], which the site turns into the contact form.
// Smaller models add it to unrelated answers too, so the Worker only lets it through when the visitor's
// own question shows hiring or contact intent (same rule as assets/chat.js), and strips it otherwise.
export const MARKER = '[[contact]]';
export const CONTACT_INTENT = /\b(hire|hiring|recruiting (for|him|jayce)|recruit (him|jayce)|interview|freelanc|contract(or|ing)?\b|consult|reach (out|him|jayce)|contact|get in touch|email (him|jayce)|work with (him|jayce)|(talk|speak|chat|meet) (to|with) (him|jayce)|connect with|full[- ]time|part[- ]time|opportunit|opening|job offer|position|(a|an|our|my|this) [\w -]{0,40}\b(role|job)\b|role for|(we|i)('re| are| am) looking|my team|our team)/i;

// Returns { push(text) -> text safe to emit now, flush() -> remaining text }.
// When keep is false, every [[contact]] is removed, even one split across streamed chunks.
export function markerFilter(keep) {
  let buf = '';
  const strip = s => (keep ? s : s.split(MARKER).join('').replace(/[ \t]+\n/g, '\n'));
  return {
    push(t) {
      buf += t;
      if (keep) { const out = buf; buf = ''; return out; }
      buf = buf.split(MARKER).join('');
      // hold back a tail that could be the start of a marker
      let hold = 0;
      for (let n = Math.min(MARKER.length - 1, buf.length); n > 0; n--) if (MARKER.startsWith(buf.slice(-n))) { hold = n; break; }
      hold += buf.slice(0, buf.length - hold).length - buf.slice(0, buf.length - hold).replace(/\s+$/, '').length; // and whitespace before it
      const out = buf.slice(0, buf.length - hold); buf = buf.slice(buf.length - hold);
      return out;
    },
    flush() { const out = strip(buf); buf = ''; return keep ? out : out.replace(/\s+$/, ''); },
  };
}
