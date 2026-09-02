'use strict';

/* ===================================================================
   IRONPEAK GYM backend server
   Express serves the static site from /public
   Client records are stored in SQLite (data/gym.db)
   Staff dashboard endpoints are protected by a login session
   Run with: npm start (then open http://localhost:3000)
   =================================================================== */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');

/* ---- Config (from .env if present, else defaults) ---------------- */
const envPath = path.join(__dirname, '.env');
const envLoaded = fs.existsSync(envPath);
try { process.loadEnvFile(envPath); } catch { /* no .env, use defaults */ }

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const STAFF_USER = process.env.STAFF_USER || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'ironpeak@2026';
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] SESSION_SECRET not set using a random one. Staff will be logged out on restart. Set SESSION_SECRET in .env to keep sessions across restarts.');
}
const SESSION_HOURS = 12;

/* ---- Plans (server is the source of truth for prices) ------------ */
const PLANS = { Monthly: 3500, Quarterly: 9500, Annual: 32000 };
function planCycleDays(plan) {
  if (plan === 'Quarterly') return 90;
  if (plan === 'Annual') return 365;
  return 30; // Monthly
}

/* ---- Date helpers (LOCAL time fixes the UTC off by one bug) ----- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((new Date(by, bm - 1, bd) - new Date(ay, am - 1, ad)) / 86400000);
}
function displayId(n) { return 'IP' + String(n).padStart(4, '0'); }

function feeInfo(client) {
  const dueDate = addDays(client.lastPaidDate, planCycleDays(client.plan));
  const daysLeft = daysBetween(todayStr(), dueDate);
  let status = 'paid';
  if (daysLeft < 0) status = 'overdue';
  else if (daysLeft <= 5) status = 'due';
  return { dueDate, daysLeft, status };
}

/* ---- Database ---------------------------------------------------- */
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'gym.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL,
    fatherName        TEXT NOT NULL DEFAULT '',
    phone             TEXT NOT NULL,
    email             TEXT NOT NULL DEFAULT '',
    cnic              TEXT NOT NULL DEFAULT '',
    gender            TEXT NOT NULL DEFAULT '',
    dob               TEXT NOT NULL DEFAULT '',
    address           TEXT NOT NULL DEFAULT '',
    emergencyContact  TEXT NOT NULL DEFAULT '',
    plan              TEXT NOT NULL,
    planPrice         INTEGER NOT NULL DEFAULT 0,
    joinDate          TEXT NOT NULL,
    lastPaidDate      TEXT NOT NULL,
    createdAt         TEXT NOT NULL,
    approvalStatus    TEXT NOT NULL DEFAULT 'active'
  );
`);
// Migration for databases created before approvalStatus existed.
try { db.exec(`ALTER TABLE clients ADD COLUMN approvalStatus TEXT NOT NULL DEFAULT 'active'`); } catch { /* column already exists */ }

const insertClient = db.prepare(`
  INSERT INTO clients
    (name, fatherName, phone, email, cnic, gender, dob, address, emergencyContact, plan, planPrice, joinDate, lastPaidDate, createdAt, approvalStatus)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectAll = db.prepare('SELECT * FROM clients ORDER BY id DESC');
const selectOne = db.prepare('SELECT * FROM clients WHERE id = ?');
const updatePaid = db.prepare('UPDATE clients SET lastPaidDate = ? WHERE id = ?');
const approveClient = db.prepare(`UPDATE clients SET approvalStatus = 'active', joinDate = ?, lastPaidDate = ? WHERE id = ? AND approvalStatus = 'pending'`);
const deleteOne = db.prepare('DELETE FROM clients WHERE id = ?');

function serialize(row) {
  if (row.approvalStatus === 'pending') {
    return { ...row, clientId: displayId(row.id), dueDate: null, status: 'pending', daysLeft: null };
  }
  const { dueDate, status, daysLeft } = feeInfo(row);
  return { ...row, clientId: displayId(row.id), dueDate, status, daysLeft };
}

/* ---- Validation -------------------------------------------------- */
const phoneRe = /^[0-9+\s]{10,15}$/;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateAdmission(b) {
  const e = {};
  if (!b.name || b.name.trim().length < 3) e.name = 'Enter full name (at least 3 characters).';
  if (!b.fatherName || b.fatherName.trim().length < 3) e.fatherName = "Enter father's name.";
  if (!b.phone || !phoneRe.test(String(b.phone).trim())) e.phone = 'Enter a valid phone number.';
  if (b.email && b.email.trim() !== '' && !emailRe.test(b.email.trim())) e.email = 'Enter a valid email address.';
  if (!['Male', 'Female', 'Other'].includes(b.gender)) e.gender = 'Select a gender.';
  if (!b.dob) e.dob = 'Select date of birth.';
  if (!PLANS[b.plan]) e.plan = 'Select a valid fee plan.';
  if (!b.address || b.address.trim().length < 5) e.address = 'Enter an address.';
  if (!b.emergencyContact || b.emergencyContact.trim().length < 5) e.emergencyContact = 'Enter an emergency contact.';
  return e;
}
const S = (v) => (v == null ? '' : String(v).trim());

/* ---- Auth (signed cookie, no external deps) ---------------------- */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
function currentUser(req) {
  return verifyToken(getCookie(req, 'gym_session'));
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  req.user = user.u;
  next();
}

/* ---- Simple in-memory rate limiter (no external deps) ------------
   Protects login (brute force) and public admission form (spam).
   Keyed by IP + route. Good enough for a single-instance small app;
   swap for a proper store (Redis) if you ever run multiple instances. */
