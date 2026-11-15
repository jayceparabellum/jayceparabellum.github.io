// rag-core.js: retrieval primitives shared by the Cloudflare Worker (chat-worker/) and the browser
// fallback (assets/chat.js). Pure functions, no dependencies, so both runtimes import the same code.

const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have he her his how i if in
into is it its me my of on or our she so than that the their them then there these they this to up was we were what
when where which who whom why will with would you your about tell jayce jayces parabellum nhan him`.split(/\s+/));

// Small domain thesaurus so keyword search survives vocabulary mismatch ("military" vs "Marine Corps").
// Expansions are added at lower weight than the user's own terms.
const SYNONYMS = {
  military: ['marine', 'usmc', 'air', 'force', 'usaf', 'guard', 'reserve', 'service', 'veteran'],
  army: ['military'], navy: ['naval'], veteran: ['military', 'service'],
  marines: ['marine', 'usmc'], marine: ['usmc'], usmc: ['marine'],
  airforce: ['usaf', 'air', 'force'], usaf: ['air', 'force'],
  job: ['role', 'experience', 'work'], jobs: ['role', 'experience'], current: ['present', 'teos'], now: ['present', 'teos'],
  degree: ['education', 'university', 'm.s', 'b.s'], school: ['education', 'university'], college: ['education', 'university'],
  masters: ['m.s', 'boulder'], master: ['m.s', 'boulder'],
  certs: ['certification', 'certifications'], certified: ['certification'], certificate: ['certification'],
  aws: ['cloud', 'govcloud'], cloud: ['aws', 'govcloud', 'azure'], kubernetes: ['k8s'],
  rag: ['retrieval', 'vector', 'embeddings'], retrieval: ['rag'], llm: ['ai', 'model', 'claude', 'openai'],
  ai: ['llm', 'ml'], agents: ['agent', 'langgraph'], agentic: ['agent', 'langgraph'],
  security: ['secure', 'stig', 'nist', 'clearance'], clearance: ['secret'],
  healthcare: ['clinical', 'hipaa', 'phi', 'nursing'], clinical: ['healthcare', 'hipaa'], medical: ['clinical'],
  government: ['federal', 'dcsa', 'nbis'], federal: ['government'], pentagon: ['army', 'secarmy'],
  hobbies: ['interests', 'off', 'clock', 'community'], hobby: ['interests'], fun: ['interests'],
  contact: ['email', 'linkedin'], email: ['contact'], phone: ['contact'], hire: ['contact', 'looking'],
  devops: ['ci/cd', 'deployment', 'terraform', 'pipeline'], cicd: ['ci/cd', 'pipeline'],
  evals: ['eval', 'evaluation'], eval: ['evaluation'], testing: ['tests', 'eval'],
  networking: ['network', 'cisco'], network: ['cisco', 'routing'], jet: ['engine', 'propulsion'], engines: ['propulsion'],
  chatbot: ['assistant', 'rag'], bot: ['assistant'], built: ['build'],
};

export function tokenize(text) {
  return (String(text).toLowerCase().normalize('NFKD').match(/[a-z0-9][a-z0-9./+#-]*[a-z0-9+#]|[a-z0-9]/g) || [])
    .map(t => t.replace(/[.]+$/, ''))
    .filter(t => t && !STOP.has(t));
}

// Light suffix stripping so "certifications" ~ "certification", "deployed" ~ "deploy".
export function stem(t) {
  if (t.length <= 4 || /\d/.test(t)) return t;
  return t.replace(/(ations|ation|ings|ing|ies|ied|ers|er|es|ed|s)$/, m => (m === 'ies' || m === 'ied') ? 'y' : '');
}

const terms = text => tokenize(text).map(stem);

/** Build a BM25 index over chunks of shape {id, title, section, text}. Title/section text is boosted. */
export function buildBm25(chunks, { k1 = 1.2, b = 0.75 } = {}) {
  const docs = chunks.map(c => {
    const tf = new Map();
    const add = (t, w) => tf.set(t, (tf.get(t) || 0) + w);
    for (const t of terms(c.text)) add(t, 1);
    for (const t of terms(`${c.title} ${c.section}`)) add(t, 2);
    let len = 0; for (const v of tf.values()) len += v;
    return { tf, len };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avg, N: docs.length, k1, b };
}

/** Score every chunk for a query. Returns [{index, score}] sorted desc, zero scores dropped. */
export function searchBm25(index, query) {
  const weights = new Map();
  for (const t of tokenize(query)) {
    weights.set(stem(t), Math.max(weights.get(stem(t)) || 0, 1));
    for (const s of SYNONYMS[t] || []) for (const st of terms(s)) if (!weights.has(st)) weights.set(st, 0.35);
  }
  const { docs, df, avg, N, k1, b } = index;
  const out = [];
  docs.forEach((d, i) => {
    let s = 0;
    for (const [t, w] of weights) {
      const f = d.tf.get(t); if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avg));
    }
    if (s > 0) out.push({ index: i, score: s });
  });
  return out.sort((a, b) => b.score - a.score);
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Reciprocal rank fusion over several ranked lists of {index}. k=60 per Cormack et al. */
export function rrf(lists, k = 60) {
  const fused = new Map();
  for (const list of lists) list.forEach((r, rank) => fused.set(r.index, (fused.get(r.index) || 0) + 1 / (k + rank + 1)));
  return [...fused].map(([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score);
}

/** Split a knowledge markdown file (front matter + "## Section" blocks) into chunks. */
export function chunkMarkdown(md, file) {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
  const meta = {};
  if (fm) for (const line of fm[1].split('\n')) { const m = /^(\w+):\s*"?(.*?)"?$/.exec(line); if (m) meta[m[1]] = m[2]; }
  const body = fm ? md.slice(fm[0].length) : md;
  const chunks = [];
  body.split(/^## /m).slice(1).forEach((block, i) => {
    const nl = block.indexOf('\n');
    const section = block.slice(0, nl).trim();
    const text = block.slice(nl + 1).replace(/\s+/g, ' ').trim();
    if (text) chunks.push({ id: `${file.replace(/\.md$/, '')}#${i}`, title: meta.title || file, section, url: meta.url || '#top', text });
  });
  return chunks;
}
