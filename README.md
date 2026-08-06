# MARCA GROUP

A full-stack HRIS: employee records, departments, leave management, attendance,
payroll, performance reviews, an HR task board (Trello-style), and liquidation/expense
reports, with role-based access (admin / hr / employee).

- **Backend**: Node.js + Express + SQLite (`node:sqlite`, built into Node — no native build tools needed), JWT auth
- **Frontend**: React (Vite) + React Router

## 1. Install Node.js

This machine doesn't have Node.js installed yet. Download and install the LTS
version from https://nodejs.org (v22.5 or later — needed for the built-in `node:sqlite` module), then confirm it works:

```bash
node -v
npm -v
```

## 2. Install dependencies

From the `hr-app` folder, install both the backend and frontend packages:

```bash
cd backend
npm install
cd ../frontend
npm install
```

## 3. Configure the backend

```bash
cd backend
copy .env.example .env
```

Edit `.env` and set `JWT_SECRET` to a long random string (used to sign login tokens).

## 4. Seed the database

This creates `backend/data/hr.db` (SQLite file) with sample departments,
employees, leave/attendance/payroll/performance data, and login accounts:

```bash
cd backend
npm run seed
```

Sample logins created by the seed script:

| Role     | Email                        | Password      |
|----------|-------------------------------|---------------|
| Admin    | admin@example.com             | admin123      |
| HR       | hr@example.com                | hr123         |
| Employee | jamie.chen@example.com        | employee123   |
| Employee | morgan.lee@example.com        | employee123   |

## 5. Run the app

Open two terminals:

```bash
# Terminal 1 — backend (http://localhost:4000)
cd backend
npm run dev
```

```bash
# Terminal 2 — frontend (http://localhost:5173)
cd frontend
npm run dev
```

Visit http://localhost:5173 and log in with one of the sample accounts above.
The frontend dev server proxies `/api` requests to the backend, so no extra
configuration is needed.

## GPS attendance

When an employee clocks in or out, the app asks the browser for their location
(they'll see the standard browser permission prompt) and stores the coordinates
and GPS accuracy with the attendance record. HR/admin see a 📍 map link per punch
on the Attendance page.

**Locations** (admin/hr, under the "Locations" nav item) are named office sites —
each with coordinates and a radius — that employees get assigned to from their
profile page. When an employee has an assigned location, clock-in/out is
**enforced**, not just recorded: the request is rejected with a clear error if
they're outside that site's radius, or if location access wasn't granted at all.
Employees with no assigned location aren't geofenced — their punch is just
recorded with coordinates (if available) and no restriction.

- A single fallback office can also be set globally via `OFFICE_LAT` / `OFFICE_LNG`
  (and optional `OFFICE_RADIUS_METERS`, default 1000) in `backend/.env` — used only
  for employees who don't have a specific location assigned. Useful for a
  single-site company that doesn't need the Locations page at all.
- Browser geolocation requires HTTPS (or localhost), so this works on the
  deployed site and in local dev, but not over plain http on a LAN IP.

## Email notifications

The backend sends email notifications for:

- **Leave requests** — HR/admin get an email when one is submitted; the employee gets one when it's approved/rejected.
- **Expense/liquidation reports** — HR/admin get an email when one is submitted; the employee gets one when it's approved/rejected/reimbursed.
- **Task board cards** — the assigned employee gets an email when a card is assigned to them.
- **Performance reviews** — the employee gets an email when a review is submitted for their acknowledgement.

This is off by default: if `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` in `.env` are blank, emails are
skipped and just logged to the backend console — nothing breaks. To send real emails, fill in
those variables. For **Gmail**:

1. Turn on 2-Step Verification on the Google account: https://myaccount.google.com/security
2. Create an **App Password**: https://myaccount.google.com/apppasswords (choose "Mail" as the app).
   Google gives you a 16-character password — this is what goes in `SMTP_PASS`, *not* the account's
   regular login password.
3. In `backend/.env`, set:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=youraddress@gmail.com
   SMTP_PASS=the 16-character app password
   SMTP_FROM=youraddress@gmail.com
   ```
4. Restart the backend (`npm run dev`).

Any other SMTP provider works the same way — just set `SMTP_HOST`/`SMTP_PORT` to that provider's values.

"HR/admin" recipients are looked up dynamically from every `users` row with role `admin` or `hr`
(the accounts created via the Users page), so no extra config is needed for that part.

## Deploying (Vercel + Render)

The frontend is a static build, but the backend keeps its data in a local SQLite file —
that needs a host with a persistent, always-running process, not a serverless platform
like Vercel functions (their filesystem is wiped between invocations). The split that works:

- **Frontend → Vercel** (static hosting)
- **Backend → Render** (or Railway/Fly.io — anywhere with a long-running Node process)

### Backend on Render

1. Sign in at https://render.com and connect this GitHub repo.
2. Create a new **Web Service**, or use **Blueprint** and point it at this repo's
   `render.yaml` (already included at the repo root) to have Render configure it automatically.
3. If configuring manually: root directory `backend`, build command `npm install`,
   start command `npm start`.
4. Set environment variables in the Render dashboard: `JWT_SECRET` (a long random string),
   and optionally `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM` for email notifications.
5. After it deploys, run the seed script once from Render's **Shell** tab: `npm run seed`.
6. Copy the service's URL (e.g. `https://marca-hr-backend.onrender.com`).

**Free-tier caveat**: Render's free web services don't include a persistent disk — the
SQLite file survives while the service stays up, but resets on redeploy, and free
services spin down after 15 minutes of inactivity and lose data on the next wake-up.
Fine for testing; for anything real, add Render's paid persistent disk add-on or move
to a hosted database.

### Frontend on Vercel

1. In the Vercel project's settings, add an environment variable `VITE_API_URL` set to
   the Render backend URL from above (no trailing slash).
2. Redeploy — Vite bakes env vars in at build time, so a redeploy is required after
   changing `VITE_API_URL`.

The frontend already includes a `vercel.json` rewrite so client-side routes (e.g.
`/employees`) don't 404 on refresh, and `frontend/src/api/client.js` reads `VITE_API_URL`
to know where to send API requests (falling back to same-origin, for local dev where
Vite's proxy handles it instead).

## Roles

- **admin** — full access, including managing user login accounts and roles
- **hr** — manage employees, departments, leave approvals, payroll, and performance reviews
- **employee** — view/edit own profile contact info, request leave, clock in/out, view own payslips and reviews

## Project structure

```
hr-app/
  backend/
    src/
      server.js          Express app entry point
      db.js               SQLite schema + connection
      seed.js             Sample data seeding script
      middleware/auth.js  JWT auth + role-check middleware
      routes/              One file per resource (employees, leave, payroll, ...)
    data/hr.db            SQLite database file (created after seeding)
  frontend/
    src/
      pages/               One page per feature area
      components/          Layout, route guards
      context/AuthContext  Login state, current user/employee
      api/client.js        Small fetch wrapper that attaches the JWT
```

## Resetting sample data

Re-running `npm run seed` in `backend/` wipes and re-creates all tables with
fresh sample data — useful if you want to start over.
