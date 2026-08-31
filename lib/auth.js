'use strict';

/* ===================================================================
   IRONPEAK GYM — staff authentication

   The dashboard exposes member CNIC numbers, dates of birth, home
   addresses and emergency contacts. Previously "Staff Login" was an
   ordinary link, so anyone who opened admin.html could read or delete
   all of it. Now every dashboard API call requires a session created
   by a scrypt-verified password login.
   =================================================================== */

const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_COOKIE = 'ironpeak_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // one working day

/* --- password hashing ------------------------------------------- */

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Hash a plaintext password as scrypt$salt$key, both hex encoded. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Constant time comparison of a password against a stored hash. */
function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return crypto.timingSafeEqual(actual, expected);
}

/* --- staff records ---------------------------------------------- */

function createStaff(username, password) {
  const row = db
    .prepare('INSERT INTO staff (username, password_hash) VALUES (?, ?) RETURNING id, username')
    .get(String(username).trim().toLowerCase(), hashPassword(password));
  return row;
}

function findStaffByUsername(username) {
  return db
    .prepare('SELECT id, username, password_hash FROM staff WHERE username = ?')
    .get(String(username).trim().toLowerCase());
}

function countStaff() {
  return db.prepare('SELECT COUNT(*) AS total FROM staff').get().total;
}

/* --- sessions --------------------------------------------------- */

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
}

/** Issue a fresh opaque session token for a staff member. */
function createSession(staffId) {
  purgeExpiredSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token, staff_id, expires_at) VALUES (?, ?, ?)').run(
    token,
    staffId,
    expiresAt,
  );
  return { token, expiresAt };
}

/** Resolve a token to its staff member, or null when invalid/expired. */
function getSessionStaff(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, st.id AS staff_id, st.username
         FROM sessions s
         JOIN staff st ON st.id = s.staff_id
        WHERE s.token = ?`,
    )
    .get(token);

  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    destroySession(token);
    return null;
  }
  return { id: row.staff_id, username: row.username };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/* --- cookies ---------------------------------------------------- */

function parseCookies(header) {
  const jar = Object.create(null);
  if (!header) return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      jar[name] = part.slice(index + 1).trim();
    }
  }
  return jar;
}

function sessionCookie(token, { secure }) {
  const flags = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

function clearedSessionCookie({ secure }) {
  const flags = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

/* --- login throttling ------------------------------------------- */

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginAttempts = new Map(); // key -> { count, firstAt }

/** True when this key has burned through its login budget. */
function isLoginBlocked(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  createStaff,
  findStaffByUsername,
  countStaff,
  createSession,
  getSessionStaff,
  destroySession,
  purgeExpiredSessions,
  parseCookies,
  sessionCookie,
  clearedSessionCookie,
  isLoginBlocked,
  recordLoginFailure,
  clearLoginFailures,
  LOGIN_MAX_ATTEMPTS,
};
