-- Runtime state for the chat Worker (Cloudflare D1). Personal facts never live here; only the KB does.
-- Every row that holds visitor text is scoped to one browser visit (thread_id) and expires.

CREATE TABLE IF NOT EXISTS semantic_cache (
  id               TEXT PRIMARY KEY,
  scope_key        TEXT NOT NULL,          -- the visit's thread_id; never shared across visitors
  question         TEXT NOT NULL,
  question_vec     BLOB NOT NULL,          -- Float32 embedding (EMBED_DIM)
  answer           TEXT NOT NULL,
  meta             TEXT NOT NULL,          -- JSON: sources shown with the answer
  source_chunks    TEXT NOT NULL,          -- JSON: [{id, hash}] used for invalidation
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS semantic_cache_scope ON semantic_cache (scope_key, expires_at);

CREATE TABLE IF NOT EXISTS conversation_memory (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  summary     TEXT NOT NULL,
  turn_start  INTEGER NOT NULL,
  turn_end    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_memory_thread ON conversation_memory (thread_id, created_at);

CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  comment     TEXT,
  question    TEXT,                        -- only sent when the visitor down-votes, for the eval set
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS feedback_once ON feedback (thread_id, message_id);
