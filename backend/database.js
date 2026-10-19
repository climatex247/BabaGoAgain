'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const databasePath = process.env.BGA_DATABASE_PATH || path.join(__dirname, 'babagoagain.sqlite');
const temporaryPath = databasePath + '.tmp';

let db;
let readyPromise;

function saveDatabase() {
  const bytes = Buffer.from(db.export());
  fs.writeFileSync(temporaryPath, bytes, { mode: 0o600 });
  fs.renameSync(temporaryPath, databasePath);
}

async function initializeDatabase() {
  const SQL = await initSqlJs();

  db = fs.existsSync(databasePath)
    ? new SQL.Database(fs.readFileSync(databasePath))
    : new SQL.Database();

  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      preferred_language TEXT NOT NULL DEFAULT 'English',
      address TEXT NOT NULL,
      state_id TEXT NOT NULL,
      state_name TEXT NOT NULL,
      lga_id TEXT NOT NULL,
      lga_name TEXT NOT NULL,
      ward_id TEXT NOT NULL,
      ward_name TEXT NOT NULL,
      polling_unit_id TEXT,
      roles_json TEXT NOT NULL,
      other_role TEXT,
      password_hash TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0,
      email_verified INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_verification',
      accepted_terms INTEGER NOT NULL,
      accepted_privacy INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS post_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 1000),
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS community_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY(group_id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS community_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      starts_at TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS event_attendees (
      event_id TEXT NOT NULL REFERENCES community_events(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL,
      PRIMARY KEY(event_id, user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS volunteer_applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      interests TEXT NOT NULL,
      availability TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      UNIQUE(user_id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('volunteer_credit','payout_hold','payout_refund','admin_adjustment')),
      amount_kobo INTEGER NOT NULL CHECK(amount_kobo <> 0),
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      related_payout_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS wallet_payouts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_kobo INTEGER NOT NULL CHECK(amount_kobo > 0),
      recipient_type TEXT NOT NULL CHECK(recipient_type IN ('opay_wallet','bank')),
      recipient_name TEXT NOT NULL,
      recipient_data_encrypted TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','rejected')),
      opay_reference TEXT NOT NULL UNIQUE,
      opay_order_no TEXT,
      failure_reason TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      processed_by TEXT REFERENCES users(id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created ON wallet_transactions(user_id, created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_wallet_payouts_user_requested ON wallet_payouts(user_id, requested_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_wallet_payouts_status_requested ON wallet_payouts(status, requested_at)');

  db.run('CREATE INDEX IF NOT EXISTS idx_posts_created ON community_posts(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id, created_at)');

  try {
    db.run("ALTER TABLE users ADD COLUMN preferred_language TEXT NOT NULL DEFAULT 'English'");
  } catch (error) {
    if (!String(error.message).toLowerCase().includes('duplicate column')) throw error;
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_users_created_at
    ON users(created_at)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_verification_expiry
    ON email_verification_tokens(expires_at)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_reset_expiry
    ON password_reset_tokens(expires_at)
  `);


  try {
    db.run('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
  } catch (error) {
    if (!String(error.message).includes('duplicate column name')) throw error;
  }

  saveDatabase();
  return db;
}

function ready() {
  if (!readyPromise) {
    readyPromise = initializeDatabase().catch(error => {
      readyPromise = null;
      throw error;
    });
  }

  return readyPromise;
}

function execute(sql, parameters = []) {
  const statement = db.prepare(sql);

  try {
    statement.bind(parameters);

    if (!statement.step()) return null;

    return statement.getAsObject();
  } finally {
    statement.free();
  }
}

function queryAll(sql, parameters = []) {
  const statement = db.prepare(sql);

  try {
    statement.bind(parameters);

    const rows = [];

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }

    return rows;
  } finally {
    statement.free();
  }
}

async function run(sql, parameters = []) {
  await ready();
  db.run(sql, parameters);
  saveDatabase();

  return { changes: db.getRowsModified() };
}

async function get(sql, parameters = []) {
  await ready();
  return execute(sql, parameters);
}

async function all(sql, parameters = []) {
  await ready();
  return queryAll(sql, parameters);
}

async function transaction(callback) {
  await ready();

  db.run('BEGIN IMMEDIATE');

  try {
    const result = await callback({
      run: (sql, parameters = []) => {
        db.run(sql, parameters);
        return { changes: db.getRowsModified() };
      },
      get: (sql, parameters = []) => execute(sql, parameters),
      all: (sql, parameters = []) => queryAll(sql, parameters)
    });

    db.run('COMMIT');
    saveDatabase();

    return result;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ready,
  run,
  get,
  all,
  transaction
};
