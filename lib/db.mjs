import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
export async function openDatabase(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'payroll.sqlite');
  const db = new DatabaseSync(file);
  await chmod(file, 0o600);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  if (tables.length) {
    const names = new Set(tables.map((t) => t.name));
    if (!names.has('schema_versions')) {
      db.close();
      throw Error(
        'Legacy database detected. Preserve it and use a fresh DATA_DIR for reviewed import.',
      );
    }
    const v = db.prepare('SELECT max(version) version FROM schema_versions').get().version;
    if (v !== 1) {
      db.close();
      throw Error('Unsupported database schema. Restore or migrate in an isolated copy first.');
    }
    for (const [table, column] of [
      ['people', 'end_date'],
      ['salary_terms', 'profile'],
      ['auth_sessions', 'member_lesson_id'],
    ]) {
      if (
        !db
          .prepare('PRAGMA table_info(' + table + ')')
          .all()
          .some((c) => c.name === column)
      ) {
        db.close();
        throw Error('Pre-release schema detected. Do not overwrite; use a reviewed migration.');
      }
    }
  }

  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;',
  );
  db.exec(
    [
      'CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,profile TEXT NOT NULL,hire_month TEXT NOT NULL,end_date TEXT,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1)',
      "CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','employee')),person_id TEXT UNIQUE REFERENCES people(id),display_name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,must_change INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1)",
      'CREATE TABLE IF NOT EXISTS auth_sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL,password_version INTEGER NOT NULL,member_lesson_id TEXT)',
      'CREATE INDEX IF NOT EXISTS auth_expiry ON auth_sessions(expires)',
      'CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id),name TEXT NOT NULL,external_ref TEXT UNIQUE,created_at TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1)',
      'CREATE TABLE IF NOT EXISTS member_assignments(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),person_id TEXT NOT NULL REFERENCES people(id),effective_date TEXT NOT NULL,created_at TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS assignments_member ON member_assignments(member_id,effective_date)',
      'CREATE INDEX IF NOT EXISTS members_owner ON members(person_id,active,name,id)',
      "CREATE TABLE IF NOT EXISTS contracts(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id),person_id TEXT NOT NULL REFERENCES people(id),paid_date TEXT NOT NULL,start_date TEXT NOT NULL,category TEXT NOT NULL CHECK(category IN ('pt','pilates')),sale_type TEXT NOT NULL CHECK(sale_type IN ('new','renew')),amount INTEGER NOT NULL CHECK(amount>=0),quantity INTEGER NOT NULL CHECK(quantity>0),carry_used INTEGER NOT NULL DEFAULT 0 CHECK(carry_used>=0),carry_date TEXT NOT NULL,external_ref TEXT UNIQUE,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1)",
      'CREATE INDEX IF NOT EXISTS contracts_member ON contracts(member_id,active,paid_date,id)',
      'CREATE INDEX IF NOT EXISTS contracts_owner ON contracts(person_id,paid_date,id)',
      "CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY,person_id TEXT REFERENCES people(id),member_id TEXT REFERENCES members(id),contract_id TEXT REFERENCES contracts(id),date TEXT NOT NULL,category TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('sale','refund')),amount INTEGER NOT NULL,original_id TEXT REFERENCES sales(id),legacy_refund INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1)",
      'CREATE INDEX IF NOT EXISTS sales_month ON sales(date,person_id,category)',
      'CREATE INDEX IF NOT EXISTS sales_original ON sales(original_id)',
      "CREATE TABLE IF NOT EXISTS lessons(id TEXT PRIMARY KEY,contract_id TEXT NOT NULL REFERENCES contracts(id),person_id TEXT NOT NULL REFERENCES people(id),member_id TEXT NOT NULL REFERENCES members(id),date TEXT NOT NULL,time TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void')),reason TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL)",
      "CREATE UNIQUE INDEX IF NOT EXISTS lesson_slot ON lessons(contract_id,date,time) WHERE status='active'",
      'CREATE INDEX IF NOT EXISTS lessons_month ON lessons(person_id,date,time,id)',
      'CREATE INDEX IF NOT EXISTS lessons_contract ON lessons(contract_id,status,date,time,id)',
      'CREATE TABLE IF NOT EXISTS signatures(id TEXT PRIMARY KEY,lesson_id TEXT NOT NULL REFERENCES lessons(id),person_id TEXT NOT NULL REFERENCES people(id),snapshot TEXT NOT NULL,fingerprint TEXT NOT NULL,signed_at TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES accounts(id),payload_hash TEXT NOT NULL,confirmation TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS signatures_lesson ON signatures(lesson_id,signed_at,id)',
      'CREATE TABLE IF NOT EXISTS signature_payloads(signature_id TEXT PRIMARY KEY REFERENCES signatures(id),strokes TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS rules(id TEXT PRIMARY KEY,profile TEXT NOT NULL,effective_month TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(profile,effective_month))',
      'CREATE TABLE IF NOT EXISTS salary_terms(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id),effective_month TEXT NOT NULL,profile TEXT NOT NULL,base INTEGER NOT NULL,tax_bps INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,UNIQUE(person_id,effective_month))',
      "CREATE TABLE IF NOT EXISTS monthly_inputs(person_id TEXT NOT NULL REFERENCES people(id),month TEXT NOT NULL,hours100 INTEGER NOT NULL DEFAULT 0,extra INTEGER NOT NULL DEFAULT 0,deduction INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(person_id,month))",
      "CREATE TABLE IF NOT EXISTS periods(month TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),version INTEGER NOT NULL DEFAULT 1)",
      "CREATE TABLE IF NOT EXISTS payroll_runs(person_id TEXT NOT NULL REFERENCES people(id),month TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','submitted','approved')),snapshot_id TEXT,note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(person_id,month))",
      'CREATE TABLE IF NOT EXISTS payroll_versions(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id),month TEXT NOT NULL,body TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES accounts(id),created_at TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS payroll_history ON payroll_versions(month,person_id,created_at)',
      'CREATE TABLE IF NOT EXISTS source_batches(id TEXT PRIMARY KEY,month TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES accounts(id),count INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS source_records(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES source_batches(id),slot TEXT NOT NULL UNIQUE,person_id TEXT REFERENCES people(id),member_id TEXT REFERENCES members(id),contract_id TEXT REFERENCES contracts(id),date TEXT NOT NULL,time TEXT NOT NULL,end_time TEXT NOT NULL,instructor TEXT NOT NULL,member_name TEXT NOT NULL,state TEXT NOT NULL,ticket TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1)',
      'CREATE INDEX IF NOT EXISTS source_month ON source_records(date,person_id,id)',
      'CREATE TABLE IF NOT EXISTS review_decisions(month TEXT NOT NULL,item_key TEXT NOT NULL,note TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES accounts(id),fingerprint TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(month,item_key))',
      'CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT,action TEXT NOT NULL,entity TEXT NOT NULL,entity_id TEXT NOT NULL,reason TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS audit_page ON audit(id DESC)',
      'CREATE INDEX IF NOT EXISTS members_global ON members(active,name,id)',
      'CREATE INDEX IF NOT EXISTS lessons_global_month ON lessons(date,id)',
      'CREATE INDEX IF NOT EXISTS sales_owner ON sales(person_id,date,id)',
      'CREATE INDEX IF NOT EXISTS source_global_month ON source_records(date,id)',
      'CREATE TABLE IF NOT EXISTS idempotency(actor_id TEXT NOT NULL,key TEXT NOT NULL,route TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(actor_id,key))',
      "CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit immutable');END",
      "CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit immutable');END",
      "CREATE TRIGGER IF NOT EXISTS signature_no_update BEFORE UPDATE ON signatures BEGIN SELECT RAISE(ABORT,'signature immutable');END",
      "CREATE TRIGGER IF NOT EXISTS signature_no_delete BEFORE DELETE ON signatures BEGIN SELECT RAISE(ABORT,'signature immutable');END",
      "CREATE TRIGGER IF NOT EXISTS payload_no_update BEFORE UPDATE ON signature_payloads BEGIN SELECT RAISE(ABORT,'signature immutable');END",
      "CREATE TRIGGER IF NOT EXISTS payload_no_delete BEFORE DELETE ON signature_payloads BEGIN SELECT RAISE(ABORT,'signature immutable');END",
      "CREATE TRIGGER IF NOT EXISTS payroll_no_update BEFORE UPDATE ON payroll_versions BEGIN SELECT RAISE(ABORT,'payroll immutable');END",
      "CREATE TRIGGER IF NOT EXISTS payroll_no_delete BEFORE DELETE ON payroll_versions BEGIN SELECT RAISE(ABORT,'payroll immutable');END",
      "INSERT OR IGNORE INTO schema_versions VALUES(1,datetime('now'))",
    ].join(';') + ';',
  );
  return {
    db,
    file,
    one: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = fn();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    backup: (target) => backup(db, target),
    close: () => db.close(),
  };
}
