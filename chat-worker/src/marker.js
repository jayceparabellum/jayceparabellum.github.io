// marker.js: the model ends hiring/contact replies with [[contact]], which the site turns into the contact form.
// Smaller models add it to unrelated answers too, so the Worker only lets it through when the visitor's
// own question shows hiring or contact intent aimed at Jayce, and strips it otherwise. Bare nouns like
// "position", "contract" or "full-time" don't count: they appear in ordinary questions about his jobs.
export const MARKER = '[[contact]]';
export const CONTACT_INTENT = /\b(hire|hiring|recruiting for|recruit (him|jayce)|freelanc|(talk|speak|chat|meet) (to|with) (him|jayce)|reach (out|him|jayce)|contact (him|jayce)|get in touch|email (him|jayce)|work with (him|jayce)|connect with (him|jayce)|job offer|interview (him|jayce)|(we|i)('re| are| am) looking for|opening (on|in|at|for) (our|my)|(our|my) (team|company|startup|org)\b|is (he|jayce) (available|open to)|available for (a |an )?(contract|freelance|consult|full[- ]time|part[- ]time|role|job|work|hire|opportunit)|consult(ing)? (for|with) (us|me|our|my)|(a|an) consulting (project|engagement|gig|role)|contract (with|for) (us|me|our|my))/i;

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
