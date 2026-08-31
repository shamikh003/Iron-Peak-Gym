'use strict';

/* ===================================================================
   IRONPEAK GYM backend server (TURSO CLOUD DB VERSION)
   =================================================================== */

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { createClient } = require('@libsql/client');

/* ---- Config (from .env if present, else defaults) ---------------- */
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env, use defaults */ }

const PORT = Number(process.env.PORT) || 3000;
const STAFF_USER = process.env.STAFF_USER || 'admin';
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'ironpeak@2026';
let SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] SESSION_SECRET not set using a random one. Staff will be logged out on restart.');
}
const SESSION_HOURS = 12;

const DB_URL = process.env.DB_URL;
const DB_TOKEN = process.env.DB_TOKEN;

if (!DB_URL || !DB_TOKEN) {
  console.error("ERROR: Missing DB_URL or DB_TOKEN in .env file.");
  process.exit(1);
}

/* ---- Plans (server is the source of truth for prices) ------------ */
const PLANS = { Monthly: 3500, Quarterly: 9500, Annual: 32000 };
function planCycleDays(plan) {
  if (plan === 'Quarterly') return 90;
  if (plan === 'Annual') return 365;
  return 30; // Monthly
}

/* ---- Date helpers ------------------------------------------------ */
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

/* ---- Database (Turso Client) ------------------------------------- */
const db = createClient({
  url: DB_URL,
  authToken: DB_TOKEN,
});

db.execute(`
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
    createdAt         TEXT NOT NULL
  );
`).catch(console.error);

function serialize(row) {
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

/* ---- Auth -------------------------------------------------------- */
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

/* ===================================================================
   APP
   =================================================================== */
const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Added to fix potential login body issues

/* ---- Auth routes ---- */
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const ok =
    typeof username === 'string' && typeof password === 'string' &&
    safeEqual(username, STAFF_USER) && safeEqual(password, STAFF_PASSWORD);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });

  const token = signToken({ u: STAFF_USER, exp: Date.now() + SESSION_HOURS * 3600 * 1000 });
  res.cookie('gym_session', token, {
    httpOnly: true, sameSite: 'strict', path: '/', maxAge: SESSION_HOURS * 3600 * 1000,
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

/* ---- Public: submit an admission ---- */
app.post('/api/clients', async (req, res) => {
  const b = req.body || {};
  const errors = validateAdmission(b);
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const today = todayStr();
  try {
    const info = await db.execute({
      sql: `INSERT INTO clients
        (name, fatherName, phone, email, cnic, gender, dob, address, emergencyContact, plan, planPrice, joinDate, lastPaidDate, createdAt)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        S(b.name), S(b.fatherName), S(b.phone), S(b.email), S(b.cnic),
        b.gender, S(b.dob), S(b.address), S(b.emergencyContact),
        b.plan, PLANS[b.plan], today, today, new Date().toISOString()
      ]
    });
    res.status(201).json({ id: displayId(Number(info.lastInsertRowid)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ---- Staff: quick add ---- */
app.post('/api/clients/quick', requireAuth, async (req, res) => {
  const b = req.body || {};
  const errors = {};
  if (!b.name || b.name.trim().length < 3) errors.name = 'Enter full name (at least 3 characters).';
  if (!b.phone || !phoneRe.test(String(b.phone).trim())) errors.phone = 'Enter a valid phone number.';
  if (!PLANS[b.plan]) errors.plan = 'Select a valid fee plan.';
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const today = todayStr();
  try {
    const info = await db.execute({
      sql: `INSERT INTO clients
        (name, fatherName, phone, email, cnic, gender, dob, address, emergencyContact, plan, planPrice, joinDate, lastPaidDate, createdAt)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        S(b.name), '', S(b.phone), '', '', '', '', '', '',
        b.plan, PLANS[b.plan], today, today, new Date().toISOString()
      ]
    });
    res.status(201).json({ id: displayId(Number(info.lastInsertRowid)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ---- Staff: list all clients ---- */
app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM clients ORDER BY id DESC');
    res.json(result.rows.map(serialize));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ---- Staff: mark a fee as paid ---- */
app.post('/api/clients/:id/pay', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const result = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [id] });
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Client not found.' });

    const dueDate = addDays(row.lastPaidDate, planCycleDays(row.plan));
    const newLastPaid = daysBetween(todayStr(), dueDate) >= 0 ? dueDate : todayStr();
    
    await db.execute({ sql: 'UPDATE clients SET lastPaidDate = ? WHERE id = ?', args: [newLastPaid, id] });
    
    const updated = await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [id] });
    res.json(serialize(updated.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ---- Staff: delete a client ---- */
app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const info = await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [id] });
    if (info.rowsAffected === 0) return res.status(404).json({ error: 'Client not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

/* ---- Static site ---- */
app.use(express.static(path.join(__dirname, 'public')));

/* ---- Start ---- */
app.listen(PORT, () => {
  console.log(`\n  IronPeak Gym running   http://localhost:${PORT}`);
  console.log(`  Staff dashboard        http://localhost:${PORT}/admin.html`);
  console.log(`  Login: ${STAFF_USER} / ${STAFF_PASSWORD}\n`);
});