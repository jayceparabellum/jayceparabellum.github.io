// agents.js: the small-model control nodes (Build Plan §4.2, §4.4, §4.7).
//   orchestrate()  plan + route: rewritten query, whether general web context is needed, and the web query
//   supervise()    grounding + labeling check on a finished draft (deterministic checks, then a model check)
//   summarize()    rolling conversation summary for this visit's memory
// Each returns a safe default on any failure, so a broken control call never blocks an answer.

// Concept questions ("What is a STIG?", "explain SCAP") are the only ones that may use the web.
const CONCEPT_RE = /^\s*(what(’|')?s|what (is|are|does)|explain|define|meaning of|what do(es)? .{1,40} (mean|stand for)|how does .{1,60} work)\b/i;
const ABOUT_JAYCE_RE = /\b(jayce|parabellum|he|his|him|he's)\b/i;

// Cheap first guess, used to start the web search speculatively before the orchestrator answers.
export function guessRoute(question) {
  const concept = CONCEPT_RE.test(question) && !ABOUT_JAYCE_RE.test(question);
  const web_query = concept ? question.replace(CONCEPT_RE, '').replace(/^\s*(a|an|the)\s+/i, '').replace(/[?.!]+$/, '').trim() : null;
  return { needs_web: concept && !!web_query, web_query: concept ? web_query : null };
}

export const ORCHESTRATOR_PROMPT = `You route questions for a chatbot about Jayce Parabellum's career. Reply with one JSON object and nothing else:
{"rewritten_query": string, "needs_web": boolean, "web_query": string or null}
- rewritten_query: the latest question as one standalone search query for Jayce's knowledge base. Resolve pronouns and references using earlier turns. If it is already standalone, repeat it.
- needs_web: true only when the visitor asks what a general concept, technology, standard, acronym or program is or how it works (for example "What is a STIG?", "What does SCAP stand for?", "How does RAG work?"). False for anything about Jayce himself, his roles, dates, employers or opinions, and false for greetings, hiring or contact requests.
- web_query: when needs_web is true, the concept alone in at most 6 words, with no person's name (for example "STIG security technical implementation guide"). Otherwise null.`;

// The first balanced {...} that parses. A greedy match would run to the last brace in the reply
// ("{"pass": false} (see {3})") and fail to parse, which used to count as a pass.
export function parseJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '');
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { break; } }
    }
  }
  return null;
}