function makeRateLimiter({ windowMs, max, message }) {
  const hits = new Map(); // key -> { count, resetAt }
  setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (v.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
const loginLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                  // 10 attempts per IP per window
  message: 'Too many login attempts. Please try again in a few minutes.',
});
const admissionLimiter = makeRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,                  // 30 submissions per IP per hour
  message: 'Too many submissions from this device. Please try again later.',
});

/* ===================================================================
   APP
   =================================================================== */
const app = express();
app.disable('x-powered-by');

// Trust the first proxy hop (needed for correct req.ip / req.secure
// behind a reverse proxy in production, e.g. nginx, Render, Railway).
if (NODE_ENV === 'production') app.set('trust proxy', 1);

/* ---- Basic security headers (no extra dependency) ---- */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json());

/* ---- Auth routes ---- */
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const ok =
    typeof username === 'string' && typeof password === 'string' &&
    safeEqual(username, STAFF_USER) && safeEqual(password, STAFF_PASSWORD);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });

  const token = signToken({ u: STAFF_USER, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  res.cookie('gym_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_HOURS * 3600 * 1000,
    secure: NODE_ENV === 'production', // requires HTTPS in production
  });
  res.json({ ok: true, username: STAFF_USER });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('gym_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  res.json({ authenticated: !!user, username: user ? user.u : null });
});

/* ---- Public: submit an admission (goes in as "pending" until staff
   approves it — usually once the client has actually paid in person) ---- */
app.post('/api/clients', admissionLimiter, (req, res) => {
  const b = req.body || {};
  const errors = validateAdmission(b);
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const today = todayStr();
  const info = insertClient.run(
    S(b.name), S(b.fatherName), S(b.phone), S(b.email), S(b.cnic),
    b.gender, S(b.dob), S(b.address), S(b.emergencyContact),
    b.plan, PLANS[b.plan], today, today, new Date().toISOString(), 'pending'
  );
  res.status(201).json({ id: displayId(Number(info.lastInsertRowid)) });
});

/* ---- Staff: quick add (minimal fields, added directly as active) ---- */
app.post('/api/clients/quick', requireAuth, (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!b.name || b.name.trim().length < 3) errors.name = 'Enter full name (at least 3 characters).';
  if (!b.phone || !phoneRe.test(String(b.phone).trim())) errors.phone = 'Enter a valid phone number.';
  if (!PLANS[b.plan]) errors.plan = 'Select a valid fee plan.';
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const today = todayStr();
  const info = insertClient.run(
    S(b.name), '', S(b.phone), '', '', '', '', '', '',
    b.plan, PLANS[b.plan], today, today, new Date().toISOString(), 'active'
  );
  res.status(201).json({ id: displayId(Number(info.lastInsertRowid)) });
});

/* ---- Staff: list all clients (with computed status) ---- */
app.get('/api/clients', requireAuth, (req, res) => {
  res.json(selectAll.all().map(serialize));
});

/* ---- Staff: approve a pending admission ----
   Confirms the client actually showed up and paid; starts their real
   fee cycle from today (join date + last paid date both reset to today). */
app.post('/api/clients/:id/approve', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = selectOne.get(id);
  if (!row) return res.status(404).json({ error: 'Client not found.' });
  if (row.approvalStatus !== 'pending') return res.status(400).json({ error: 'This client is not pending approval.' });

  const today = todayStr();
  approveClient.run(today, today, id);
  res.json(serialize(selectOne.get(id)));
});

/* ---- Staff: reject a pending admission (removes the request) ---- */
app.post('/api/clients/:id/reject', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = selectOne.get(id);
  if (!row) return res.status(404).json({ error: 'Client not found.' });
  if (row.approvalStatus !== 'pending') return res.status(400).json({ error: 'This client is not pending approval.' });

  deleteOne.run(id);
  res.json({ ok: true });
});

/* ---- Staff: mark a fee as paid ---- */
app.post('/api/clients/:id/pay', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = selectOne.get(id);
  if (!row) return res.status(404).json({ error: 'Client not found.' });
  if (row.approvalStatus === 'pending') return res.status(400).json({ error: 'Approve this admission before marking fees as paid.' });

  // If paying on/before the due date, extend from the due date so no paid
  // days are lost; if already overdue, start a fresh cycle from today.
  const dueDate = addDays(row.lastPaidDate, planCycleDays(row.plan));
  const newLastPaid = daysBetween(todayStr(), dueDate) >= 0 ? dueDate : todayStr();
  updatePaid.run(newLastPaid, id);
  res.json(serialize(selectOne.get(id)));
});

/* ---- Staff: delete a client ---- */
app.delete('/api/clients/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const info = deleteOne.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Client not found.' });
  res.json({ ok: true });
});

/* ---- Static site (served last; only /public is exposed) ---- */
app.use(express.static(path.join(__dirname, 'public')));

/* ---- JSON body parse errors should not leak stack traces ---- */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

/* ---- Start ---- */
app.listen(PORT, () => {
  console.log(`\n  IronPeak Gym running   http://localhost:${PORT}`);
  console.log(`  Staff dashboard        http://localhost:${PORT}/admin.html`);
  console.log(`  .env file loaded       ${envLoaded ? 'yes (' + envPath + ')' : 'NO — using built-in defaults'}`);
  console.log(`  Login (use exactly this): ${STAFF_USER} / ${STAFF_PASSWORD}\n`);
  if (STAFF_PASSWORD === 'ironpeak@2026') {
    console.warn('  [warn] You are using the DEFAULT staff password. Set STAFF_PASSWORD in .env before going live.\n');
  }
});
