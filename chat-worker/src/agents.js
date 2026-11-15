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

export function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function orchestrate(llm, { question, history, memory }) {
  const guess = guessRoute(question);
  const fallback = { rewritten_query: question, ...guess, source: 'heuristic' };
  try {
    const transcript = history.slice(-6).map(m => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content.slice(0, 400)}`).join('\n');
    const user = `${memory ? `<earlier_summary>\n${memory}\n</earlier_summary>\n` : ''}<conversation>\n${transcript}\nVisitor: ${question}\n</conversation>\nJSON:`;
    const j = parseJson(await llm.complete(ORCHESTRATOR_PROMPT, user, { max_tokens: 120 }));
    if (!j) return fallback;
    const rewritten = typeof j.rewritten_query === 'string' && j.rewritten_query.trim() && j.rewritten_query.length < 300 ? j.rewritten_query.trim() : question;
    // The model may say needs_web for a question about Jayce; the hard rule wins.
    const needs_web = !!j.needs_web && !ABOUT_JAYCE_RE.test(question);
    const web_query = needs_web ? (typeof j.web_query === 'string' && j.web_query.trim() ? j.web_query.trim() : guess.web_query) : null;
    return { rewritten_query: history.length ? rewritten : question, needs_web: needs_web && !!web_query, web_query, source: 'model' };
  } catch { return fallback; }
}

// ---- Supervisor ----

export const FALLBACK_REPLY = "I couldn't find that on the site. For anything the site doesn't cover, you can email Jayce at jayce.n.parabellum@gmail.com.";
export const SITE_LABEL = 'From the site:';
export const WEB_LABEL = 'General context from the web:';

// Structural checks that need no model: citation numbers exist, labels match the sources used,
// and web sources are cited only inside the web section.
export function checkStructure(draft, sources) {
  const nSite = sources.filter(s => s.kind !== 'web').length;
  const nAll = sources.length;
  const cites = [...draft.matchAll(/\[(\d+)\]/g)].map(m => +m[1]);
  if (cites.some(n => n < 1 || n > nAll)) return { pass: false, reason: 'cites a source number that does not exist' };
  const webIdx = draft.indexOf(WEB_LABEL.replace(':', ''));
  const hasWeb = nAll > nSite;
  if (!hasWeb && webIdx >= 0) return { pass: false, reason: 'has a web section but no web sources were provided' };
  if (hasWeb) {
    const before = webIdx >= 0 ? draft.slice(0, webIdx) : draft;
    if ([...before.matchAll(/\[(\d+)\]/g)].some(m => +m[1] > nSite)) return { pass: false, reason: 'a web source is cited outside the "General context from the web" section' };
  }
  return { pass: true };
}

export const SUPERVISOR_PROMPT = `You check a chatbot answer about Jayce Parabellum before it is shown. Sources marked kind="site" are the only truth about Jayce. Sources marked kind="web" may only explain general concepts.
Reply with one JSON object and nothing else: {"pass": boolean, "reason": string}
Fail (pass=false) only for a clear problem:
1. The answer states a specific fact about Jayce (an employer, title, date, number, certification, project, award or skill) that no site source supports.
2. The answer presents something from a web source as a fact about Jayce.
Otherwise pass. Refusals, greetings, "I don't have that detail" replies, hiring or contact replies, and general explanations of concepts all pass. Paraphrasing and summarizing site sources pass. Missing citations alone are not a failure. Keep reason under 20 words.`;

export async function supervise(llm, { draft, sources }) {
  const structural = checkStructure(draft, sources);
  if (!structural.pass) return { ...structural, by: 'structure' };
  if (!/[A-Za-z]{3}/.test(draft)) return { pass: true, by: 'structure' };
  try {
    const blocks = sources.map((s, i) => `<source n="${i + 1}" kind="${s.kind || 'site'}">${s.text.slice(0, 900)}</source>`).join('\n');
    const j = parseJson(await llm.complete(SUPERVISOR_PROMPT, `<sources>\n${blocks}\n</sources>\n<answer>\n${draft.slice(0, 3000)}\n</answer>\nJSON:`, { max_tokens: 60 }));
    if (!j || typeof j.pass !== 'boolean') return { pass: true, by: 'model', reason: 'unparseable check, passed' };
    return { pass: j.pass, reason: String(j.reason || '').slice(0, 200), by: 'model' };
  } catch { return { pass: true, by: 'model', reason: 'check unavailable' }; }
}

// ---- Memory ----

export const SUMMARY_PROMPT = `Summarize this part of a website visitor's chat with an assistant about Jayce Parabellum's career in at most 3 short sentences: which topics the visitor asked about and what they seemed to care about. Don't include names, email addresses, phone numbers or other contact details of the visitor. Output only the summary.`;

export async function summarize(llm, messages) {
  const transcript = messages.map(m => `${m.role === 'user' ? 'Visitor' : 'Assistant'}: ${m.content.slice(0, 500)}`).join('\n');
  const text = await llm.complete(SUMMARY_PROMPT, `<conversation>\n${transcript}\n</conversation>\nSummary:`, { max_tokens: 150 });
  return String(text || '').trim().slice(0, 800);
}