export async function orchestrate(llm, { question, history, memory }) {
  const guess = guessRoute(question);
  const fallback = { rewritten_query: question, ...guess, source: 'heuristic' };
  // A first question about Jayce has nothing to rewrite and can never use the web: the answer is known, skip the call.
  if (!history.length && ABOUT_JAYCE_RE.test(question)) return { rewritten_query: question, needs_web: false, web_query: null, source: 'rule' };
  try {
    const transcript = history.slice(-6).map(m => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content.slice(0, 400)}`).join('\n');
    const user = `${memory ? `<earlier_summary>\n${memory}\n</earlier_summary>\n` : ''}<conversation>\n${transcript}\nVisitor: ${question}\n</conversation>\nJSON:`;
    const j = parseJson(await llm.complete(ORCHESTRATOR_PROMPT, user, { max_tokens: 120 }));
    if (!j) return { ...fallback, source: 'heuristic-unparsed' };
    const rewritten = typeof j.rewritten_query === 'string' && j.rewritten_query.trim() && j.rewritten_query.length < 300 ? j.rewritten_query.trim() : question;
    // The model may say needs_web for a question about Jayce; the hard rule wins.
    const needs_web = !!j.needs_web && !ABOUT_JAYCE_RE.test(question);
    const web_query = needs_web ? (typeof j.web_query === 'string' && j.web_query.trim() ? j.web_query.trim() : guess.web_query) : null;
    return { rewritten_query: history.length ? rewritten : question, needs_web: needs_web && !!web_query, web_query, source: 'model' };
  } catch (e) { return { ...fallback, error: String(e?.message || e).slice(0, 120) }; }
}

// ---- Supervisor ----

export const FALLBACK_REPLY = "I couldn't find that on the site. For anything the site doesn't cover, you can email Jayce at jayce.n.parabellum@gmail.com.";
export const SITE_LABEL = 'From the site:';
export const WEB_LABEL = 'General context from the web:';

// Structural checks that need no model: citation numbers exist, labels match the sources used,
// and web sources are cited only inside the web section.
// Citation numbers, including lists and ranges: [1], [1, 2], [1-3].
const citeNums = text => [...text.matchAll(/\[(\d+(?:\s*[-,–]\s*\d+)*)\]/g)].flatMap(m => m[1].split(/\s*,\s*/).flatMap(part => {
  const [a, b] = part.split(/\s*[-–]\s*/).map(Number);
  return b && b >= a && b - a < 20 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
}));

// The only links an answer may contain: this site, Jayce's Credly profile, LinkedIn and GitHub.
const ALLOWED_LINK = /^(?:www\.)?(?:jayceparabellum\.github\.io(?:[/?#]|$)|credly\.com\/users\/jayce-parabellum|linkedin\.com\/in\/jayce-parabellum|github\.com\/jayceparabellum(?:[/?#]|$))/i;
export function offSiteLinks(draft) {
  const found = [
    ...[...draft.matchAll(/\]\(\s*([^)\s]+)\s*\)/g)].map(m => m[1]),                  // markdown link targets
    ...[...draft.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>()\[\]"']+/gi)].map(m => m[0]),  // bare URLs
  ];
  return found.map(u => u.replace(/^https?:\/\//i, '').replace(/[.,;:!?]+$/, '')).filter(u => u && !u.startsWith('#') && !ALLOWED_LINK.test(u) && !/^mailto:jayce\.n\.parabellum@gmail\.com$/i.test(u));
}

// Figures the draft states that appear in no source and not in the question ("about 10 years" when the
// site says 16; a computed total). Years, citation numbers and one-digit counts are left to the model check.
export function unsupportedNumbers(draft, sources, question = '') {
  const norm = s => s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const pool = norm(sources.map(s => s.text).join(' ') + ' ' + question);
  const have = new Set(pool.match(/\d+(?:\.\d+)?/g) || []);
  const body = norm(draft.replace(/\[(\d+(?:\s*[-,–]\s*\d+)*)\]/g, ' '));
  return [...new Set(body.match(/\d+(?:\.\d+)?/g) || [])].filter(n => n.length >= 2 && !(n.length === 4 && /^(19|20)\d\d$/.test(n)) && !have.has(n));
}

export function checkStructure(draft, sources, question = '') {
  if (!draft.trim()) return { pass: false, reason: 'empty answer' };
  const nSite = sources.filter(s => s.kind !== 'web').length;
  const nAll = sources.length;
  const cites = citeNums(draft);
  if (cites.some(n => n < 1 || n > nAll)) return { pass: false, reason: 'cites a source number that does not exist' };
  const links = offSiteLinks(draft);
  if (links.length) return { pass: false, reason: `contains a link that is not on Jayce's site or profiles (${links[0].slice(0, 60)}); remove it` };
  const nums = unsupportedNumbers(draft, sources, question);
  if (nums.length)
    return { pass: false, reason: `states figures no source gives (${nums.slice(0, 3).join(', ')}); use only numbers exactly as the sources state them and do not add or compute totals` };
  const labelRe = /^[\W_]*general context from the web[\W_]*:/im;
  const webIdx = draft.search(labelRe);
  const hasWeb = nAll > nSite;
  if (!hasWeb && webIdx >= 0) return { pass: false, reason: 'has a web section but no web sources were provided' };
  if (hasWeb) {
    const before = webIdx >= 0 ? draft.slice(0, webIdx) : draft;
    if (citeNums(before).some(n => n > nSite)) return { pass: false, reason: 'a web source is cited outside the "General context from the web" section' };
  }
  return { pass: true };
}

export const SUPERVISOR_PROMPT = `You check a chatbot answer about Jayce Parabellum before it is shown. Sources marked kind="site" are the only truth about Jayce. Sources marked kind="web" may only explain general concepts.
Reply with one JSON object and nothing else: {"pass": boolean, "reason": string}
Fail (pass=false) only for a clear problem:
1. The answer states a specific fact about Jayce (an employer, title, date, number, certification, project, award or skill) that no site source supports.
2. The answer presents something from a web source as a fact about Jayce.
3. The answer states a number, total or duration that no source states, for example by adding figures together, computing years from dates, or rounding.
Otherwise pass. Refusals, greetings, "I don't have that detail" replies, hiring or contact replies, and general explanations of concepts all pass. Paraphrasing and summarizing site sources pass. Missing citations alone are not a failure. Keep reason under 20 words.`;

export async function supervise(llm, { draft, sources, question = '' }) {
  const structural = checkStructure(draft, sources, question);
  if (!structural.pass) return { ...structural, by: 'structure' };
  if (!/[A-Za-z]{3}/.test(draft)) return { pass: false, reason: 'the answer has no text', by: 'structure' };
  try {
    const blocks = sources.map((s, i) => `<source n="${i + 1}" kind="${s.kind || 'site'}">${s.text.slice(0, 900)}</source>`).join('\n');
    const j = parseJson(await llm.complete(SUPERVISOR_PROMPT, `<sources>\n${blocks}\n</sources>\n<answer>\n${draft.slice(0, 3000)}\n</answer>\nJSON:`, { max_tokens: 60 }));
    const pass = typeof j?.pass === 'boolean' ? j.pass : j?.pass === 'false' ? false : j?.pass === 'true' ? true : null;
    // An unreadable verdict still passes (a broken check must not block answers), but it is labeled so the trace and logs show it.
    if (pass === null) return { pass: true, by: 'model-unparsed', reason: 'unparseable check, passed' };
    return { pass, reason: String(j.reason || '').slice(0, 200), by: 'model' };
  } catch { return { pass: true, by: 'model-error', reason: 'check unavailable' }; }
}

// ---- Memory ----

export const SUMMARY_PROMPT = `Summarize this part of a website visitor's chat with an assistant about Jayce Parabellum's career in at most 3 short sentences: which topics the visitor asked about and what they seemed to care about. Don't include names, email addresses, phone numbers or other contact details of the visitor. Output only the summary.`;

export async function summarize(llm, messages) {
  const transcript = messages.map(m => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content.slice(0, 500)}`).join('\n');
  const text = await llm.complete(SUMMARY_PROMPT, `<conversation>\n${transcript}\n</conversation>\nSummary:`, { max_tokens: 150 });
  return String(text || '').trim().slice(0, 800);
}
