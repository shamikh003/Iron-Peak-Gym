# IronPeak Gym

Gym website with an online admission form and a staff dashboard for managing
members and fee reminders. Data is stored server-side in SQLite, so every
submission is visible to staff from any device on the same server.

## Requirements

- Node.js **22 or newer** (uses the built-in `node:sqlite` module — no native build step)

## Setup

```bash
npm install
cp .env.example .env      # then edit .env and change the staff password
npm start
```

Then open **http://localhost:3000** in your browser.

> Important: open the site through `http://localhost:3000`, **not** by
> double-clicking the HTML files. The pages talk to the backend API, which
> only works when served by the server.

- Public site: <http://localhost:3000>
- Staff dashboard: <http://localhost:3000/admin.html>

## Configuration (`.env`)

| Variable         | Default          | Purpose                                             |
| ---------------- | ---------------- | --------------------------------------------------- |
| `PORT`           | `3000`           | Port the server listens on                          |
| `STAFF_USER`     | `admin`          | Staff dashboard username                            |
| `STAFF_PASSWORD` | `ironpeak@2026`  | Staff dashboard password — **change this**          |
| `SESSION_SECRET` | *(random)*       | Signs login sessions; set a long random string      |

If `SESSION_SECRET` is left empty, a new random one is generated on every
start, which logs staff out whenever the server restarts. Set it in `.env`
to keep sessions across restarts.

## Data

- All records live in `data/gym.db` (SQLite). Back up this file to back up
  your members.
- The `data/` folder and `.env` are git-ignored and are never served to the
  browser (only the `public/` folder is exposed).

## Project structure

```
GYM/
├── public/            # front-end served to the browser
│   ├── index.html     #   public site + admission form
│   ├── admin.html     #   staff dashboard (login-gated)
│   ├── style.css
│   ├── script.js      #   admission form → POST /api/clients
│   └── admin.js       #   dashboard → /api/clients, /api/auth/*
├── server.js          # Express + SQLite backend
├── package.json
├── .env.example
└── data/gym.db        # created on first run
```

## API overview

| Method + path              | Auth  | Purpose                          |
| -------------------------- | ----- | -------------------------------- |
| `POST /api/clients`        | no    | Submit an admission              |
| `POST /api/auth/login`     | no    | Staff login (sets session cookie)|
| `POST /api/auth/logout`    | no    | Staff logout                     |
| `GET  /api/auth/me`        | no    | Check current session            |
| `GET  /api/clients`        | staff | List all clients + fee status    |
| `POST /api/clients/quick`  | staff | Quick-add a client               |
| `POST /api/clients/:id/pay`| staff | Mark this month's fee as paid    |
| `DELETE /api/clients/:id`  | staff | Remove a client                  |

## Notes for production

- Put the app behind HTTPS (e.g. a reverse proxy) and add the `Secure` flag to
  the session cookie.
- Change `STAFF_USER`, `STAFF_PASSWORD` and set a fixed `SESSION_SECRET`.
