'use strict';

/* ===================================================================
   IRONPEAK GYM — database

   Storage is a single SQLite file under data/. It replaces the old
   localStorage approach, which kept every record trapped inside one
   browser: a member filling the form on their phone was invisible to
   the dashboard on the gym computer.

   Client codes come from an AUTOINCREMENT rowid, so a deleted member
   never frees its number for reuse. The previous "clients.length + 1"
   scheme handed the same IP0004 to two different people.
   =================================================================== */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.GYM_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.GYM_DB_FILE || path.join(DATA_DIR, 'ironpeak.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS clients (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    code              TEXT    NOT NULL UNIQUE,
    name              TEXT    NOT NULL,
    father_name       TEXT    NOT NULL DEFAULT '',
    phone             TEXT    NOT NULL,
    email             TEXT    NOT NULL DEFAULT '',
    cnic              TEXT    NOT NULL DEFAULT '',
    gender            TEXT    NOT NULL DEFAULT '',
    dob               TEXT    NOT NULL DEFAULT '',
    address           TEXT    NOT NULL DEFAULT '',
    emergency_contact TEXT    NOT NULL DEFAULT '',
    plan              TEXT    NOT NULL,
    plan_price        INTEGER NOT NULL,
    join_date         TEXT    NOT NULL,
    last_paid_date    TEXT    NOT NULL,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_clients_name  ON clients (name);
  CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients (phone);

  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id    INTEGER NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    paid_on      TEXT    NOT NULL,
    covers_until TEXT    NOT NULL,
    amount       INTEGER NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_payments_client ON payments (client_id);

  CREATE TABLE IF NOT EXISTS staff (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    staff_id   INTEGER NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
`);

/** Format a numeric id as a member code: 7 becomes IP0007. */
function formatCode(id) {
  return 'IP' + String(id).padStart(4, '0');
}

module.exports = { db, formatCode, DB_FILE, DATA_DIR };
