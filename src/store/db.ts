import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

const { DatabaseSync: DatabaseSyncImpl } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSync;
};

export interface StoreDb {
  db: DatabaseSync;
  fts: boolean;
}

export interface WriteQueue {
  enqueue<T>(job: () => Promise<T>): Promise<T>;
}

export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(job: () => Promise<T>): Promise<T> {
      const result = tail.then(job);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function probeFts(db: DatabaseSync): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.__fts_probe USING fts5(x, tokenize='trigram')");
    db.exec('DROP TABLE temp.__fts_probe');
    return true;
  } catch {
    return false;
  }
}

function consSearchSql(fts: boolean): string {
  if (fts) {
    return "CREATE VIRTUAL TABLE cons_search USING fts5(cons_id UNINDEXED, title, aliases, search_terms, applicability_text, body, tokenize='trigram')";
  }
  return `CREATE TABLE cons_search (
  cons_id TEXT NOT NULL,
  title TEXT NOT NULL,
  aliases TEXT NOT NULL,
  search_terms TEXT NOT NULL,
  applicability_text TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX idx_cons_search_cons_id ON cons_search(cons_id);`;
}

const BASE_SCHEMA = `
CREATE TABLE cons (
  id TEXT PRIMARY KEY,
  current_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cons_status ON cons(status);

CREATE TABLE cons_revisions (
  cons_id TEXT NOT NULL REFERENCES cons(id),
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  body TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  search_terms_json TEXT NOT NULL,
  applicability_text TEXT,
  spec_json TEXT,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (cons_id, revision)
);

CREATE TABLE cons_edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES cons(id),
  from_revision INTEGER NOT NULL,
  relation_cons_id TEXT NOT NULL REFERENCES cons(id),
  to_id TEXT NOT NULL REFERENCES cons(id),
  to_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_by_step_id TEXT
);
CREATE INDEX idx_cons_edges_from ON cons_edges(from_id);
CREATE INDEX idx_cons_edges_to ON cons_edges(to_id);
CREATE INDEX idx_cons_edges_relation ON cons_edges(relation_cons_id);

CREATE TABLE execution_bindings (
  cons_id TEXT NOT NULL REFERENCES cons(id),
  revision INTEGER NOT NULL,
  executor TEXT NOT NULL,
  primitive_key TEXT,
  active INTEGER NOT NULL,
  activated_by_step_id TEXT NOT NULL,
  PRIMARY KEY (cons_id, revision)
);
CREATE INDEX idx_execution_bindings_cons ON execution_bindings(cons_id, active);

CREATE TABLE method_bindings (
  action_id TEXT NOT NULL REFERENCES cons(id),
  method_id TEXT NOT NULL REFERENCES cons(id),
  method_revision INTEGER NOT NULL,
  active INTEGER NOT NULL,
  PRIMARY KEY (action_id, method_id)
);
CREATE INDEX idx_method_bindings_action ON method_bindings(action_id, active);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  entry_flow_ref_json TEXT NOT NULL,
  task TEXT NOT NULL,
  input_refs_json TEXT NOT NULL,
  status TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  counters_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  node_id TEXT NOT NULL,
  action_ref_json TEXT NOT NULL,
  method_ref_json TEXT,
  tendency_refs_json TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  llm_attempt_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_steps_run ON steps(run_id);

CREATE TABLE llm_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  request_json TEXT,
  response_json TEXT,
  model TEXT,
  usage_json TEXT,
  latency_ms INTEGER,
  error_code TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  step_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_run ON events(run_id, created_at);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  result_json TEXT,
  created_at TEXT NOT NULL
);
`;

interface Migration {
  version: number;
  name: string;
  apply: (db: DatabaseSync, fts: boolean) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    apply: (db, fts) => {
      db.exec(BASE_SCHEMA);
      db.exec(consSearchSql(fts));
    },
  },
  {
    version: 2,
    name: 'llm_attempts_unique_step_attempt',
    apply: (db) => {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_attempts_step_attempt ON llm_attempts(step_id, attempt_no)');
    },
  },
];

export function openDb(path: string): StoreDb {
  const db = new DatabaseSyncImpl(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const fts = probeFts(db);
  for (const m of MIGRATIONS) {
    const applied = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(m.version);
    if (applied !== undefined) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.apply(db, fts);
      db
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      db.close();
      throw err;
    }
  }
  const searchDef = db
    .prepare("SELECT sql FROM sqlite_master WHERE type IN ('table') AND name = 'cons_search'")
    .get() as { sql: string } | undefined;
  const ftsLive = searchDef !== undefined && searchDef.sql !== null && searchDef.sql.includes('fts5');
  return { db, fts: ftsLive };
}
